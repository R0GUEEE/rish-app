import type {
  AttachWorkspaceProjectRequestV1,
  AttachWorkspaceProjectResultV1,
  LocalProjectDescriptorV2,
  ProjectForWorkspaceResultV1,
} from '../native/LocalProjects';
import type {
  WorkspaceDescriptorV2,
  WorkspaceResolveRequestV1,
  WorkspaceResolveResultV1,
} from '../native/LocalWorkspaces';
import { assertWorkspaceRootRefV1, type WorkspaceRootRefV1 } from '../native/WorkspaceRoot';

export type WorkspaceGitActivationResult =
  | { status: 'attached'; project: LocalProjectDescriptorV2; workspace: WorkspaceDescriptorV2 }
  | { status: 'blocked' | 'stale' | 'failed'; code: string };

type Dependencies = {
  resolve(request: WorkspaceResolveRequestV1): Promise<WorkspaceResolveResultV1>;
  projectForWorkspace(root: WorkspaceRootRefV1): Promise<ProjectForWorkspaceResultV1>;
  attach(request: AttachWorkspaceProjectRequestV1): Promise<AttachWorkspaceProjectResultV1>;
  createOperationId(): string;
};

export function workspaceGitActivationError(error: unknown): string {
  try {
    const descriptor = typeof error === 'object' && error !== null
      ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    const code = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    return typeof code === 'string' && /^E_[A-Z0-9_]{1,64}$/u.test(code)
      ? code : 'E_PROJECT_NATIVE';
  } catch {
    return 'E_PROJECT_NATIVE';
  }
}

/** Explicit user actions only. This owns native attach retries, never chat state. */
export function createWorkspaceGitActivation(dependencies: Dependencies) {
  const pending = new Map<string, AttachWorkspaceProjectRequestV1>();
  let active = false;
  return {
    async activate(
      input: WorkspaceRootRefV1,
      isCurrent: () => boolean,
      beforeAttach: () => Promise<boolean>,
    ): Promise<WorkspaceGitActivationResult> {
      if (active) return { status: 'blocked', code: 'E_WORKSPACE_BUSY' };
      active = true;
      try {
        const root = assertWorkspaceRootRefV1(input);
        if (root.project_id !== null) return { status: 'blocked', code: 'E_WORKSPACE_CONFLICT' };
        if (!isCurrent()) return { status: 'stale', code: 'E_WORKSPACE_CONFLICT' };
        if (!(await beforeAttach())) return { status: 'blocked', code: 'E_WORKSPACE_BUSY' };
        if (!isCurrent()) return { status: 'stale', code: 'E_WORKSPACE_CONFLICT' };
        const resolved = await dependencies.resolve({
          schema_version: 1,
          workspace_id: root.workspace_id,
          expected_binding_revision: root.binding_revision,
          required_capabilities: ['read', 'write', 'git', 'project_context'],
        });
        if (!isCurrent()) return { status: 'stale', code: 'E_WORKSPACE_CONFLICT' };
        const workspace = resolved.workspace;
        if (
          resolved.disposition !== 'direct' || workspace.status !== 'ok' ||
          workspace.workspace_id !== root.workspace_id ||
          workspace.binding_revision !== root.binding_revision ||
          !workspace.capabilities.read || !workspace.capabilities.write ||
          !workspace.capabilities.git || !workspace.capabilities.project_context
        ) return { status: 'blocked', code: 'E_WORKSPACE_CAPABILITY' };

        // An earlier attach may have committed even if its response or the
        // later chat binding was lost. Discover that mapping before init.
        const existing = await dependencies.projectForWorkspace(root);
        if (!isCurrent()) return { status: 'stale', code: 'E_WORKSPACE_CONFLICT' };
        const key = `${root.workspace_id}:${root.binding_revision}`;
        let project: LocalProjectDescriptorV2;
        if (existing.status === 'attached') {
          project = existing.project;
        } else {
          let request = pending.get(key);
          if (request === undefined) {
            if (pending.size >= 32) return { status: 'blocked', code: 'E_WORKSPACE_BUSY' };
            request = {
              schema_version: 1, operation_id: dependencies.createOperationId(),
              root, mode: 'init',
            };
            pending.set(key, request);
          }
          const result = await dependencies.attach(request);
          project = result.project;
        }
        if (
          project.workspace_id !== root.workspace_id ||
          project.workspace_binding_revision !== root.binding_revision
        ) return { status: 'failed', code: 'E_PROJECT_RESULT_INVALID' };
        pending.delete(key);
        if (!isCurrent()) return { status: 'stale', code: 'E_WORKSPACE_CONFLICT' };
        return { status: 'attached', project, workspace };
      } catch (error) {
        return { status: 'failed', code: workspaceGitActivationError(error) };
      } finally {
        active = false;
      }
    },
  };
}

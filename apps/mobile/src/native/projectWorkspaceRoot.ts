import { LocalProjects } from './LocalProjects';
import { LocalRuntime } from './LocalRuntime';
import { LocalWorkspaces, type WorkspaceDescriptorV2 } from './LocalWorkspaces';
import {
  assertWorkspaceRootRefV1,
  type WorkspaceRootRefV1,
} from './WorkspaceRoot';

// Files needs a workspace root too, even before the project's first chat.
// Native bootstrap verifies the legacy repository and records its authority;
// this adapter never invents a root or changes a conversation binding.
export function createProjectWorkspaceRootResolver() {
  const inFlight = new Map<string, Promise<WorkspaceRootRefV1 | null>>();
  const bootstrapIds = new Map<string, string>();

  const verify = async (
    candidate: WorkspaceDescriptorV2,
    projectId: string,
  ) => {
    if (candidate.status !== 'ok' || !candidate.capabilities.read) return null;
    const resolved = await LocalWorkspaces.resolve({
      schema_version: 1,
      workspace_id: candidate.workspace_id,
      expected_binding_revision: candidate.binding_revision,
      required_capabilities: ['read'],
    });
    if (
      resolved.disposition !== 'direct' ||
      resolved.workspace.status !== 'ok' ||
      !resolved.workspace.capabilities.read ||
      resolved.workspace.workspace_id !== candidate.workspace_id ||
      resolved.workspace.binding_revision !== candidate.binding_revision
    )
      return null;
    const root = assertWorkspaceRootRefV1({
      schema_version: 1,
      workspace_id: candidate.workspace_id,
      binding_revision: candidate.binding_revision,
      project_id: null,
    });
    const lookup = await LocalProjects.projectForWorkspaceV2(root);
    if (
      lookup.status !== 'attached' ||
      lookup.project.project_id !== projectId ||
      lookup.project.workspace_id !== root.workspace_id ||
      lookup.project.workspace_binding_revision !== root.binding_revision
    )
      return null;
    return assertWorkspaceRootRefV1({ ...root, project_id: projectId });
  };

  const findExisting = async (projectId: string) => {
    const listing = await LocalWorkspaces.list();
    for (const candidate of [...listing.workspaces].sort((a, b) =>
      a.workspace_id.localeCompare(b.workspace_id),
    )) {
      const root = await verify(candidate, projectId);
      if (root !== null) return root;
    }
    return null;
  };

  const resolve = async (projectId: string) => {
    const existing = await findExisting(projectId);
    if (existing !== null) return existing;
    let operationId = bootstrapIds.get(projectId);
    if (operationId === undefined) {
      operationId = LocalRuntime.createCompletionRequestId();
      bootstrapIds.set(projectId, operationId);
    }
    let workspace: WorkspaceDescriptorV2;
    try {
      workspace = await LocalWorkspaces.bootstrapLegacyProject({
        schema_version: 1,
        operation_id: operationId,
        project_id: projectId,
      });
    } catch (error) {
      // Another opener may have registered this project. Reuse only a fully
      // verified result; a revoked/changed existing root still fails closed.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'E_WORKSPACE_CONFLICT'
      ) {
        const concurrent = await findExisting(projectId);
        if (concurrent !== null) return concurrent;
      }
      throw error;
    }
    return verify(workspace, projectId);
  };

  return (projectId: string): Promise<WorkspaceRootRefV1 | null> => {
    const pending = inFlight.get(projectId);
    if (pending !== undefined) return pending;
    const request = resolve(projectId).finally(() =>
      inFlight.delete(projectId),
    );
    inFlight.set(projectId, request);
    return request;
  };
}

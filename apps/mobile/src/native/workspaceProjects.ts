import { LocalProjects } from './LocalProjects';
import { LocalWorkspaces } from './LocalWorkspaces';
import { assertWorkspaceRootRefV1, type WorkspaceRootRefV1 } from './WorkspaceRoot';

/**
 * A project attached to a workspace, as the Projects surface lists it: the
 * V2 descriptor plus the root every V2 Git call takes. The legacy listing
 * (`LocalProjects.list`) knows nothing of these -- on Android it does not
 * exist at all -- so the surface asks the workspaces instead.
 */
export type WorkspaceProject = {
  readonly projectId: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly root: WorkspaceRootRefV1;
  readonly createdAt: string;
  readonly lastOpenedAt: string;
};

/**
 * Every workspace this build can read that has a project attached. A
 * workspace that fails to answer is skipped rather than failing the listing:
 * one moved folder must not hide the others.
 */
export async function listWorkspaceProjects(): Promise<readonly WorkspaceProject[]> {
  if (!LocalProjects.isV2Available()) return [];
  const listing = await LocalWorkspaces.list();
  const rows: WorkspaceProject[] = [];
  for (const workspace of listing.workspaces) {
    if (workspace.status !== 'ok' || !workspace.capabilities.read) continue;
    let root: WorkspaceRootRefV1;
    try {
      root = assertWorkspaceRootRefV1({
        schema_version: 1,
        workspace_id: workspace.workspace_id,
        binding_revision: workspace.binding_revision,
        project_id: null,
      });
    } catch {
      continue;
    }
    try {
      const lookup = await LocalProjects.projectForWorkspaceV2(root);
      if (
        lookup.status !== 'attached' ||
        lookup.project.workspace_id !== root.workspace_id ||
        lookup.project.workspace_binding_revision !== root.binding_revision
      ) {
        continue;
      }
      rows.push({
        projectId: lookup.project.project_id,
        name: lookup.project.display_name,
        workspaceId: workspace.workspace_id,
        workspaceName: workspace.display_name,
        root: assertWorkspaceRootRefV1({ ...root, project_id: lookup.project.project_id }),
        createdAt: workspace.created_at,
        lastOpenedAt: workspace.last_opened_at,
      });
    } catch {
      continue;
    }
  }
  return rows;
}

/** The display name of a workspace-attached project, or null when none has this id. */
export async function workspaceProjectName(projectId: string): Promise<string | null> {
  const rows = await listWorkspaceProjects();
  return rows.find(row => row.projectId === projectId)?.name ?? null;
}

import { createProjectWorkspaceRootResolver } from '../src/native/projectWorkspaceRoot';
import { LocalProjects } from '../src/native/LocalProjects';
import {
  LocalWorkspaces,
  type WorkspaceDescriptorV2,
} from '../src/native/LocalWorkspaces';
import { LocalRuntime } from '../src/native/LocalRuntime';

jest.mock('../src/native/LocalProjects', () => ({
  LocalProjects: { projectForWorkspaceV2: jest.fn() },
}));
jest.mock('../src/native/LocalWorkspaces', () => ({
  LocalWorkspaces: {
    list: jest.fn(),
    resolve: jest.fn(),
    bootstrapLegacyProject: jest.fn(),
  },
}));
jest.mock('../src/native/LocalRuntime', () => ({
  LocalRuntime: { createCompletionRequestId: jest.fn() },
}));

const projectId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const workspace = {
  workspace_id: workspaceId,
  binding_revision: 1,
  status: 'ok',
  capabilities: { read: true },
} as WorkspaceDescriptorV2;
const root = {
  schema_version: 1,
  workspace_id: workspaceId,
  binding_revision: 1,
  project_id: projectId,
};
const workspaces = jest.mocked(LocalWorkspaces);
const projects = jest.mocked(LocalProjects);
const runtime = jest.mocked(LocalRuntime);

beforeEach(() => {
  jest.resetAllMocks();
  runtime.createCompletionRequestId.mockReturnValue(operationId);
  workspaces.list.mockResolvedValue({ schema_version: 1, workspaces: [] });
  workspaces.bootstrapLegacyProject.mockResolvedValue(workspace);
  workspaces.resolve.mockResolvedValue({
    schema_version: 1,
    disposition: 'direct',
    workspace,
  } as Awaited<ReturnType<typeof LocalWorkspaces.resolve>>);
  projects.projectForWorkspaceV2.mockResolvedValue({
    schema_version: 1,
    status: 'attached',
    project: {
      schema_version: 2,
      project_id: projectId,
      workspace_id: workspaceId,
      workspace_binding_revision: 1,
      display_name: 'Fixture',
      git_topology: 'legacy_embedded',
    },
  });
});

test('registers a fresh create/clone before opening its verified Files root', async () => {
  expect(await createProjectWorkspaceRootResolver()(projectId)).toEqual(root);
  expect(workspaces.bootstrapLegacyProject).toHaveBeenCalledWith({
    schema_version: 1,
    project_id: projectId,
    operation_id: operationId,
  });
  expect(workspaces.resolve).toHaveBeenCalledWith({
    schema_version: 1,
    workspace_id: workspaceId,
    expected_binding_revision: 1,
    required_capabilities: ['read'],
  });
  expect(projects.projectForWorkspaceV2).toHaveBeenCalledWith({
    ...root,
    project_id: null,
  });
});

test('reuses an existing root without attempting duplicate bootstrap', async () => {
  workspaces.list.mockResolvedValue({
    schema_version: 1,
    workspaces: [workspace],
  });
  expect(await createProjectWorkspaceRootResolver()(projectId)).toEqual(root);
  expect(workspaces.bootstrapLegacyProject).not.toHaveBeenCalled();
});

test('coalesces concurrent opens of the same project', async () => {
  const resolve = createProjectWorkspaceRootResolver();
  const first = resolve(projectId);
  const second = resolve(projectId);
  expect(first).toBe(second);
  expect(await first).toEqual(root);
  expect(workspaces.bootstrapLegacyProject).toHaveBeenCalledTimes(1);
});

test('retries an uncertain native bootstrap using the same operation identity', async () => {
  const resolve = createProjectWorkspaceRootResolver();
  workspaces.bootstrapLegacyProject.mockRejectedValueOnce({
    code: 'E_WORKSPACE_PERSISTENCE',
  });
  await expect(resolve(projectId)).rejects.toMatchObject({
    code: 'E_WORKSPACE_PERSISTENCE',
  });
  expect(await resolve(projectId)).toEqual(root);
  expect(runtime.createCompletionRequestId).toHaveBeenCalledTimes(1);
  expect(
    workspaces.bootstrapLegacyProject.mock.calls.map(
      ([request]) => request.operation_id,
    ),
  ).toEqual([operationId, operationId]);
});

test('resolves a concurrently registered root after a native conflict', async () => {
  workspaces.list
    .mockResolvedValueOnce({ schema_version: 1, workspaces: [] })
    .mockResolvedValueOnce({ schema_version: 1, workspaces: [workspace] });
  workspaces.bootstrapLegacyProject.mockRejectedValueOnce({
    code: 'E_WORKSPACE_CONFLICT',
  });
  expect(await createProjectWorkspaceRootResolver()(projectId)).toEqual(root);
});

test('does not turn an unresolved conflict into a replacement grant', async () => {
  workspaces.bootstrapLegacyProject.mockRejectedValueOnce({
    code: 'E_WORKSPACE_CONFLICT',
  });
  await expect(
    createProjectWorkspaceRootResolver()(projectId),
  ).rejects.toMatchObject({ code: 'E_WORKSPACE_CONFLICT' });
  expect(workspaces.bootstrapLegacyProject).toHaveBeenCalledTimes(1);
});

test('rejects a bootstrap result attached to a different project', async () => {
  projects.projectForWorkspaceV2.mockResolvedValue({
    schema_version: 1,
    status: 'attached',
    project: {
      schema_version: 2,
      project_id: '44444444-4444-4444-8444-444444444444',
      workspace_id: workspaceId,
      workspace_binding_revision: 1,
      display_name: 'Other',
      git_topology: 'legacy_embedded',
    },
  });
  expect(await createProjectWorkspaceRootResolver()(projectId)).toBeNull();
});

test.each([{ status: 'revoked' }, { capabilities: { read: false } }])(
  'does not open an unusable bootstrap root: %j',
  async change => {
    workspaces.bootstrapLegacyProject.mockResolvedValue({
      ...workspace,
      ...change,
    } as WorkspaceDescriptorV2);
    expect(await createProjectWorkspaceRootResolver()(projectId)).toBeNull();
    expect(workspaces.resolve).not.toHaveBeenCalled();
  },
);

test('requires the resolved revision to match before querying project ownership', async () => {
  workspaces.resolve.mockResolvedValue({
    schema_version: 1,
    disposition: 'direct',
    workspace: { ...workspace, binding_revision: 2 },
  } as Awaited<ReturnType<typeof LocalWorkspaces.resolve>>);
  expect(await createProjectWorkspaceRootResolver()(projectId)).toBeNull();
  expect(projects.projectForWorkspaceV2).not.toHaveBeenCalled();
});

test('does not bootstrap when the existing registry cannot be read', async () => {
  workspaces.list.mockRejectedValue({ code: 'E_WORKSPACE_UNAVAILABLE' });
  await expect(
    createProjectWorkspaceRootResolver()(projectId),
  ).rejects.toMatchObject({ code: 'E_WORKSPACE_UNAVAILABLE' });
  expect(workspaces.bootstrapLegacyProject).not.toHaveBeenCalled();
});

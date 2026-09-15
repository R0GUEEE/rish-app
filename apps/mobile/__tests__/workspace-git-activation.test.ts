import { createWorkspaceGitActivation, workspaceGitActivationError } from '../src/workspaces/workspace-git-activation';
import type { WorkspaceDescriptorV2 } from '../src/native/LocalWorkspaces';
import type { WorkspaceRootRefV1 } from '../src/native/WorkspaceRoot';
import { createChatStore } from '../src/state';
import { WorkspaceBindingController } from '../src/workspaces/WorkspaceBindingController';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const root: WorkspaceRootRefV1 = {
  schema_version: 1, workspace_id: workspaceId, binding_revision: 1, project_id: null,
};
const workspace: WorkspaceDescriptorV2 = {
  schema_version: 2, workspace_id: workspaceId, binding_revision: 1,
  display_name: 'demo', origin: 'rish_created', status: 'ok',
  capabilities: { read: true, write: true, git: true, project_context: true, files_visible: true },
  created_at: '2026-09-15T00:00:00.000Z', last_opened_at: '2026-09-15T00:00:00.000Z',
};
const project = {
  schema_version: 2, workspace_id: workspaceId, workspace_binding_revision: 1,
  project_id: projectId, display_name: 'demo', git_topology: 'private_split_gitdir',
};

function setup() {
  const dependencies = {
    resolve: jest.fn().mockResolvedValue({ schema_version: 1, disposition: 'direct', workspace }),
    projectForWorkspace: jest.fn().mockResolvedValue({ schema_version: 1, status: 'none' }),
    attach: jest.fn().mockResolvedValue({ schema_version: 1, status: 'attached', project }),
    createOperationId: jest.fn(() => operationId),
  };
  const activate = createWorkspaceGitActivation(dependencies).activate;
  const current = jest.fn(() => true);
  const guard = jest.fn(async () => true);
  return { dependencies, activate, current, guard };
}

test('explicit activation initializes a private Git project for the exact existing workspace', async () => {
  const { dependencies, activate, current, guard } = setup();
  expect(dependencies.attach).not.toHaveBeenCalled();
  expect(await activate(root, current, guard)).toEqual({ status: 'attached', project, workspace });
  expect(dependencies.attach).toHaveBeenCalledWith({ schema_version: 1, operation_id: operationId, root, mode: 'init' });
  expect(dependencies.resolve).toHaveBeenCalledWith({
    schema_version: 1, workspace_id: workspaceId, expected_binding_revision: 1,
    required_capabilities: ['read', 'write', 'git', 'project_context'],
  });
});

test('returning to an old projectless chat uses its existing project without initializing another repository', async () => {
  const { dependencies, activate, current, guard } = setup();
  dependencies.projectForWorkspace.mockResolvedValue({ schema_version: 1, status: 'attached', project });
  expect(await activate(root, current, guard)).toMatchObject({ status: 'attached', project });
  expect(dependencies.attach).not.toHaveBeenCalled();
  expect(dependencies.createOperationId).not.toHaveBeenCalled();
});

test('a lost attach response is recovered by lookup on the next explicit action', async () => {
  const { dependencies, activate, current, guard } = setup();
  dependencies.attach.mockRejectedValueOnce({ code: 'E_PROJECT_NATIVE' });
  expect(await activate(root, current, guard)).toMatchObject({ status: 'failed' });
  dependencies.projectForWorkspace.mockResolvedValue({ schema_version: 1, status: 'attached', project });
  expect(await activate(root, current, guard)).toMatchObject({ status: 'attached' });
  expect(dependencies.attach).toHaveBeenCalledTimes(1);
});

test('an explicit retry reuses the same operation when no committed mapping is found', async () => {
  const { dependencies, activate, current, guard } = setup();
  dependencies.attach.mockRejectedValueOnce({ code: 'E_PROJECT_NATIVE' });
  await activate(root, current, guard);
  expect(dependencies.attach).toHaveBeenCalledTimes(1);
  await activate(root, current, guard);
  expect(dependencies.attach).toHaveBeenCalledTimes(2);
  expect(dependencies.attach.mock.calls[1]![0]).toBe(dependencies.attach.mock.calls[0]![0]);
  expect(dependencies.createOperationId).toHaveBeenCalledTimes(1);
});

test('opening a chat may fail after attach, and the next explicit activation still finds that project', async () => {
  const { dependencies, activate, current, guard } = setup();
  expect(await activate(root, current, guard)).toMatchObject({ status: 'attached' });
  // The caller has not committed its new conversation; native mapping is authoritative.
  dependencies.projectForWorkspace.mockResolvedValue({ schema_version: 1, status: 'attached', project });
  expect(await activate(root, current, guard)).toMatchObject({ status: 'attached', project });
  expect(dependencies.attach).toHaveBeenCalledTimes(1);
});

test('active task or context guards stop before native mutations', async () => {
  const { dependencies, activate, current, guard } = setup();
  guard.mockResolvedValue(false);
  expect(await activate(root, current, guard)).toMatchObject({ status: 'blocked' });
  expect(dependencies.resolve).not.toHaveBeenCalled();
  expect(dependencies.attach).not.toHaveBeenCalled();
});

test('capability or binding drift never initializes Git', async () => {
  const { dependencies, activate, current, guard } = setup();
  dependencies.resolve.mockResolvedValue({ disposition: 'direct', workspace: { ...workspace, binding_revision: 2 } });
  expect(await activate(root, current, guard)).toMatchObject({ status: 'blocked' });
  dependencies.resolve.mockResolvedValue({ disposition: 'direct', workspace: { ...workspace, capabilities: { ...workspace.capabilities, git: false } } });
  expect(await activate(root, current, guard)).toMatchObject({ status: 'blocked' });
  expect(dependencies.attach).not.toHaveBeenCalled();
});

test('a changed conversation before init stops, while a late completed attach is not rebound into the new owner', async () => {
  const { dependencies, activate, current, guard } = setup();
  dependencies.projectForWorkspace.mockImplementationOnce(async () => {
    current.mockReturnValue(false);
    return { schema_version: 1, status: 'none' };
  });
  expect(await activate(root, current, guard)).toMatchObject({ status: 'stale' });
  expect(dependencies.attach).not.toHaveBeenCalled();
  current.mockReturnValue(true);
  dependencies.attach.mockImplementationOnce(async () => {
    current.mockReturnValue(false);
    return { schema_version: 1, status: 'attached', project };
  });
  expect(await activate(root, current, guard)).toMatchObject({ status: 'stale' });
});

test('a second tap cannot enqueue another initialization', async () => {
  const { dependencies, activate, current, guard } = setup();
  let release!: (value: boolean) => void;
  guard.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
  const first = activate(root, current, guard);
  expect(await activate(root, current, guard)).toMatchObject({ status: 'blocked', code: 'E_WORKSPACE_BUSY' });
  release(true);
  await first;
  expect(dependencies.attach).toHaveBeenCalledTimes(1);
});

test('the existing guarded binding flow opens a new Git chat and preserves the original conversation and context consent', async () => {
  const { dependencies, activate, current, guard } = setup();
  let sequence = 0;
  const store = createChatStore({
    createId: () => `chat-${++sequence}`,
    now: () => '2026-09-15T00:00:00.000Z',
  });
  const originalId = store.createConversation();
  const binding = new WorkspaceBindingController({
    chat: store,
    workspaces: {
      list: async () => ({ schema_version: 1, workspaces: [workspace] }),
      resolve: dependencies.resolve,
      create: jest.fn(), queryOperation: jest.fn(),
    },
    projectForWorkspace: dependencies.projectForWorkspace,
    contextGuard: async () => true,
    completionGuard: async () => true,
    persistCurrent: async () => ({ status: 'committed' }),
    createOperationId: () => operationId,
  });
  expect(await binding.bindWorkspace({ conversationId: originalId, workspaceId })).toMatchObject({ status: 'committed' });
  store.appendUserMessage(originalId, 'Keep the existing demo files and this chat.');
  const original = store.getState().conversations[originalId];
  const result = await activate(root, current, guard);
  expect(result.status).toBe('attached');
  if (result.status !== 'attached') throw new Error('attach failed');
  dependencies.projectForWorkspace.mockResolvedValue({ schema_version: 1, status: 'attached', project });
  const newId = store.createConversation();
  expect(await binding.bindWorkspace({
    conversationId: newId, workspaceId, target: result.workspace,
    expectedProjectId: result.project.project_id,
    requiredCapabilities: ['read', 'write', 'git', 'project_context'],
  })).toMatchObject({ status: 'committed', root: { ...root, project_id: projectId } });
  expect(store.getState().conversations[originalId]).toBe(original);
  expect(store.getState().conversations[newId]?.workspaceBinding).toMatchObject({
    workspaceId, bindingRevision: 1, projectId,
  });
  expect(store.getState().conversations[newId]?.projectContext?.consent).toBeNull();
  expect(store.getState().conversations[newId]?.messages).toEqual([]);
});


test('error normalization never evaluates native getters or throws', () => {
  const getter = jest.fn(() => { throw new Error('private path'); });
  expect(workspaceGitActivationError(Object.defineProperty({}, 'code', { get: getter }))).toBe('E_PROJECT_NATIVE');
  expect(getter).not.toHaveBeenCalled();
});

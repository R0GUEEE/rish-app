import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, NativeModules, TurboModuleRegistry, type AppStateStatus } from 'react-native';
import { useAgentPolicy } from '../src/components/use-agent-policy';
import type { AgentPolicyRequest } from '../src/native/agent-policy';

type Inputs = Parameters<typeof useAgentPolicy>[0];
type Value = ReturnType<typeof useAgentPolicy>;
const workspaceId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const inputs: Inputs = { visible: true, workspaceId, bindingRevision: 1, projectId: null };
const descriptor = (request: AgentPolicyRequest) => ({
  ...request, root_fingerprint_sha256: 'a'.repeat(64), registry_version: 1, policy_version: 'agent-v1',
  capabilities: ['file_read'], tools: [{ name: 'read_file', access: 'auto' }],
  budget: { max_single_write_bytes: 32768, max_batch_write_bytes: 524288, max_attempt_write_bytes: 4194304 },
});
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const native = { describe: jest.fn() };
const listeners = new Set<(state: AppStateStatus) => void>();
const turboGet = jest.spyOn(TurboModuleRegistry, 'get');
const addListener = jest.spyOn(AppState, 'addEventListener');
let renderer: ReactTestRenderer | null;
let current: Value;
let renders: Value[];
function Harness(props: Inputs) {
  current = useAgentPolicy(props);
  renders.push(current);
  return null;
}
async function mount(props: Inputs = inputs) {
  await act(async () => { renderer = create(<Harness {...props} />); });
}
async function update(props: Inputs) {
  await act(async () => { renderer!.update(<Harness {...props} />); });
}
async function emit(state: AppStateStatus) {
  await act(async () => { for (const listener of listeners) listener(state); });
}
beforeEach(() => {
  renderer = null;
  renders = [];
  listeners.clear();
  native.describe.mockReset().mockImplementation(async (request: AgentPolicyRequest) => descriptor(request));
  (NativeModules as Record<string, unknown>).AgentPolicy = native;
  turboGet.mockReturnValue(null);
  addListener.mockImplementation((_event, listener) => {
    listeners.add(listener);
    return { remove: () => { listeners.delete(listener); } };
  });
});
afterEach(async () => {
  if (renderer !== null) await act(async () => { renderer!.unmount(); });
});
afterAll(() => {
  turboGet.mockRestore(); addListener.mockRestore();
  delete (NativeModules as Record<string, unknown>).AgentPolicy;
});

test('does not read while closed; each opening reads independently of any attempt', async () => {
  await mount({ ...inputs, visible: false });
  expect(current.status).toBe('idle');
  expect(native.describe).not.toHaveBeenCalled();
  await update(inputs);
  expect(current.status).toBe('ready');
  await update({ ...inputs, visible: false });
  const beforeReopen = renders.length;
  const pending = deferred();
  native.describe.mockReturnValueOnce(pending.promise);
  await update(inputs);
  expect(native.describe).toHaveBeenCalledTimes(2);
  expect(renders.slice(beforeReopen).every(value => value.policy === null)).toBe(true);
  await act(async () => { pending.resolve(descriptor(native.describe.mock.calls[1][0])); });
  expect(current.status).toBe('ready');
  await update({ ...inputs });
  expect(current.status).toBe('ready');
  expect(native.describe).toHaveBeenCalledTimes(2);
});

test.each([
  { ...inputs, workspaceId: otherId }, { ...inputs, bindingRevision: 2 }, { ...inputs, projectId: otherId },
])('hides old policy in the very first render after a binding change %#', async next => {
  await mount();
  const pending = deferred();
  native.describe.mockReturnValueOnce(pending.promise);
  const beforeChange = renders.length;
  await update(next);
  expect(renders.slice(beforeChange).every(value => value.status === 'loading' && value.policy === null)).toBe(true);
  await act(async () => { pending.resolve(descriptor(native.describe.mock.calls[1][0])); });
  expect(current.policy).toMatchObject({
    workspace_id: next.workspaceId, workspace_binding_revision: next.bindingRevision, project_id: next.projectId,
  });
});

test('a previous workspace reply cannot replace a newer policy', async () => {
  const first = deferred(), second = deferred();
  native.describe.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await mount();
  await update({ ...inputs, workspaceId: otherId });
  await act(async () => { second.resolve(descriptor(native.describe.mock.calls[1][0])); });
  expect(current.policy?.workspace_id).toBe(otherId);
  const afterNew = renders.length;
  await act(async () => { first.resolve(descriptor(native.describe.mock.calls[0][0])); });
  expect(renders).toHaveLength(afterNew);
  expect(current.policy?.workspace_id).toBe(otherId);
});

test('explicit retry hides old policy immediately and the latest retry wins', async () => {
  await mount();
  const first = deferred(), second = deferred();
  native.describe.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const beforeRetry = renders.length;
  await act(async () => { current.retry(); });
  expect(renders.slice(beforeRetry).every(value => value.policy === null)).toBe(true);
  await act(async () => { current.retry(); });
  await act(async () => { second.resolve(descriptor(native.describe.mock.calls[2][0])); });
  expect(current.status).toBe('ready');
  await act(async () => { first.reject({ code: 'E_AGENT_ROOT_STALE' }); });
  expect(current.status).toBe('ready');
  expect(current.errorCode).toBeNull();
});

test('foreground refresh reads again, without refreshing on duplicate active notifications', async () => {
  await mount();
  await emit('background');
  await emit('active');
  expect(native.describe).toHaveBeenCalledTimes(2);
  await emit('active');
  expect(native.describe).toHaveBeenCalledTimes(2);
  await update({ ...inputs, visible: false });
  await emit('background'); await emit('active');
  expect(native.describe).toHaveBeenCalledTimes(2);
});

test('ignores pending replies and detached listeners after close and unmount', async () => {
  const pending = deferred();
  native.describe.mockReturnValueOnce(pending.promise);
  await mount();
  const detached = [...listeners][0];
  await update({ ...inputs, visible: false });
  const afterClose = renders.length;
  await act(async () => {
    pending.resolve(descriptor(native.describe.mock.calls[0][0]));
    detached('background'); detached('active');
  });
  expect(renders).toHaveLength(afterClose);
  expect(native.describe).toHaveBeenCalledTimes(1);
  const second = deferred();
  native.describe.mockReturnValueOnce(second.promise);
  await update(inputs);
  const retry = current.retry;
  await act(async () => { renderer!.unmount(); });
  renderer = null;
  const afterUnmount = renders.length;
  await act(async () => { second.reject(new Error('private path')); retry(); });
  expect(renders).toHaveLength(afterUnmount);
  expect(listeners.size).toBe(0);
});

test('missing optional native module is unavailable, and retry probes again', async () => {
  delete (NativeModules as Record<string, unknown>).AgentPolicy;
  await mount();
  expect(current).toMatchObject({ status: 'unavailable', policy: null, errorCode: null });
  (NativeModules as Record<string, unknown>).AgentPolicy = native;
  await act(async () => { current.retry(); });
  expect(current.status).toBe('ready');
});

test('native failure has only a closed error code; retry can recover', async () => {
  native.describe.mockRejectedValueOnce({ code: 'E_AGENT_ROOT_STALE', message: 'private path' });
  await mount();
  expect(current).toMatchObject({ status: 'error', policy: null, errorCode: 'E_AGENT_ROOT_STALE' });
  expect(JSON.stringify(current)).not.toContain('private');
  await act(async () => { current.retry(); });
  expect(current.status).toBe('ready');
});

test('a missing workspace does not read native or retain the previous policy', async () => {
  await mount();
  await update({ ...inputs, workspaceId: null, bindingRevision: null });
  expect(current).toMatchObject({ status: 'unavailable', policy: null });
  expect(native.describe).toHaveBeenCalledTimes(1);
});

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, NativeModules, TurboModuleRegistry, type AppStateStatus } from 'react-native';
import { useRuntimeProgram } from '../src/environments/use-runtime-program';
import { LocalWorkspaces } from '../src/native/LocalWorkspaces';
import { deferred, environment, environmentNative, otherWorkspaceId, programNative, receipt, root } from '../test-fixtures/runtime-environments';

jest.mock('../src/native/LocalWorkspaces', () => ({ LocalWorkspaces: { resolve: jest.fn() } }));
type Input = Parameters<typeof useRuntimeProgram>[0];
type Value = ReturnType<typeof useRuntimeProgram>;
let current: Value, renderer: ReactTestRenderer | null;
let env: ReturnType<typeof environmentNative>, native: ReturnType<typeof programNative>;
const props: Input = { visible: true, root, ownerKey: 'chat-1' };
const listeners = new Set<(state: AppStateStatus) => void>();
const turbo = jest.spyOn(TurboModuleRegistry, 'get'), appState = jest.spyOn(AppState, 'addEventListener');
function Harness(input: Input) { current = useRuntimeProgram(input); return null; }
async function mount(input = props) { await act(async () => { renderer = create(<Harness {...input} />); }); }
async function update(input: Input) { await act(async () => { renderer!.update(<Harness {...input} />); }); }
const resolved = () => ({ schema_version: 1, disposition: 'direct', workspace: { workspace_id: root.workspace_id, binding_revision: root.binding_revision, status: 'ok' } });
beforeEach(() => {
  jest.useFakeTimers(); renderer = null; listeners.clear();
  env = environmentNative(); native = programNative();
  NativeModules.LocalEnvironments = env; NativeModules.LocalPrograms = native; turbo.mockReturnValue(null);
  (LocalWorkspaces.resolve as jest.Mock).mockReset().mockResolvedValue(resolved());
  appState.mockImplementation((_event, listener) => { listeners.add(listener); return { remove: () => { listeners.delete(listener); } }; });
});
afterEach(async () => { if (renderer) await act(async () => { renderer!.unmount(); }); jest.useRealTimers(); });
afterAll(() => { delete NativeModules.LocalEnvironments; delete NativeModules.LocalPrograms; turbo.mockRestore(); appState.mockRestore(); });
test('opening a run panel never downloads or starts anything', async () => {
  await mount(); expect(current.phase).toBe('idle'); expect(current.available).toBe(true);
  expect(env.installEnvironment).not.toHaveBeenCalled(); expect(native.startProgram).not.toHaveBeenCalled();
});
test('first explicit run installs only its selected language, resolves workspace again, then starts without credentials', async () => {
  await mount();
  await act(async () => { await current.start(environment(), 'src/main.py', ['hello world']); });
  expect(env.installEnvironment).toHaveBeenCalledTimes(1);
  expect(env.installEnvironment).toHaveBeenCalledWith({ schema_version: 1, environment_id: 'python-3-13' });
  expect(LocalWorkspaces.resolve).toHaveBeenCalledWith({ schema_version: 1, workspace_id: root.workspace_id,
    expected_binding_revision: 1, required_capabilities: ['read'] });
  expect(env.installEnvironment.mock.invocationCallOrder[0]).toBeLessThan((LocalWorkspaces.resolve as jest.Mock).mock.invocationCallOrder[0]);
  expect((LocalWorkspaces.resolve as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(native.startProgram.mock.invocationCallOrder[0]);
  expect(native.startProgram).toHaveBeenCalledWith(expect.objectContaining({ root, entry_path: 'src/main.py', args: ['hello world'] }));
  expect(current.receipt?.status).toBe('running');
});
test('an installed environment skips download; rapid Run clicks cannot start two VMs', async () => {
  await mount(); const pendingStart = deferred<unknown>(); native.startProgram.mockReturnValue(pendingStart.promise);
  let first!: Promise<void>;
  await act(async () => { first = current.start(environment({ state: 'installed' }), 'main.py', []); await current.start(environment({ state: 'installed' }), 'main.py', []); });
  expect(env.installEnvironment).not.toHaveBeenCalled(); expect(native.startProgram).toHaveBeenCalledTimes(1);
  await act(async () => { pendingStart.resolve(receipt()); await first; });
});
test.each([
  { ...props, root: { ...root, workspace_id: otherWorkspaceId } },
  { ...props, root: { ...root, binding_revision: 2 } },
  { ...props, root: { ...root, project_id: otherWorkspaceId } },
  { ...props, ownerKey: 'chat-2' }, { ...props, blocked: true }, { ...props, visible: false },
])('owner change during download cancels it and cannot start stale workspace %#', async next => {
  await mount(); const download = deferred<unknown>(); env.installEnvironment.mockReturnValue(download.promise);
  let completion!: Promise<void>;
  await act(async () => { completion = current.start(environment(), 'main.py', []); });
  expect(current.phase).toBe('downloading');
  await update(next); expect(current.receipt).toBeNull();
  await act(async () => { download.resolve(environment({ state: 'installed' })); await completion; });
  expect(env.cancelInstall).toHaveBeenCalledTimes(1); expect(native.startProgram).not.toHaveBeenCalled();
  expect(LocalWorkspaces.resolve).not.toHaveBeenCalled();
});
test('Cancel download prevents a later success from automatically running', async () => {
  await mount(); const download = deferred<unknown>(); env.installEnvironment.mockReturnValue(download.promise);
  let completion!: Promise<void>;
  await act(async () => { completion = current.start(environment(), 'main.py', []); });
  await act(async () => { await current.stop(); });
  await act(async () => { download.resolve(environment({ state: 'installed' })); await completion; });
  expect(current.busy).toBe(false); expect(current.error).toBe('E_ENV_CANCELLED'); expect(native.startProgram).not.toHaveBeenCalled();
});
test('workspace changing after download but before native resolve returns cannot start', async () => {
  await mount(); const resolve = deferred<unknown>(); (LocalWorkspaces.resolve as jest.Mock).mockReturnValue(resolve.promise);
  let completion!: Promise<void>;
  await act(async () => { completion = current.start(environment(), 'main.py', []); });
  await update({ ...props, root: { ...root, binding_revision: 2 } });
  await act(async () => { resolve.resolve(resolved()); await completion; });
  expect(native.startProgram).not.toHaveBeenCalled();
});
test('native resolver rejects stale revision even when JavaScript owner has not changed', async () => {
  await mount(); (LocalWorkspaces.resolve as jest.Mock).mockResolvedValue({ ...resolved(), workspace: { ...resolved().workspace, binding_revision: 2 } });
  await act(async () => { await current.start(environment({ state: 'installed' }), 'main.py', []); });
  expect(native.startProgram).not.toHaveBeenCalled(); expect(current.error).toBe('E_PROGRAM_ROOT_STALE');
});
test('a start receipt arriving after Close is stopped, never displayed as another workspace run', async () => {
  await mount(); const start = deferred<unknown>(); native.startProgram.mockReturnValue(start.promise);
  let completion!: Promise<void>;
  await act(async () => { completion = current.start(environment({ state: 'installed' }), 'main.py', []); });
  await update({ ...props, visible: false });
  await act(async () => { start.resolve(receipt()); await completion; });
  expect(native.stopProgram).toHaveBeenCalledWith({ schema_version: 1, run_id: receipt().run_id });
  expect(current.receipt).toBeNull();
});
test('polling shows stdout, stderr, exit code and stops after final receipt', async () => {
  await mount(); await act(async () => { await current.start(environment({ state: 'installed' }), 'main.py', []); });
  native.programStatus.mockResolvedValue(receipt({ stdout: 'ready\n', stderr: 'warning\n' }));
  await act(async () => { jest.advanceTimersByTime(500); });
  expect(current.receipt).toMatchObject({ stdout: 'ready\n', stderr: 'warning\n' });
  native.programStatus.mockResolvedValue(receipt({ status: 'completed', stdout: 'ready\ndone\n', exit_code: 0 }));
  await act(async () => { jest.advanceTimersByTime(500); });
  expect(current.busy).toBe(false); expect(current.receipt).toMatchObject({ status: 'completed', exit_code: 0 });
  const count = native.programStatus.mock.calls.length;
  await act(async () => { jest.advanceTimersByTime(1000); }); expect(native.programStatus).toHaveBeenCalledTimes(count);
});
test('Stop keeps polling a stopping receipt until native cancellation is confirmed', async () => {
  await mount(); await act(async () => { await current.start(environment({ state: 'installed' }), 'main.py', []); });
  native.stopProgram.mockResolvedValue(receipt({ status: 'stopping' }));
  await act(async () => { await current.stop(); });
  expect(current.busy).toBe(true); expect(current.receipt?.status).toBe('stopping');
  native.programStatus.mockResolvedValue(receipt({ status: 'cancelled' }));
  await act(async () => { jest.advanceTimersByTime(500); });
  expect(current.busy).toBe(false); expect(current.receipt?.status).toBe('cancelled');
});
test('background cancels a running foreground program', async () => {
  await mount(); await act(async () => { await current.start(environment({ state: 'installed' }), 'main.py', []); });
  await act(async () => { listeners.forEach(listener => listener('background')); });
  expect(native.stopProgram).toHaveBeenCalledTimes(1); expect(current.receipt?.status).toBe('cancelled');
});
test.each([{ ...props, root: null }, { ...props, blocked: true }, { ...props, visible: false }])('does not start when context is unavailable %#', async input => {
  await mount(input); await act(async () => { await current.start(environment(), 'main.py', []); });
  expect(env.installEnvironment).not.toHaveBeenCalled(); expect(native.startProgram).not.toHaveBeenCalled();
});

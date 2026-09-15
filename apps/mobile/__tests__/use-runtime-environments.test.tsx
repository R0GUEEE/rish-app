import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { NativeModules, TurboModuleRegistry } from 'react-native';
import { useRuntimeEnvironments } from '../src/environments/use-runtime-environments';
import { deferred, environment, environmentNative, otherWorkspaceId, workspaceId } from '../test-fixtures/runtime-environments';
type Input = Parameters<typeof useRuntimeEnvironments>[0];
let current: ReturnType<typeof useRuntimeEnvironments>, renderer: ReactTestRenderer | null;
let native: ReturnType<typeof environmentNative>;
const turbo = jest.spyOn(TurboModuleRegistry, 'get');
const props: Input = { visible: true, workspaceId };
function Harness(input: Input) { current = useRuntimeEnvironments(input); return null; }
async function mount(input = props) { await act(async () => { renderer = create(<Harness {...input} />); }); }
beforeEach(() => { jest.useFakeTimers(); renderer = null; native = environmentNative(); NativeModules.LocalEnvironments = native; turbo.mockReturnValue(null); });
afterEach(async () => { if (renderer) await act(async () => { renderer!.unmount(); }); jest.useRealTimers(); });
afterAll(() => { delete NativeModules.LocalEnvironments; turbo.mockRestore(); });
test('opens with metadata only and refreshes installation progress', async () => {
  await mount(); expect(current.status).toBe('ready'); expect(native.installEnvironment).not.toHaveBeenCalled();
  native.listEnvironments.mockResolvedValue({ schema_version: 1, environments: [environment({ state: 'downloading', downloaded_bytes: 100 })], selected_environment_id: null });
  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(current.list?.environments[0].downloaded_bytes).toBe(100);
});
test('an Agent installation can be explicitly cancelled from the shared manager', async () => {
  native.listEnvironments.mockResolvedValue({ schema_version: 1,
    environments: [environment({ state: 'downloading', downloaded_bytes: 100 })], selected_environment_id: null });
  await mount();
  expect(current.busy).toBe(false); expect(current.cancellable).toBe(true);
  await act(async () => { await current.cancel(); });
  expect(native.cancelInstall).toHaveBeenCalledTimes(1);
  expect(native.installEnvironment).not.toHaveBeenCalled();
});
test('switching a workspace or unmounting the manager never cancels an Agent installation', async () => {
  native.listEnvironments.mockResolvedValue({ schema_version: 1,
    environments: [environment({ state: 'installing' })], selected_environment_id: null });
  await mount(); expect(current.cancellable).toBe(true);
  await act(async () => { renderer!.update(<Harness {...props} workspaceId={otherWorkspaceId} />); });
  await act(async () => { renderer!.unmount(); renderer = null; });
  expect(native.cancelInstall).not.toHaveBeenCalled();
});
test('URL import exposes cancellable busy state before manifest identity is known', async () => {
  await mount(); const download = deferred<unknown>(); native.downloadEnvironment.mockReturnValue(download.promise);
  let completion!: Promise<boolean>;
  await act(async () => { completion = current.download('https://example.test/python.rishenv'); });
  expect(current.busy).toBe(true);
  await act(async () => { await current.cancel(); }); expect(current.busy).toBe(false);
  await act(async () => { download.resolve(environment({ state: 'installed' })); expect(await completion).toBe(false); });
  expect(native.selectEnvironment).not.toHaveBeenCalled();
});
test('switching workspace hides prior selection immediately and cannot let delayed list replace new selection', async () => {
  await mount(); const stale = deferred<unknown>(); native.listEnvironments.mockReturnValueOnce(stale.promise);
  let refresh!: Promise<void>;
  await act(async () => { refresh = current.refresh(); });
  native.listEnvironments.mockResolvedValue({ schema_version: 1, environments: [environment({ environment_id: 'rust-1', family: 'rust' })], selected_environment_id: 'rust-1' });
  await act(async () => { renderer!.update(<Harness {...props} workspaceId={otherWorkspaceId} />); });
  await act(async () => { stale.resolve({ schema_version: 1, environments: [environment()], selected_environment_id: 'python-3-13' }); await refresh; });
  expect(current.list?.selected_environment_id).toBe('rust-1');
});
test('closing detaches the manager without cancelling the app-wide cached installation', async () => {
  await mount(); const download = deferred<unknown>(); native.installEnvironment.mockReturnValue(download.promise);
  let completion!: Promise<boolean>;
  await act(async () => { completion = current.install('python-3-13'); });
  await act(async () => { renderer!.update(<Harness {...props} visible={false} />); });
  expect(native.cancelInstall).not.toHaveBeenCalled();
  await act(async () => { download.resolve(environment({ state: 'installed' })); expect(await completion).toBe(false); });
});
test('closed panels do not read metadata; missing native API is honest', async () => {
  await mount({ ...props, visible: false }); expect(native.listEnvironments).not.toHaveBeenCalled();
  delete NativeModules.LocalEnvironments;
  await act(async () => { renderer!.update(<Harness {...props} />); });
  expect(current.status).toBe('unavailable'); expect(current.list).toBeNull();
});

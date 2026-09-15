import { NativeModules, TurboModuleRegistry } from 'react-native';
import { ENVIRONMENT_ERRORS, LocalEnvironments, validEnvironmentURL } from '../src/native/runtime-environments';
import { environment, environmentNative, workspaceId } from '../test-fixtures/runtime-environments';
let native: ReturnType<typeof environmentNative>;
const turbo = jest.spyOn(TurboModuleRegistry, 'get');
beforeEach(() => { native = environmentNative(); NativeModules.LocalEnvironments = native; turbo.mockReturnValue(null); });
afterAll(() => { delete NativeModules.LocalEnvironments; turbo.mockRestore(); });
const listRequest = { schema_version: 1 as const, workspace_id: workspaceId };
test('listing metadata and selecting an uninstalled package never download it', async () => {
  const result = await LocalEnvironments.listEnvironments(listRequest);
  expect(result.environments[0].state).toBe('not_installed');
  await LocalEnvironments.selectEnvironment({ schema_version: 1, workspace_id: workspaceId, environment_id: 'python-3-13' });
  expect(native.installEnvironment).not.toHaveBeenCalled(); expect(native.downloadEnvironment).not.toHaveBeenCalled();
});
test('absence, partial modules and implemented false report unavailable', async () => {
  delete NativeModules.LocalEnvironments;
  expect(LocalEnvironments.isAvailable()).toBe(false);
  await expect(LocalEnvironments.listEnvironments(listRequest)).rejects.toMatchObject({ code: 'E_ENV_UNAVAILABLE' });
  NativeModules.LocalEnvironments = { listEnvironments: native.listEnvironments };
  expect(LocalEnvironments.isAvailable()).toBe(false);
  NativeModules.LocalEnvironments = { ...native, implemented: false };
  expect(LocalEnvironments.isAvailable()).toBe(false);
});
test('turbo fallback preserves native implementation binding', async () => {
  delete NativeModules.LocalEnvironments; turbo.mockReturnValue(native as never);
  expect(LocalEnvironments.isAvailable()).toBe(true);
  await LocalEnvironments.listEnvironments(listRequest); expect(native.listEnvironments).toHaveBeenCalledWith(listRequest);
});
test.each(['file:///secret', 'http://host/a', 'https://user:secret@example.com/a', 'https://host/a#secret', ' https://host/a', 'https://host/\nfoo'])('rejects unsafe package URL before native: %s', async url => {
  expect(validEnvironmentURL(url)).toBe(false);
  await expect(LocalEnvironments.downloadEnvironment({ schema_version: 1, url })).rejects.toMatchObject({ code: 'E_ENV_BAD_ARGUMENTS' });
  expect(native.downloadEnvironment).not.toHaveBeenCalled();
});
test('only an explicitly requested catalog ID is installed; mismatched response is refused', async () => {
  await LocalEnvironments.installEnvironment({ schema_version: 1, environment_id: 'python-3-13' });
  expect(native.installEnvironment).toHaveBeenCalledWith({ schema_version: 1, environment_id: 'python-3-13' });
  native.installEnvironment.mockResolvedValue(environment({ environment_id: 'java-21', state: 'installed' }));
  await expect(LocalEnvironments.installEnvironment({ schema_version: 1, environment_id: 'python-3-13' })).rejects.toMatchObject({ code: 'E_ENV_NATIVE' });
});
test.each([
  { native_path: '/secret' }, { disk_bytes: 1 }, { minimum_memory_mib: 2048 }, { total_bytes: 1, downloaded_bytes: 2 },
  { downloaded_bytes: NaN }, { architecture: 'arm64' }, { error_code: 'private /path failed' }, { family: 'shell' },
])('rejects malformed descriptors without trusting metadata %#', async overrides => {
  native.listEnvironments.mockResolvedValue({ schema_version: 1, environments: [{ ...environment(), ...overrides }], selected_environment_id: null });
  await expect(LocalEnvironments.listEnvironments(listRequest)).rejects.toMatchObject({ code: 'E_ENV_NATIVE' });
});
test.each(ENVIRONMENT_ERRORS)('preserves stable native error code %s without raw messages', async code => {
  native.installEnvironment.mockRejectedValue({ code, message: '/Users/private/token-secret' });
  const error = await LocalEnvironments.installEnvironment({ schema_version: 1, environment_id: 'python-3-13' }).catch(value => value);
  expect(error.message).toBe(code);
});
test('never evaluates an accessor in native metadata or rejected error', async () => {
  const getter = jest.fn(() => '/private');
  const value = { ...environment() }; Object.defineProperty(value, 'display_name', { enumerable: true, get: getter });
  native.listEnvironments.mockResolvedValue({ schema_version: 1, environments: [value], selected_environment_id: null });
  await expect(LocalEnvironments.listEnvironments(listRequest)).rejects.toMatchObject({ code: 'E_ENV_NATIVE' });
  native.installEnvironment.mockRejectedValue(Object.defineProperty({}, 'code', { get: getter }));
  await expect(LocalEnvironments.installEnvironment({ schema_version: 1, environment_id: 'python-3-13' })).rejects.toMatchObject({ code: 'E_ENV_NATIVE' });
  expect(getter).not.toHaveBeenCalled();
});
test('user cancelling import resolves null; cancellation and deletion verify receipts', async () => {
  expect(await LocalEnvironments.importEnvironment()).toBeNull();
  expect(await LocalEnvironments.cancelInstall({ schema_version: 1 })).toEqual({ schema_version: 1, status: 'cancelled' });
  native.removeEnvironment.mockResolvedValue({ schema_version: 1, status: 'selected' });
  await expect(LocalEnvironments.removeEnvironment({ schema_version: 1, environment_id: 'python-3-13' })).rejects.toMatchObject({ code: 'E_ENV_NATIVE' });
});
test('a failed package with an actual native compatibility code remains visible and retryable', async () => {
  native.listEnvironments.mockResolvedValue({ schema_version: 1, environments: [environment({ state: 'failed', error_code: 'E_ENV_INCOMPATIBLE' })], selected_environment_id: null });
  const result = await LocalEnvironments.listEnvironments(listRequest);
  expect(result.environments[0]).toMatchObject({ state: 'failed', error_code: 'E_ENV_INCOMPATIBLE' });
});

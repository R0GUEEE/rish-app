/* eslint-disable no-control-regex -- Validate protocol text and remove terminal control characters. */
import {
  boundedArray, environmentId, exact, integer, member, nativeModule, reject,
  RuntimeBridgeError, safeCode, shortText, uuid,
} from '../environments/runtime-validation';

export const RUNTIME_FAMILIES = ['python', 'java', 'go', 'rust', 'bun', 'node'] as const;
export type RuntimeFamily = typeof RUNTIME_FAMILIES[number];
export const ENVIRONMENT_STATES = ['not_installed', 'downloading', 'installing', 'installed', 'failed'] as const;
export type RuntimeEnvironment = {
  readonly schema_version: 1; readonly environment_id: string; readonly family: RuntimeFamily;
  readonly display_name: string; readonly version: string; readonly architecture: 'x86_64';
  readonly disk_bytes: number; readonly minimum_memory_mib: number;
  readonly state: typeof ENVIRONMENT_STATES[number]; readonly downloaded_bytes: number;
  readonly total_bytes: number | null; readonly error_code: string | null;
};
export type RuntimeEnvironmentList = {
  readonly schema_version: 1; readonly environments: readonly RuntimeEnvironment[];
  readonly selected_environment_id: string | null;
};
export const ENVIRONMENT_ERRORS = [
  'E_ENV_BAD_ARGUMENTS', 'E_ENV_STORAGE', 'E_ENV_NOT_FOUND', 'E_ENV_NOT_INSTALLED', 'E_ENV_BUSY',
  'E_ENV_IN_USE', 'E_ENV_LIMIT', 'E_ENV_PACKAGE_INVALID', 'E_ENV_PACKAGE_TOO_LARGE', 'E_ENV_INCOMPATIBLE',
  'E_ENV_INTEGRITY', 'E_ENV_DISK_SPACE', 'E_ENV_DOWNLOAD', 'E_ENV_CANCELLED', 'E_ENV_CONFLICT',
  'E_ENV_UNAVAILABLE', 'E_ENV_NATIVE',
] as const;
export const runtimeEnvironmentErrorCode = (error: unknown): string => safeCode(error, ENVIRONMENT_ERRORS, 'E_ENV_NATIVE');
const methods = ['listEnvironments', 'installEnvironment', 'importEnvironment', 'downloadEnvironment',
  'cancelInstall', 'removeEnvironment', 'selectEnvironment'] as const;
const ownedMethods = ['installEnvironmentOwned', 'cancelOwnedInstall'] as const;
const invalid = 'E_ENV_BAD_ARGUMENTS';
function descriptor(value: unknown): RuntimeEnvironment {
  const r = exact(value, ['schema_version', 'environment_id', 'family', 'display_name', 'version', 'architecture',
    'disk_bytes', 'minimum_memory_mib', 'state', 'downloaded_bytes', 'total_bytes', 'error_code'], 'E_ENV_NATIVE');
  if (r.schema_version !== 1 || !environmentId(r.environment_id) || !shortText(r.display_name, 80) ||
      !shortText(r.version, 64) || r.architecture !== 'x86_64' || !integer(r.disk_bytes, 1048576, 4294967296) ||
      r.disk_bytes % 512 !== 0 || !integer(r.minimum_memory_mib, 256, 1024) || !integer(r.downloaded_bytes, 0, 805306368) ||
      (r.total_bytes !== null && !integer(r.total_bytes, 1, 805306368)) ||
      (typeof r.total_bytes === 'number' && r.downloaded_bytes > r.total_bytes) ||
      (r.error_code !== null && (typeof r.error_code !== 'string' || !ENVIRONMENT_ERRORS.includes(r.error_code as typeof ENVIRONMENT_ERRORS[number])))) reject('E_ENV_NATIVE');
  return Object.freeze({ schema_version: 1, environment_id: r.environment_id, family: member(r.family, RUNTIME_FAMILIES, 'E_ENV_NATIVE'),
    display_name: r.display_name, version: r.version, architecture: 'x86_64', disk_bytes: r.disk_bytes,
    minimum_memory_mib: r.minimum_memory_mib, state: member(r.state, ENVIRONMENT_STATES, 'E_ENV_NATIVE'),
    downloaded_bytes: r.downloaded_bytes, total_bytes: r.total_bytes, error_code: r.error_code as string | null });
}
async function call(name: typeof methods[number], request?: unknown): Promise<unknown> {
  const native = nativeModule('LocalEnvironments', methods);
  if (!native) reject('E_ENV_UNAVAILABLE');
  try { return await (request === undefined ? native[name]() : native[name](request)); }
  catch (error) { throw new RuntimeBridgeError(runtimeEnvironmentErrorCode(error)); }
}
async function ownedCall(name: typeof ownedMethods[number], request: unknown): Promise<unknown> {
  const native = nativeModule('LocalEnvironments', ownedMethods);
  if (!native) reject('E_ENV_UNAVAILABLE');
  try { return await native[name](request); }
  catch (error) { throw new RuntimeBridgeError(runtimeEnvironmentErrorCode(error)); }
}
function idRequest(value: unknown) {
  const r = exact(value, ['schema_version', 'environment_id'], invalid);
  if (r.schema_version !== 1 || !environmentId(r.environment_id)) reject(invalid);
  return { schema_version: 1 as const, environment_id: r.environment_id };
}
function status(value: unknown, values: readonly string[]) {
  const r = exact(value, ['schema_version', 'status'], 'E_ENV_NATIVE');
  if (r.schema_version !== 1) reject('E_ENV_NATIVE');
  return { schema_version: 1 as const, status: member(r.status, values, 'E_ENV_NATIVE') };
}
export function validEnvironmentURL(value: string): boolean {
  if (value.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password && !url.hash;
  } catch { return false; }
}
export const LocalEnvironments = Object.freeze({
  isAvailable: () => nativeModule('LocalEnvironments', methods) !== null,
  supportsOwnedInstall: () => nativeModule('LocalEnvironments', ownedMethods) !== null,
  async listEnvironments(request: { schema_version: 1; workspace_id: string | null }): Promise<RuntimeEnvironmentList> {
    const input = exact(request, ['schema_version', 'workspace_id'], invalid);
    if (input.schema_version !== 1 || (input.workspace_id !== null && !uuid(input.workspace_id))) reject(invalid);
    const result = exact(await call('listEnvironments', { schema_version: 1, workspace_id: input.workspace_id }),
      ['schema_version', 'environments', 'selected_environment_id'], 'E_ENV_NATIVE');
    if (result.schema_version !== 1 || (result.selected_environment_id !== null && !environmentId(result.selected_environment_id))) reject('E_ENV_NATIVE');
    const environments = boundedArray(result.environments, 128, 'E_ENV_NATIVE').map(descriptor);
    if (new Set(environments.map(item => item.environment_id)).size !== environments.length ||
        (result.selected_environment_id !== null && !environments.some(item => item.environment_id === result.selected_environment_id))) reject('E_ENV_NATIVE');
    return Object.freeze({ schema_version: 1, environments: Object.freeze(environments), selected_environment_id: result.selected_environment_id as string | null });
  },
  async installEnvironment(request: { schema_version: 1; environment_id: string }): Promise<RuntimeEnvironment> {
    const input = idRequest(request), result = descriptor(await call('installEnvironment', input));
    if (result.environment_id !== input.environment_id || result.state !== 'installed') reject('E_ENV_NATIVE');
    return result;
  },
  async installEnvironmentOwned(request: { schema_version: 1; operation_id: string; environment_id: string }): Promise<RuntimeEnvironment> {
    const input = exact(request, ['schema_version', 'operation_id', 'environment_id'], invalid);
    if (input.schema_version !== 1 || !uuid(input.operation_id) || !environmentId(input.environment_id)) reject(invalid);
    const result = descriptor(await ownedCall('installEnvironmentOwned', input));
    if (result.environment_id !== input.environment_id || result.state !== 'installed') reject('E_ENV_NATIVE');
    return result;
  },
  async cancelOwnedInstall(request: { schema_version: 1; operation_id: string }) {
    const input = exact(request, ['schema_version', 'operation_id'], invalid);
    if (input.schema_version !== 1 || !uuid(input.operation_id)) reject(invalid);
    return status(await ownedCall('cancelOwnedInstall', input), ['cancelled', 'idle']);
  },
  async importEnvironment(): Promise<RuntimeEnvironment | null> {
    const raw = await call('importEnvironment');
    if (raw === null) return null;
    const result = descriptor(raw);
    if (result.state !== 'installed') reject('E_ENV_NATIVE');
    return result;
  },
  async downloadEnvironment(request: { schema_version: 1; url: string }): Promise<RuntimeEnvironment> {
    const r = exact(request, ['schema_version', 'url'], invalid);
    if (r.schema_version !== 1 || typeof r.url !== 'string' || !validEnvironmentURL(r.url)) reject(invalid);
    const result = descriptor(await call('downloadEnvironment', { schema_version: 1, url: r.url }));
    if (result.state !== 'installed') reject('E_ENV_NATIVE');
    return result;
  },
  async cancelInstall(request: { schema_version: 1 }) {
    if (exact(request, ['schema_version'], invalid).schema_version !== 1) reject(invalid);
    return status(await call('cancelInstall', { schema_version: 1 }), ['cancelled', 'idle']);
  },
  async removeEnvironment(request: { schema_version: 1; environment_id: string }) {
    return status(await call('removeEnvironment', idRequest(request)), ['removed']);
  },
  async selectEnvironment(request: { schema_version: 1; workspace_id: string; environment_id: string }) {
    const input = exact(request, ['schema_version', 'workspace_id', 'environment_id'], invalid);
    if (input.schema_version !== 1 || !uuid(input.workspace_id) || !environmentId(input.environment_id)) reject(invalid);
    return status(await call('selectEnvironment', { schema_version: 1, workspace_id: input.workspace_id,
      environment_id: input.environment_id }), ['selected']);
  },
});

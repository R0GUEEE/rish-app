import type { RuntimeEnvironment } from '../src/native/runtime-environments';
import type { RuntimeProgramReceipt } from '../src/native/runtime-programs';
export const workspaceId = '11111111-1111-4111-8111-111111111111';
export const otherWorkspaceId = '22222222-2222-4222-8222-222222222222';
export const runId = '33333333-3333-4333-8333-333333333333';
export const root = { schema_version: 1 as const, workspace_id: workspaceId, binding_revision: 1, project_id: null };
export function environment(overrides: Partial<RuntimeEnvironment> = {}): RuntimeEnvironment {
  return { schema_version: 1, environment_id: 'python-3-13', family: 'python', display_name: 'Python', version: '3.13',
    architecture: 'x86_64', disk_bytes: 8388608, minimum_memory_mib: 256, state: 'not_installed', downloaded_bytes: 0,
    total_bytes: 1048576, error_code: null, ...overrides };
}
export function receipt(overrides: Partial<RuntimeProgramReceipt> = {}): RuntimeProgramReceipt {
  return { schema_version: 1, run_id: runId, workspace_id: workspaceId, environment_id: 'python-3-13', status: 'running',
    stdout: '', stderr: '', stdout_truncated: false, stderr_truncated: false, exit_code: null, error_code: null, ...overrides };
}
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function environmentNative() {
  return {
    listEnvironments: jest.fn().mockResolvedValue({ schema_version: 1, environments: [environment()], selected_environment_id: 'python-3-13' }),
    installEnvironment: jest.fn().mockResolvedValue(environment({ state: 'installed' })),
    importEnvironment: jest.fn().mockResolvedValue(null),
    downloadEnvironment: jest.fn().mockResolvedValue(environment({ state: 'installed' })),
    cancelInstall: jest.fn().mockResolvedValue({ schema_version: 1, status: 'cancelled' }),
    removeEnvironment: jest.fn().mockResolvedValue({ schema_version: 1, status: 'removed' }),
    selectEnvironment: jest.fn().mockResolvedValue({ schema_version: 1, status: 'selected' }),
  };
}
export function programNative() {
  return { startProgram: jest.fn().mockResolvedValue(receipt()), programStatus: jest.fn().mockResolvedValue(receipt()),
    stopProgram: jest.fn().mockResolvedValue(receipt({ status: 'cancelled' })) };
}

/* eslint-disable no-control-regex -- Validate protocol text and remove terminal control characters. */
import { assertWorkspaceRootRefV1, type WorkspaceRootRefV1 } from './WorkspaceRoot';
import {
  boundedArray, byteLength, environmentId, exact, integer, member, nativeModule,
  reject, RuntimeBridgeError, safeCode, uuid,
} from '../environments/runtime-validation';

export const PROGRAM_STATUSES = ['starting', 'running', 'stopping', 'completed', 'failed', 'cancelled'] as const;
export type RuntimeProgramReceipt = {
  readonly schema_version: 1; readonly run_id: string; readonly workspace_id: string; readonly environment_id: string;
  readonly status: typeof PROGRAM_STATUSES[number]; readonly stdout: string; readonly stderr: string;
  readonly stdout_truncated: boolean; readonly stderr_truncated: boolean; readonly exit_code: number | null;
  readonly error_code: string | null;
};
export type RuntimeProgramRequest = {
  schema_version: 1; operation_id: string; root: WorkspaceRootRefV1;
  environment_id: string; entry_path: string; args: readonly string[];
};
export const PROGRAM_ERRORS = ['E_PROGRAM_INVALID_REQUEST', 'E_PROGRAM_BUSY', 'E_PROGRAM_NOT_FOUND',
  'E_PROGRAM_OPERATION_CONFLICT', 'E_PROGRAM_ROOT_STALE', 'E_PROGRAM_SNAPSHOT_LIMIT', 'E_PROGRAM_UNSAFE_PATH',
  'E_PROGRAM_STORAGE', 'E_PROGRAM_ENVIRONMENT', 'E_PROGRAM_ASSETS_MISSING', 'E_PROGRAM_ASSET_INTEGRITY',
  'E_PROGRAM_UNAVAILABLE', 'E_PROGRAM_BOOT', 'E_PROGRAM_EXEC', 'E_PROGRAM_NATIVE', 'E_PROGRAM_TIMEOUT', 'E_PROGRAM_OUTPUT_LIMIT'] as const;
export const runtimeProgramErrorCode = (error: unknown): string => safeCode(error, PROGRAM_ERRORS, 'E_PROGRAM_NATIVE');
export function validProgramEntry(value: string): boolean {
  return value.length > 0 && byteLength(value) <= 1024 && !/[\\\u0000-\u001f\u007f]/u.test(value) &&
    value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && byteLength(part) <= 255);
}
export function parseProgramArguments(value: string): readonly string[] | null {
  try {
    const values: unknown = JSON.parse(value);
    return argumentsFrom(values);
  } catch { return null; }
}
function argumentsFrom(value: unknown): readonly string[] {
  const args = boundedArray(value, 64, 'E_PROGRAM_INVALID_REQUEST');
  if (!args.every(arg => typeof arg === 'string' && !arg.includes('\0') && byteLength(arg) <= 4096) ||
      (args as string[]).reduce((total, arg) => total + byteLength(arg), 0) > 65536) reject('E_PROGRAM_INVALID_REQUEST');
  return Object.freeze(args as string[]);
}
function output(value: unknown): string {
  if (typeof value !== 'string' || value.length > 262144 || byteLength(value) > 262144) reject('E_PROGRAM_NATIVE');
  // Preserve program text while removing terminal controls that have no meaning in a text panel.
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
}
function receipt(raw: unknown): RuntimeProgramReceipt {
  const r = exact(raw, ['schema_version', 'run_id', 'workspace_id', 'environment_id', 'status', 'stdout', 'stderr',
    'stdout_truncated', 'stderr_truncated', 'exit_code', 'error_code'], 'E_PROGRAM_NATIVE');
  if (r.schema_version !== 1 || !uuid(r.run_id) || !uuid(r.workspace_id) || !environmentId(r.environment_id) ||
      typeof r.stdout_truncated !== 'boolean' || typeof r.stderr_truncated !== 'boolean' ||
      (r.exit_code !== null && !integer(r.exit_code, -2147483648, 2147483647)) ||
      (r.error_code !== null && (typeof r.error_code !== 'string' || !PROGRAM_ERRORS.includes(r.error_code as typeof PROGRAM_ERRORS[number])))) reject('E_PROGRAM_NATIVE');
  return Object.freeze({ schema_version: 1, run_id: r.run_id, workspace_id: r.workspace_id,
    environment_id: r.environment_id, status: member(r.status, PROGRAM_STATUSES, 'E_PROGRAM_NATIVE'),
    stdout: output(r.stdout), stderr: output(r.stderr), stdout_truncated: r.stdout_truncated,
    stderr_truncated: r.stderr_truncated, exit_code: r.exit_code as number | null, error_code: r.error_code as string | null });
}
const methods = ['startProgram', 'programStatus', 'stopProgram'] as const;
async function call(name: typeof methods[number], request: unknown) {
  const native = nativeModule('LocalPrograms', methods);
  if (!native) reject('E_PROGRAM_UNAVAILABLE');
  try { return receipt(await native[name](request)); }
  catch (error) { throw new RuntimeBridgeError(runtimeProgramErrorCode(error)); }
}
function runRequest(value: unknown) {
  const r = exact(value, ['schema_version', 'run_id'], 'E_PROGRAM_INVALID_REQUEST');
  if (r.schema_version !== 1 || !uuid(r.run_id)) reject('E_PROGRAM_INVALID_REQUEST');
  return { schema_version: 1 as const, run_id: r.run_id };
}
async function existingRun(name: 'programStatus' | 'stopProgram', request: { schema_version: 1; run_id: string }) {
  const input = runRequest(request), result = await call(name, input);
  if (result.run_id !== input.run_id) reject('E_PROGRAM_NATIVE');
  return result;
}
export const LocalPrograms = Object.freeze({
  isAvailable: () => nativeModule('LocalPrograms', methods) !== null,
  async startProgram(request: RuntimeProgramRequest): Promise<RuntimeProgramReceipt> {
    const r = exact(request, ['schema_version', 'operation_id', 'root', 'environment_id', 'entry_path', 'args'], 'E_PROGRAM_INVALID_REQUEST');
    if (r.schema_version !== 1 || !uuid(r.operation_id) || !environmentId(r.environment_id) ||
        typeof r.entry_path !== 'string' || !validProgramEntry(r.entry_path)) reject('E_PROGRAM_INVALID_REQUEST');
    let root: WorkspaceRootRefV1;
    try { root = assertWorkspaceRootRefV1(r.root); } catch { return reject('E_PROGRAM_INVALID_REQUEST'); }
    const result = await call('startProgram', { schema_version: 1, operation_id: r.operation_id,
      root, environment_id: r.environment_id, entry_path: r.entry_path, args: argumentsFrom(r.args) });
    if (result.workspace_id !== root.workspace_id || result.environment_id !== r.environment_id) reject('E_PROGRAM_NATIVE');
    return result;
  },
  programStatus: (request: { schema_version: 1; run_id: string }) => existingRun('programStatus', request),
  stopProgram: (request: { schema_version: 1; run_id: string }) => existingRun('stopProgram', request),
});
export const programActive = (receiptValue: RuntimeProgramReceipt | null): boolean =>
  receiptValue !== null && ['starting', 'running', 'stopping'].includes(receiptValue.status);

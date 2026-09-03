import { NativeModules, TurboModuleRegistry } from 'react-native';

export type SessionSnapshotRefV1 = {
  schema_version: 1;
  generation: number;
  session_sha256: string;
};

export type LegacySessionSnapshotRefV1 = {
  schema_version: 1;
  legacy_bytes_sha256: string;
};

export type SessionSnapshotAuthorityV1 =
  | { schema_version: 1; kind: 'missing' }
  | {
      schema_version: 1;
      kind: 'legacy_present';
      legacy: LegacySessionSnapshotRefV1;
    }
  | {
      schema_version: 1;
      kind: 'present';
      snapshot: SessionSnapshotRefV1;
    };

export type LoadSessionSnapshotResult =
  | {
      schema_version: 1;
      status: 'missing';
      snapshot: null;
      session_json: null;
      writer_launch_instance_id: null;
      current_launch_instance_id: string;
    }
  | {
      schema_version: 1;
      status: 'legacy_present';
      legacy: LegacySessionSnapshotRefV1;
      session_json: string;
      writer_launch_instance_id: string;
      current_launch_instance_id: string;
    }
  | {
      schema_version: 1;
      status: 'present';
      snapshot: SessionSnapshotRefV1;
      session_json: string;
      writer_launch_instance_id: string;
      current_launch_instance_id: string;
    };

export type SessionSnapshotCASRequest = {
  schema_version: 1;
  operation_id: string;
  expected: SessionSnapshotAuthorityV1;
  candidate_json: string;
};

export type SessionSnapshotCASResult =
  | {
      schema_version: 1;
      status: 'committed';
      snapshot: SessionSnapshotRefV1;
    }
  | {
      schema_version: 1;
      status: 'conflict';
      current: SessionSnapshotAuthorityV1;
    }
  | {
      schema_version: 1;
      status: 'not_committed' | 'session_only' | 'unknown';
      current: SessionSnapshotAuthorityV1;
    };

export type SessionCommitQueryRequest = {
  schema_version: 1;
  operation_id: string;
};

export type SessionCommitQueryResult =
  | { schema_version: 1; status: 'not_started' | 'unknown' }
  | {
      schema_version: 1;
      status: 'committed';
      snapshot: SessionSnapshotRefV1;
    }
  | {
      schema_version: 1;
      status: 'conflict';
      current: SessionSnapshotAuthorityV1;
    };

export type WorkspaceAuthorityOutboxV1 = {
  schema_version: 1;
  operation_id: string;
  action: 'forget' | 'delete_owned';
  workspace_id: string;
  binding_revision: number;
  clearance_receipt_id: string;
  created_at: string;
};

export type WorkspaceBindingClearanceReceiptV1 = {
  schema_version: 1;
  clearance_receipt_id: string;
  operation_id: string;
  workspace_id: string;
  binding_revision: number;
  committed_session_generation: number;
  committed_session_sha256: string;
  issued_at: string;
};

export type SessionWorkspaceClearanceRequest = {
  schema_version: 1;
  candidate_json: string;
  operation: WorkspaceAuthorityOutboxV1;
};

export type SessionWorkspaceClearanceResult =
  | {
      schema_version: 1;
      status: 'committed';
      receipt: WorkspaceBindingClearanceReceiptV1;
    }
  | {
      schema_version: 1;
      status: 'not_committed' | 'session_only' | 'unknown';
      receipt: null;
    };

export type WorkspaceClearanceQueryRequest = {
  schema_version: 1;
  operation_id: string;
};

export type WorkspaceClearanceQueryResult =
  | { schema_version: 1; status: 'not_started' | 'unknown' }
  | {
      schema_version: 1;
      status: 'committed';
      receipt: WorkspaceBindingClearanceReceiptV1;
    };

type NativeSessionSnapshots = {
  loadSessionSnapshot(): Promise<LoadSessionSnapshotResult>;
  casPersistSession(
    request: SessionSnapshotCASRequest,
  ): Promise<SessionSnapshotCASResult>;
  querySessionCommit(
    request: SessionCommitQueryRequest,
  ): Promise<SessionCommitQueryResult>;
  persistSessionWithWorkspaceClearance(
    request: SessionWorkspaceClearanceRequest,
  ): Promise<SessionWorkspaceClearanceResult>;
  queryWorkspaceClearance(
    request: WorkspaceClearanceQueryRequest,
  ): Promise<WorkspaceClearanceQueryResult>;
};

export class SessionSnapshotsError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'SessionSnapshotsError';
    this.code = code;
  }
}

const objectPrototype = Object.prototype;
const nativeMethodNames = [
  'loadSessionSnapshot',
  'casPersistSession',
  'querySessionCommit',
  'persistSessionWithWorkspaceClearance',
  'queryWorkspaceClearance',
] as const;
const stableSessionErrorCodes = new Set([
  'E_SESSION_INVALID',
  'E_SESSION_CORRUPT',
  'E_SESSION_STORAGE',
  'E_SESSION_PROTECTION',
  'E_SESSION_BOUNDS',
  'E_SESSION_CONFLICT',
  'E_SESSION_NATIVE',
  'E_SESSION_PERSISTENCE',
  'E_WORKSPACE_INVALID',
  'E_WORKSPACE_NOT_FOUND',
  'E_WORKSPACE_BUSY',
  'E_WORKSPACE_CONFLICT',
  'E_WORKSPACE_PERSISTENCE',
]);

function fail(code = 'E_SESSION_INVALID'): never {
  throw new SessionSnapshotsError(code);
}

function requestRecord(value: unknown): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      fail();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== objectPrototype && prototype !== null) fail();
    if (Object.getOwnPropertySymbols(value).length !== 0) fail();
    const output = Object.create(null) as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        descriptor.enumerable !== true
      ) {
        fail();
      }
      output[name] = descriptor.value;
    }
    return output;
  } catch {
    fail();
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const record = requestRecord(value);
  const names = Object.getOwnPropertyNames(record);
  if (names.length !== keys.length || names.some(key => !keys.includes(key))) {
    fail();
  }
  return record;
}

function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      value,
    )
  );
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function timestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function operationId(value: unknown): value is string {
  return uuid(value);
}

function safeInteger(value: unknown, allowZero = true): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    (allowZero || value !== 0) &&
    !Object.is(value, -0)
  );
}

function utf8Bytes(value: string): number | null {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return null;
      bytes += 4;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return null;
    else bytes += 3;
  }
  return bytes;
}

function boundedJSON(value: unknown): value is string {
  const bytes = typeof value === 'string' ? utf8Bytes(value) : null;
  return bytes !== null && bytes > 0 && bytes <= 16 * 1024 * 1024;
}

function validateRef(value: unknown): SessionSnapshotRefV1 {
  const ref = exactRecord(value, [
    'schema_version',
    'generation',
    'session_sha256',
  ]);
  if (
    ref.schema_version !== 1 ||
    !safeInteger(ref.generation, false) ||
    !digest(ref.session_sha256)
  ) {
    fail();
  }
  return ref as SessionSnapshotRefV1;
}

function validateLegacyRef(value: unknown): LegacySessionSnapshotRefV1 {
  const ref = exactRecord(value, ['schema_version', 'legacy_bytes_sha256']);
  if (ref.schema_version !== 1 || !digest(ref.legacy_bytes_sha256)) fail();
  return ref as LegacySessionSnapshotRefV1;
}

function validateAuthority(value: unknown): SessionSnapshotAuthorityV1 {
  const raw = requestRecord(value);
  if (raw.schema_version !== 1 || typeof raw.kind !== 'string') fail();
  if (raw.kind === 'missing') {
    exactRecord(raw, ['schema_version', 'kind']);
    return raw as SessionSnapshotAuthorityV1;
  }
  if (raw.kind === 'legacy_present') {
    exactRecord(raw, ['schema_version', 'kind', 'legacy']);
    raw.legacy = validateLegacyRef(raw.legacy);
    return raw as SessionSnapshotAuthorityV1;
  }
  if (raw.kind === 'present') {
    exactRecord(raw, ['schema_version', 'kind', 'snapshot']);
    raw.snapshot = validateRef(raw.snapshot);
    return raw as SessionSnapshotAuthorityV1;
  }
  fail();
}

function validateCASRequest(value: unknown): SessionSnapshotCASRequest {
  const request = exactRecord(value, [
    'schema_version',
    'operation_id',
    'expected',
    'candidate_json',
  ]);
  if (
    request.schema_version !== 1 ||
    !operationId(request.operation_id) ||
    !boundedJSON(request.candidate_json)
  ) {
    fail();
  }
  request.expected = validateAuthority(request.expected);
  return request as SessionSnapshotCASRequest;
}

function validateQueryRequest(value: unknown): SessionCommitQueryRequest {
  const request = exactRecord(value, ['schema_version', 'operation_id']);
  if (request.schema_version !== 1 || !operationId(request.operation_id))
    fail();
  return request as SessionCommitQueryRequest;
}

function validateLoadResult(value: unknown): LoadSessionSnapshotResult {
  const result = requestRecord(value);
  if (result.schema_version !== 1 || typeof result.status !== 'string') {
    fail('E_SESSION_PERSISTENCE');
  }
  if (result.status === 'missing') {
    exactRecord(result, [
      'schema_version',
      'status',
      'snapshot',
      'session_json',
      'writer_launch_instance_id',
      'current_launch_instance_id',
    ]);
    if (
      result.snapshot !== null ||
      result.session_json !== null ||
      result.writer_launch_instance_id !== null ||
      !uuid(result.current_launch_instance_id)
    )
      fail('E_SESSION_CORRUPT');
    return result as LoadSessionSnapshotResult;
  }
  if (result.status === 'legacy_present') {
    exactRecord(result, [
      'schema_version',
      'status',
      'legacy',
      'session_json',
      'writer_launch_instance_id',
      'current_launch_instance_id',
    ]);
    result.legacy = validateLegacyRef(result.legacy);
    if (
      !boundedJSON(result.session_json) ||
      !uuid(result.writer_launch_instance_id) ||
      !uuid(result.current_launch_instance_id)
    )
      fail('E_SESSION_CORRUPT');
    return result as LoadSessionSnapshotResult;
  }
  if (result.status === 'present') {
    exactRecord(result, [
      'schema_version',
      'status',
      'snapshot',
      'session_json',
      'writer_launch_instance_id',
      'current_launch_instance_id',
    ]);
    result.snapshot = validateRef(result.snapshot);
    if (
      !boundedJSON(result.session_json) ||
      !uuid(result.writer_launch_instance_id) ||
      !uuid(result.current_launch_instance_id)
    )
      fail('E_SESSION_CORRUPT');
    return result as LoadSessionSnapshotResult;
  }
  fail('E_SESSION_PERSISTENCE');
}

function validateCASResult(value: unknown): SessionSnapshotCASResult {
  const result = requestRecord(value);
  if (result.schema_version !== 1 || typeof result.status !== 'string') {
    fail('E_SESSION_PERSISTENCE');
  }
  if (result.status === 'committed') {
    exactRecord(result, ['schema_version', 'status', 'snapshot']);
    result.snapshot = validateRef(result.snapshot);
    return result as SessionSnapshotCASResult;
  }
  if (
    result.status === 'conflict' ||
    result.status === 'not_committed' ||
    result.status === 'session_only' ||
    result.status === 'unknown'
  ) {
    exactRecord(result, ['schema_version', 'status', 'current']);
    result.current = validateAuthority(result.current);
    return result as SessionSnapshotCASResult;
  }
  fail('E_SESSION_PERSISTENCE');
}

function validateQueryResult(value: unknown): SessionCommitQueryResult {
  const result = requestRecord(value);
  if (result.schema_version !== 1 || typeof result.status !== 'string') {
    fail('E_SESSION_PERSISTENCE');
  }
  if (result.status === 'not_started' || result.status === 'unknown') {
    exactRecord(result, ['schema_version', 'status']);
    return result as SessionCommitQueryResult;
  }
  if (result.status === 'committed') {
    exactRecord(result, ['schema_version', 'status', 'snapshot']);
    result.snapshot = validateRef(result.snapshot);
    return result as SessionCommitQueryResult;
  }
  if (result.status === 'conflict') {
    exactRecord(result, ['schema_version', 'status', 'current']);
    result.current = validateAuthority(result.current);
    return result as SessionCommitQueryResult;
  }
  fail('E_SESSION_PERSISTENCE');
}

function validateWorkspaceAuthorityOutbox(
  value: unknown,
): WorkspaceAuthorityOutboxV1 {
  const operation = exactRecord(value, [
    'schema_version',
    'operation_id',
    'action',
    'workspace_id',
    'binding_revision',
    'clearance_receipt_id',
    'created_at',
  ]);
  if (
    operation.schema_version !== 1 ||
    !uuid(operation.operation_id) ||
    (operation.action !== 'forget' && operation.action !== 'delete_owned') ||
    !uuid(operation.workspace_id) ||
    !safeInteger(operation.binding_revision, false) ||
    !uuid(operation.clearance_receipt_id) ||
    !timestamp(operation.created_at)
  ) {
    fail();
  }
  return operation as WorkspaceAuthorityOutboxV1;
}

function validateClearanceReceipt(
  value: unknown,
): WorkspaceBindingClearanceReceiptV1 {
  const receipt = exactRecord(value, [
    'schema_version',
    'clearance_receipt_id',
    'operation_id',
    'workspace_id',
    'binding_revision',
    'committed_session_generation',
    'committed_session_sha256',
    'issued_at',
  ]);
  if (
    receipt.schema_version !== 1 ||
    !uuid(receipt.clearance_receipt_id) ||
    !uuid(receipt.operation_id) ||
    !uuid(receipt.workspace_id) ||
    !safeInteger(receipt.binding_revision, false) ||
    !safeInteger(receipt.committed_session_generation, false) ||
    !digest(receipt.committed_session_sha256) ||
    !timestamp(receipt.issued_at)
  ) {
    fail('E_SESSION_PERSISTENCE');
  }
  return receipt as WorkspaceBindingClearanceReceiptV1;
}

function validateWorkspaceClearanceRequest(
  value: unknown,
): SessionWorkspaceClearanceRequest {
  const request = exactRecord(value, [
    'schema_version',
    'candidate_json',
    'operation',
  ]);
  if (request.schema_version !== 1 || !boundedJSON(request.candidate_json)) {
    fail();
  }
  request.operation = validateWorkspaceAuthorityOutbox(request.operation);
  return request as SessionWorkspaceClearanceRequest;
}

function validateWorkspaceClearanceResult(
  value: unknown,
): SessionWorkspaceClearanceResult {
  const result = requestRecord(value);
  if (result.schema_version !== 1 || typeof result.status !== 'string') {
    fail('E_SESSION_PERSISTENCE');
  }
  if (result.status === 'committed') {
    exactRecord(result, ['schema_version', 'status', 'receipt']);
    result.receipt = validateClearanceReceipt(result.receipt);
    return result as SessionWorkspaceClearanceResult;
  }
  if (
    result.status === 'not_committed' ||
    result.status === 'session_only' ||
    result.status === 'unknown'
  ) {
    exactRecord(result, ['schema_version', 'status', 'receipt']);
    if (result.receipt !== null) fail('E_SESSION_PERSISTENCE');
    return result as SessionWorkspaceClearanceResult;
  }
  fail('E_SESSION_PERSISTENCE');
}

function validateWorkspaceClearanceQueryRequest(
  value: unknown,
): WorkspaceClearanceQueryRequest {
  const request = exactRecord(value, ['schema_version', 'operation_id']);
  if (request.schema_version !== 1 || !uuid(request.operation_id)) fail();
  return request as WorkspaceClearanceQueryRequest;
}

function validateWorkspaceClearanceQueryResult(
  value: unknown,
): WorkspaceClearanceQueryResult {
  const result = requestRecord(value);
  if (result.schema_version !== 1 || typeof result.status !== 'string') {
    fail('E_SESSION_PERSISTENCE');
  }
  if (result.status === 'not_started' || result.status === 'unknown') {
    exactRecord(result, ['schema_version', 'status']);
    return result as WorkspaceClearanceQueryResult;
  }
  if (result.status === 'committed') {
    exactRecord(result, ['schema_version', 'status', 'receipt']);
    result.receipt = validateClearanceReceipt(result.receipt);
    return result as WorkspaceClearanceQueryResult;
  }
  fail('E_SESSION_PERSISTENCE');
}

function nativeUnavailable(): never {
  const error = new SessionSnapshotsError('E_SESSION_NATIVE');
  error.message = 'SessionSnapshots native module is not linked';
  throw error;
}

const nativeMethodCache = new WeakMap<object, NativeSessionSnapshots>();

function validatedNativeMethods(
  value: unknown,
): NativeSessionSnapshots | null {
  try {
    if (typeof value !== 'object' || value === null) return null;
    const cached = nativeMethodCache.get(value);
    if (cached !== undefined) return cached;
    const methods: Partial<NativeSessionSnapshots> = {};
    for (const name of nativeMethodNames) {
      const method = Reflect.get(value, name) as unknown;
      if (typeof method !== 'function') return null;
      methods[name] = method.bind(value) as never;
    }
    const validated = Object.freeze(methods as NativeSessionSnapshots);
    nativeMethodCache.set(value, validated);
    return validated;
  } catch {
    return null;
  }
}

function nativeErrorCode(error: unknown, fallback: string): string {
  try {
    if (typeof error === 'object' && error !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
      const code =
        descriptor !== undefined && 'value' in descriptor
          ? descriptor.value
          : undefined;
      if (typeof code === 'string' && stableSessionErrorCodes.has(code)) {
        return code;
      }
    }
  } catch {
    return fallback;
  }
  return fallback;
}

function turboNative(): unknown {
  try {
    const value = TurboModuleRegistry.get('SessionSnapshots');
    if (typeof value === 'object' && value !== null) return value;
  } catch {}
  return null;
}

function legacyNative(): unknown {
  try {
    const value = Reflect.get(NativeModules, 'SessionSnapshots') as unknown;
    if (typeof value === 'object' && value !== null) return value;
    return null;
  } catch {
    return null;
  }
}

function resolveNativeMethods(): NativeSessionSnapshots | null {
  const legacy = validatedNativeMethods(legacyNative());
  return legacy ?? validatedNativeMethods(turboNative());
}

async function callNative<T>(
  method: keyof NativeSessionSnapshots,
  request: unknown,
  validate: (value: unknown) => T,
): Promise<T> {
  const nativeMethods = resolveNativeMethods();
  if (nativeMethods === null) nativeUnavailable();
  try {
    const callable = nativeMethods[method] as (
      request?: unknown,
    ) => Promise<unknown>;
    const result =
      request === undefined ? await callable() : await callable(request);
    return validate(result);
  } catch (error) {
    throw new SessionSnapshotsError(
      nativeErrorCode(error, 'E_SESSION_PERSISTENCE'),
    );
  }
}

export const SessionSnapshots = {
  isAvailable: () => resolveNativeMethods() !== null,
  loadSessionSnapshot: async () =>
    callNative('loadSessionSnapshot', undefined, validateLoadResult),
  casPersistSession: async (request: SessionSnapshotCASRequest) => {
    const checked = validateCASRequest(request);
    return callNative('casPersistSession', checked, validateCASResult);
  },
  querySessionCommit: async (request: SessionCommitQueryRequest) => {
    const checked = validateQueryRequest(request);
    return callNative('querySessionCommit', checked, validateQueryResult);
  },
  persistSessionWithWorkspaceClearance: async (
    request: SessionWorkspaceClearanceRequest,
  ) => {
    const checked = validateWorkspaceClearanceRequest(request);
    return callNative(
      'persistSessionWithWorkspaceClearance',
      checked,
      validateWorkspaceClearanceResult,
    );
  },
  queryWorkspaceClearance: async (request: WorkspaceClearanceQueryRequest) => {
    const checked = validateWorkspaceClearanceQueryRequest(request);
    return callNative(
      'queryWorkspaceClearance',
      checked,
      validateWorkspaceClearanceQueryResult,
    );
  },
};

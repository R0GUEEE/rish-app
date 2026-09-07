import { parseProviderBinding, providerHostMatches, providerRecordKeys } from '../providers/configuration';
import {
  PROVIDER_MODEL_IDS,
} from '../harness/types';
import {
  PROJECT_CONTEXT_ERROR_CODES,
  PROJECT_CONTEXT_OMISSION_REASONS,
  PROJECT_CONTEXT_SCHEMA_VERSION,
  PROJECT_CONTEXT_STALE_REASONS,
  PROJECT_CONTEXT_STATUSES,
  ProjectContextValidationError,
  type PersistedProjectContextStateV1,
  type ProjectContextConsentV1,
  type ProjectContextErrorCode,
  type ProjectContextIncludedItemV1,
  type ProjectContextManifestV1,
  type ProjectContextOmissionReason,
  type ProjectContextState,
  type ProjectContextStaleReason,
  type ProjectContextStatus,
} from './types';

type UnknownRecord = Record<string, unknown>;

const trustedObjectPrototype = Object.prototype;
const trustedArrayPrototype = Array.prototype;
const trustedArrayMap = Array.prototype.map;
const trustedJSONStringify = JSON.stringify;

const persistedKeys: ReadonlySet<string> = new Set([
  'schema_version',
  'project_id',
  'status',
  'selected_paths',
  'active_preparation_id',
  'manifest',
  'consent',
  'stale_reason',
  'error_code',
]);
const statuses: ReadonlySet<string> = new Set(PROJECT_CONTEXT_STATUSES);
const staleReasons: ReadonlySet<string> = new Set(
  PROJECT_CONTEXT_STALE_REASONS,
);
const errorCodes: ReadonlySet<string> = new Set(PROJECT_CONTEXT_ERROR_CODES);
const omissionReasons: ReadonlySet<string> = new Set(
  PROJECT_CONTEXT_OMISSION_REASONS,
);
const includedSources: ReadonlySet<string> = new Set([
  'tracked_file',
  'staged_diff',
  'worktree_diff',
]);
const harnessModels: ReadonlySet<string> = new Set(PROVIDER_MODEL_IDS);
const manifestKeys: ReadonlySet<string> = new Set([
  'schema_version',
  'snapshot_id',
  'project_id',
  'project_name',
  'branch',
  'head_oid',
  'clean',
  'conflicted',
  'captured_at',
  'policy_version',
  'provider_host',
  'model',
  'included',
  'omitted',
  'context_bytes',
  'estimated_tokens',
  'snapshot_sha256',
  'source_fingerprint',
]);
const includedKeys: ReadonlySet<string> = new Set([
  'path',
  'source',
  'bytes',
  'sha256',
]);
const omittedKeys: ReadonlySet<string> = new Set(['path', 'reason']);
const consentKeys: ReadonlySet<string> = new Set([
  'schema_version',
  'consent_receipt_id',
  'snapshot_id',
  'snapshot_sha256',
  'confirmed_at',
]);

function invalid(path: string, message: string): never {
  throw new ProjectContextValidationError(path, message);
}

function exactRecord(
  value: unknown,
  path: string,
  keys: ReadonlySet<string>,
): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(path, 'must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== trustedObjectPrototype && prototype !== null) {
    return invalid(path, 'must be a plain record');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return invalid(path, 'must not contain symbol properties');
  }
  const ownNames = Object.getOwnPropertyNames(value);
  for (let index = 0; index < ownNames.length; index += 1) {
    const name = ownNames[index]!;
    if (!keys.has(name)) {
      return invalid(`${path}.${name}`, 'is not recognized');
    }
  }
  const sanitized = Object.create(null) as UnknownRecord;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      return invalid(`${path}.${key}`, 'is required');
    }
    if (
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      descriptor.enumerable !== true
    ) {
      return invalid(`${path}.${key}`, 'must be an own data property');
    }
    sanitized[key] = descriptor.value;
  }
  return sanitized;
}

function enumValue<Value extends string>(
  value: unknown,
  path: string,
  values: ReadonlySet<string>,
): Value {
  if (typeof value !== 'string' || !values.has(value)) {
    return invalid(path, 'is not a supported value');
  }
  return value as Value;
}

function strictArray(
  value: unknown,
  path: string,
  maximumLength: number,
): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== trustedArrayPrototype
  ) {
    return invalid(path, 'must be an array');
  }
  const mapDescriptor = Object.getOwnPropertyDescriptor(
    trustedArrayPrototype,
    'map',
  );
  if (
    mapDescriptor === undefined ||
    mapDescriptor.value !== trustedArrayMap ||
    Object.getPrototypeOf(trustedArrayPrototype) !== trustedObjectPrototype ||
    Object.prototype.hasOwnProperty.call(trustedArrayPrototype, 'toJSON') ||
    Object.prototype.hasOwnProperty.call(trustedObjectPrototype, 'toJSON')
  ) {
    return invalid(path, 'must use standard array semantics');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximumLength
  ) {
    return invalid(`${path}.length`, 'must be a valid array length');
  }
  const length = lengthDescriptor.value as number;
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return invalid(path, 'must not override array semantics');
  }
  const ownNames = Object.getOwnPropertyNames(value);
  const allowedNames = new Set<string>(['length']);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    allowedNames.add(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      return invalid(`${path}[${index}]`, 'must not be sparse');
    }
    if (
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      descriptor.enumerable !== true
    ) {
      return invalid(`${path}[${index}]`, 'must be an own data property');
    }
    result[index] = descriptor.value;
  }
  for (let index = 0; index < ownNames.length; index += 1) {
    const name = ownNames[index]!;
    if (!allowedNames.has(name)) {
      return invalid(`${path}.${name}`, 'is not a valid array index');
    }
  }
  return result;
}

function sha256(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    return invalid(path, 'must be a lowercase SHA-256 digest');
  }
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    return invalid(path, 'must be a non-empty string');
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : nonEmptyString(value, path);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    return invalid(path, 'must be a boolean');
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return invalid(path, 'must be a non-negative safe integer');
  }
  return value;
}

function timestamp(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    )
  ) {
    return invalid(path, 'must be an ISO-8601 timestamp');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    return invalid(path, 'must be a valid ISO-8601 timestamp');
  }
  return value;
}

function headOid(value: unknown, path: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    return invalid(path, 'must be a lowercase 40-hex Git object id or null');
  }
  return value;
}

function includedItem(
  value: unknown,
  path: string,
): ProjectContextIncludedItemV1 {
  const raw = exactRecord(value, path, includedKeys);
  return {
    path: nonEmptyString(raw.path, `${path}.path`),
    source: enumValue<ProjectContextIncludedItemV1['source']>(
      raw.source,
      `${path}.source`,
      includedSources,
    ),
    bytes: nonNegativeInteger(raw.bytes, `${path}.bytes`),
    sha256: sha256(raw.sha256, `${path}.sha256`),
  };
}

function omittedItem(
  value: unknown,
  path: string,
): ProjectContextManifestV1['omitted'][number] {
  const raw = exactRecord(value, path, omittedKeys);
  return {
    path: nonEmptyString(raw.path, `${path}.path`),
    reason: enumValue<ProjectContextOmissionReason>(
      raw.reason,
      `${path}.reason`,
      omissionReasons,
    ),
  };
}

function manifest(value: unknown): ProjectContextManifestV1 | null {
  if (value === null) {
    return null;
  }
  const raw = exactRecord(value, '$.manifest', providerRecordKeys(value, manifestKeys));
  if (raw.schema_version !== PROJECT_CONTEXT_SCHEMA_VERSION) {
    return invalid('$.manifest.schema_version', 'must equal 1');
  }
  if (typeof raw.provider_host !== 'string') {
    return invalid(
      '$.manifest.provider_host',
      'must be a supported provider host',
    );
  }
  const includedEntries = strictArray(
    raw.included,
    '$.manifest.included',
    32,
  );
  const included: ProjectContextIncludedItemV1[] = [];
  for (let index = 0; index < includedEntries.length; index += 1) {
    included[index] = includedItem(
      includedEntries[index],
      `$.manifest.included[${index}]`,
    );
  }
  const includedPaths = new Set<string>();
  for (let index = 0; index < included.length; index += 1) {
    const item = included[index]!;
    const identity = `${item.path}\n${item.source}`;
    if (includedPaths.has(identity)) {
      return invalid(`$.manifest.included[${index}].path`, 'must be unique');
    }
    includedPaths.add(identity);
  }
  const omittedEntries = strictArray(
    raw.omitted,
    '$.manifest.omitted',
    5000,
  );
  const omitted: ProjectContextManifestV1['omitted'][number][] = [];
  for (let index = 0; index < omittedEntries.length; index += 1) {
    omitted[index] = omittedItem(
      omittedEntries[index],
      `$.manifest.omitted[${index}]`,
    );
  }
  const model = enumValue<ProjectContextManifestV1['model']>(
    raw.model,
    '$.manifest.model',
    harnessModels,
  );
  if (!providerHostMatches(model, raw.provider_host, raw.provider_configuration)) {
    return invalid(
      '$.manifest.provider_host',
      'must match the provider of the manifest model',
    );
  }
  return {
    ...(raw.provider_configuration === undefined ? {} : { provider_configuration: parseProviderBinding(raw.provider_configuration, model)! }),
    schema_version: PROJECT_CONTEXT_SCHEMA_VERSION,
    snapshot_id: nonEmptyString(raw.snapshot_id, '$.manifest.snapshot_id'),
    project_id: nonEmptyString(raw.project_id, '$.manifest.project_id'),
    project_name: nonEmptyString(raw.project_name, '$.manifest.project_name'),
    branch: nullableString(raw.branch, '$.manifest.branch'),
    head_oid: headOid(raw.head_oid, '$.manifest.head_oid'),
    clean: boolean(raw.clean, '$.manifest.clean'),
    conflicted: boolean(raw.conflicted, '$.manifest.conflicted'),
    captured_at: timestamp(raw.captured_at, '$.manifest.captured_at'),
    policy_version: nonEmptyString(
      raw.policy_version,
      '$.manifest.policy_version',
    ),
    provider_host: raw.provider_host,
    model,
    included,
    omitted,
    context_bytes: nonNegativeInteger(
      raw.context_bytes,
      '$.manifest.context_bytes',
    ),
    estimated_tokens: nonNegativeInteger(
      raw.estimated_tokens,
      '$.manifest.estimated_tokens',
    ),
    snapshot_sha256: sha256(
      raw.snapshot_sha256,
      '$.manifest.snapshot_sha256',
    ),
    source_fingerprint: sha256(
      raw.source_fingerprint,
      '$.manifest.source_fingerprint',
    ),
  };
}

function consent(value: unknown): ProjectContextConsentV1 | null {
  if (value === null) {
    return null;
  }
  const raw = exactRecord(value, '$.consent', consentKeys);
  if (raw.schema_version !== PROJECT_CONTEXT_SCHEMA_VERSION) {
    return invalid('$.consent.schema_version', 'must equal 1');
  }
  return {
    schema_version: PROJECT_CONTEXT_SCHEMA_VERSION,
    consent_receipt_id: nonEmptyString(
      raw.consent_receipt_id,
      '$.consent.consent_receipt_id',
    ),
    snapshot_id: nonEmptyString(raw.snapshot_id, '$.consent.snapshot_id'),
    snapshot_sha256: sha256(raw.snapshot_sha256, '$.consent.snapshot_sha256'),
    confirmed_at: timestamp(raw.confirmed_at, '$.consent.confirmed_at'),
  };
}

function orderPaths(paths: readonly string[]): string[] {
  const ordered: string[] = [];
  for (let sourceIndex = 0; sourceIndex < paths.length; sourceIndex += 1) {
    const path = paths[sourceIndex]!;
    let insertionIndex = 0;
    while (
      insertionIndex < ordered.length &&
      ordered[insertionIndex]! < path
    ) {
      insertionIndex += 1;
    }
    for (
      let targetIndex = ordered.length;
      targetIndex > insertionIndex;
      targetIndex -= 1
    ) {
      ordered[targetIndex] = ordered[targetIndex - 1]!;
    }
    ordered[insertionIndex] = path;
  }
  return ordered;
}

function selectedPaths(value: unknown): string[] {
  const entries = strictArray(value, '$.selected_paths', 5000);
  const seen = new Set<string>();
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (typeof entry !== 'string' || entry.length === 0) {
      return invalid(
        `$.selected_paths[${index}]`,
        'must be a non-empty string',
      );
    }
    if (seen.has(entry)) {
      return invalid(`$.selected_paths[${index}]`, 'must be unique');
    }
    seen.add(entry);
    paths[index] = entry;
  }
  return orderPaths(paths);
}

function decode(input: unknown): unknown {
  return typeof input === 'string' ? JSON.parse(input) : input;
}

function quoteJSONString(value: string, path: string): string {
  const encoded = trustedJSONStringify(value);
  if (typeof encoded !== 'string') {
    return invalid(path, 'could not encode string');
  }
  return encoded;
}

function safeEncodeJSON(value: unknown, path = '$'): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return quoteJSONString(value, path);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        return invalid(path, 'must be a finite number');
      }
      return `${value}`;
    case 'object': {
      if (Array.isArray(value)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(
          value,
          'length',
        );
        if (
          lengthDescriptor === undefined ||
          !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
        ) {
          return invalid(path, 'must be a dense array');
        }
        const length = lengthDescriptor.value as number;
        let encoded = '[';
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
          );
          if (
            descriptor === undefined ||
            !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          ) {
            return invalid(`${path}[${index}]`, 'must be an own data property');
          }
          if (index > 0) {
            encoded += ',';
          }
          encoded += safeEncodeJSON(
            descriptor.value,
            `${path}[${index}]`,
          );
        }
        return `${encoded}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== trustedObjectPrototype && prototype !== null) {
        return invalid(path, 'must be a plain record');
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        return invalid(path, 'must not contain symbol properties');
      }
      const names = Object.getOwnPropertyNames(value);
      let encoded = '{';
      let encodedCount = 0;
      for (let index = 0; index < names.length; index += 1) {
        const name = names[index]!;
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (
          descriptor === undefined ||
          !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true
        ) {
          return invalid(`${path}.${name}`, 'must be an enumerable data property');
        }
        if (encodedCount > 0) {
          encoded += ',';
        }
        encoded += `${quoteJSONString(name, path)}:${safeEncodeJSON(
          descriptor.value,
          `${path}.${name}`,
        )}`;
        encodedCount += 1;
      }
      return `${encoded}}`;
    }
    default:
      return invalid(path, 'contains an unsupported JSON value');
  }
}

function consentMatchesSnapshot(state: ProjectContextState): boolean {
  return (
    state.snapshot !== null &&
    state.consent !== null &&
    state.snapshot.project_id === state.projectId &&
    state.consent.snapshot_id === state.snapshot.snapshot_id &&
    state.consent.snapshot_sha256 === state.snapshot.snapshot_sha256
  );
}

function validateStateInvariants(
  state: ProjectContextState,
): ProjectContextState {
  switch (state.status) {
    case 'checking':
      if (
        state.activePreparationId === null ||
        state.snapshot !== null ||
        state.consent !== null ||
        state.staleReason !== null ||
        state.errorCode !== null
      ) {
        return invalid('$.status', 'checking state is inconsistent');
      }
      return state;
    case 'setup_required': {
      if (state.staleReason !== null || state.errorCode !== null) {
        return invalid('$.status', 'setup state is inconsistent');
      }
      const isInitial =
        state.activePreparationId === null &&
        state.snapshot === null &&
        state.consent === null;
      const isPrepared =
        state.activePreparationId !== null &&
        state.snapshot !== null &&
        state.snapshot.omitted.length === 0 &&
        state.consent === null;
      if (!isInitial && !isPrepared) {
        return invalid('$.status', 'setup state is inconsistent');
      }
      return state;
    }
    case 'ready':
      if (
        state.activePreparationId !== null ||
        state.snapshot === null ||
        state.snapshot.omitted.length !== 0 ||
        !consentMatchesSnapshot(state) ||
        state.staleReason !== null ||
        state.errorCode !== null
      ) {
        return invalid('$.status', 'ready state is inconsistent');
      }
      return state;
    case 'partial': {
      if (
        state.snapshot === null ||
        state.snapshot.omitted.length === 0 ||
        state.staleReason !== null ||
        state.errorCode !== null
      ) {
        return invalid('$.status', 'partial state is inconsistent');
      }
      const isPrepared =
        state.activePreparationId !== null && state.consent === null;
      const isConfirmed =
        state.activePreparationId === null && consentMatchesSnapshot(state);
      if (!isPrepared && !isConfirmed) {
        return invalid('$.status', 'partial state is inconsistent');
      }
      return state;
    }
    case 'stale':
      if (
        state.staleReason === null ||
        state.consent !== null ||
        state.activePreparationId !== null ||
        state.errorCode !== null
      ) {
        return invalid('$.status', 'stale state is inconsistent');
      }
      return state;
    case 'error':
      if (
        state.errorCode === null ||
        state.consent !== null ||
        state.activePreparationId !== null ||
        state.staleReason !== null
      ) {
        return invalid('$.status', 'error state is inconsistent');
      }
      return state;
    case 'unavailable':
      if (
        state.snapshot !== null ||
        state.consent !== null ||
        state.activePreparationId !== null ||
        state.staleReason !== null ||
        state.errorCode !== null
      ) {
        return invalid('$.status', 'unavailable state is inconsistent');
      }
      return state;
  }
}

export function hydrateProjectContextState(input: unknown): ProjectContextState {
  const raw = exactRecord(decode(input), '$', persistedKeys);
  if (raw.schema_version !== PROJECT_CONTEXT_SCHEMA_VERSION) {
    return invalid('$.schema_version', 'must equal 1');
  }
  const status = enumValue<ProjectContextStatus>(raw.status, '$.status', statuses);
  const staleReason =
    raw.stale_reason === null
      ? null
      : enumValue<ProjectContextStaleReason>(
          raw.stale_reason,
          '$.stale_reason',
          staleReasons,
        );
  const errorCode =
    raw.error_code === null
      ? null
      : enumValue<ProjectContextErrorCode>(
          raw.error_code,
          '$.error_code',
          errorCodes,
        );
  const projectId = nonEmptyString(raw.project_id, '$.project_id');
  const activePreparationId =
    raw.active_preparation_id === null
      ? null
      : nonEmptyString(
          raw.active_preparation_id,
          '$.active_preparation_id',
        );
  const snapshot = manifest(raw.manifest);
  const consentReceipt = consent(raw.consent);
  if (snapshot !== null && snapshot.project_id !== projectId) {
    return invalid('$.manifest.project_id', 'must match $.project_id');
  }
  if (consentReceipt !== null && snapshot === null) {
    return invalid('$.consent', 'requires a manifest');
  }
  if (
    consentReceipt !== null &&
    snapshot !== null &&
    consentReceipt.snapshot_id !== snapshot.snapshot_id
  ) {
    return invalid('$.consent.snapshot_id', 'must match the manifest');
  }
  if (
    consentReceipt !== null &&
    snapshot !== null &&
    consentReceipt.snapshot_sha256 !== snapshot.snapshot_sha256
  ) {
    return invalid('$.consent.snapshot_sha256', 'must match the manifest');
  }
  return validateStateInvariants({
    schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION,
    projectId,
    status,
    selectedPaths: selectedPaths(raw.selected_paths),
    activePreparationId,
    snapshot,
    consent: consentReceipt,
    staleReason,
    errorCode,
  });
}

export function serializeProjectContextState(
  state: ProjectContextState,
): string {
  const persisted: PersistedProjectContextStateV1 = {
    schema_version: PROJECT_CONTEXT_SCHEMA_VERSION,
    project_id: state.projectId,
    status: state.status,
    selected_paths: selectedPaths(state.selectedPaths),
    active_preparation_id: state.activePreparationId,
    manifest: state.snapshot,
    consent: state.consent,
    stale_reason: state.staleReason,
    error_code: state.errorCode,
  };
  const validated = validateStateInvariants(
    hydrateProjectContextState(persisted),
  );
  const sanitized: PersistedProjectContextStateV1 = {
    schema_version: PROJECT_CONTEXT_SCHEMA_VERSION,
    project_id: validated.projectId,
    status: validated.status,
    selected_paths: validated.selectedPaths,
    active_preparation_id: validated.activePreparationId,
    manifest: validated.snapshot,
    consent: validated.consent,
    stale_reason: validated.staleReason,
    error_code: validated.errorCode,
  };
  return safeEncodeJSON(sanitized);
}

function durableUtf8Bytes(value: string): number | null {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) {
      bytes += 1;
    } else if (unit <= 0x7ff) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return null;
      bytes += 4;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return null;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function durableBoundedUtf8(value: string, maximum: number): boolean {
  const bytes = durableUtf8Bytes(value);
  return bytes !== null && bytes > 0 && bytes <= maximum;
}

function durableHasControlCharacter(
  value: string,
  includeSpace = false,
): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (
      unit <= (includeSpace ? 0x20 : 0x1f) ||
      (unit >= 0x7f && unit <= 0x9f)
    ) {
      return true;
    }
  }
  return false;
}

function durableSafePath(value: string): boolean {
  return (
    durableBoundedUtf8(value, 4096) &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !durableHasControlCharacter(value) &&
    !value
      .split('/')
      .some(component =>
        component === '' || component === '.' || component === '..'
      )
  );
}

function durableSafeProjectName(value: string): boolean {
  return (
    durableBoundedUtf8(value, 120) &&
    value.trim() === value &&
    !durableHasControlCharacter(value) &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..'
  );
}

function durableSafeBranch(value: string | null): boolean {
  if (value === null) return true;
  return (
    durableBoundedUtf8(value, 1024) &&
    value !== '@' &&
    !durableHasControlCharacter(value, true) &&
    !['~', '^', ':', '?', '*', '[', '\\'].some(character =>
      value.includes(character),
    ) &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.startsWith('.') &&
    !value.endsWith('.') &&
    !value
      .split('/')
      .some(
        component =>
          component === '' ||
          component.startsWith('.') ||
          component.endsWith('.lock'),
      )
  );
}

function durableTimestamp(value: string): boolean {
  return durableBoundedUtf8(value, 64) && Number.isFinite(Date.parse(value));
}

function durableInteger(value: number, maximum: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= 0 &&
    value <= maximum
  );
}

function durableCanonicalId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
    value,
  );
}

/**
 * Strict metadata-only state accepted by chat schema v6 before live mutation.
 * This is deliberately stronger than the portable project-context codec.
 */
export function canonicalizeDurableProjectContextState(
  state: ProjectContextState,
): ProjectContextState {
  const normalized = hydrateProjectContextState(
    serializeProjectContextState(state),
  );
  if (
    !durableCanonicalId(normalized.projectId) ||
    normalized.selectedPaths.length > 5000 ||
    normalized.selectedPaths.some(
      (path, index) =>
        !durableSafePath(path) ||
        (index > 0 && normalized.selectedPaths[index - 1]! >= path),
    )
  ) {
    return invalid('$', 'violates the durable context contract');
  }
  const durableManifest = normalized.snapshot;
  if (durableManifest === null) return normalized;
  if (
    !durableCanonicalId(durableManifest.snapshot_id) ||
    durableManifest.project_id !== normalized.projectId ||
    !durableSafeProjectName(durableManifest.project_name) ||
    !durableSafeBranch(durableManifest.branch) ||
    (durableManifest.clean && durableManifest.conflicted) ||
    !durableTimestamp(durableManifest.captured_at) ||
    durableManifest.policy_version !== 'chat-read-v1.0.0' ||
    durableManifest.included.length > 32 ||
    durableManifest.omitted.length > 5000 ||
    !durableInteger(durableManifest.context_bytes, 256 * 1024) ||
    durableManifest.context_bytes < 1 ||
    !durableInteger(durableManifest.estimated_tokens, 65_536) ||
    durableManifest.estimated_tokens !==
      Math.floor((durableManifest.context_bytes + 3) / 4)
  ) {
    return invalid('$.manifest', 'violates the durable context contract');
  }
  const included = new Set<string>();
  for (let index = 0; index < durableManifest.included.length; index += 1) {
    const item = durableManifest.included[index]!;
    const identity = `${item.path}\n${item.source}`;
    if (
      !durableSafePath(item.path) ||
      !durableInteger(item.bytes, 256 * 1024) ||
      included.has(identity)
    ) {
      return invalid(
        `$.manifest.included[${index}]`,
        'violates the durable context contract',
      );
    }
    included.add(identity);
  }
  const omitted = new Set<string>();
  for (let index = 0; index < durableManifest.omitted.length; index += 1) {
    const item = durableManifest.omitted[index]!;
    const identity = `${item.path}\n${item.reason}`;
    if (!durableSafePath(item.path) || omitted.has(identity)) {
      return invalid(
        `$.manifest.omitted[${index}]`,
        'violates the durable context contract',
      );
    }
    omitted.add(identity);
  }
  const consentReceipt = normalized.consent;
  if (
    consentReceipt !== null &&
    (!durableCanonicalId(consentReceipt.consent_receipt_id) ||
      !durableCanonicalId(consentReceipt.snapshot_id) ||
      consentReceipt.snapshot_id !== durableManifest.snapshot_id ||
      consentReceipt.snapshot_sha256 !== durableManifest.snapshot_sha256 ||
      !durableTimestamp(consentReceipt.confirmed_at) ||
      Date.parse(consentReceipt.confirmed_at) <
        Date.parse(durableManifest.captured_at))
  ) {
    return invalid('$.consent', 'violates the durable context contract');
  }
  return normalized;
}

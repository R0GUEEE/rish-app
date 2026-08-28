import { NativeModules } from 'react-native';

import {
  PROJECT_CONTEXT_BRIDGE_ERROR_CODES,
  PROJECT_CONTEXT_ERROR_CODES,
  PROJECT_CONTEXT_OMISSION_REASONS,
  type ProjectContextBridgeErrorCode,
  type ProjectContextCandidatePageV1,
  type ProjectContextConsentV1,
  type ProjectContextDiscardResultV1,
  type ProjectContextIncludedItemV1,
  type ProjectContextInspectionV1,
  type ProjectContextManifestV1,
  type ProjectContextOmissionReason,
  type ProjectContextSelectionV1,
} from '../project-context/types';
import type { DeepSeekModelId } from './LocalRuntime';

type UnknownRecord = Record<string, unknown>;

type NativeLocalProjectContext = {
  listProjectContextCandidates(
    projectId: string,
    query: string,
    cursor: string | null,
  ): Promise<unknown>;
  prepareProjectContext(selection: ProjectContextSelectionV1): Promise<unknown>;
  confirmProjectContext(snapshotId: string): Promise<unknown>;
  inspectProjectContext(snapshotId: string): Promise<unknown>;
  discardProjectContext(snapshotId: string): Promise<unknown>;
};

const objectPrototype = Object.prototype;
const arrayPrototype = Array.prototype;
const arrayMap = Array.prototype.map;
const knownCodes: ReadonlySet<string> = new Set([
  ...PROJECT_CONTEXT_ERROR_CODES,
  ...PROJECT_CONTEXT_BRIDGE_ERROR_CODES,
]);
const omissionReasons: ReadonlySet<string> = new Set(
  PROJECT_CONTEXT_OMISSION_REASONS,
);
const models: ReadonlySet<string> = new Set([
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash-vision-exp',
]);
const gitStates: ReadonlySet<string> = new Set([
  'unchanged',
  'staged',
  'unstaged',
  'conflicted',
]);
const sources: ReadonlySet<string> = new Set([
  'tracked_file',
  'staged_diff',
  'worktree_diff',
]);

const selectionKeys = new Set([
  'schema_version',
  'project_id',
  'conversation_id',
  'provider',
  'model',
  'policy',
  'selected_paths',
]);
const pageKeys = new Set([
  'schema_version',
  'project_id',
  'candidates',
  'next_cursor',
]);
const candidateKeys = new Set([
  'path',
  'size',
  'revision',
  'git_state',
  'eligible',
  'omission_reason',
]);
const manifestKeys = new Set([
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
const includedKeys = new Set(['path', 'source', 'bytes', 'sha256']);
const omittedKeys = new Set(['path', 'reason']);
const consentKeys = new Set([
  'schema_version',
  'consent_receipt_id',
  'snapshot_id',
  'snapshot_sha256',
  'confirmed_at',
]);
const inspectionKeys = new Set(['schema_version', 'state', 'manifest']);
const discardKeys = new Set(['schema_version', 'status']);

export class ProjectContextBridgeError extends Error {
  readonly code: ProjectContextBridgeErrorCode;

  constructor(code: ProjectContextBridgeErrorCode) {
    super(code);
    this.name = 'ProjectContextBridgeError';
    this.code = code;
  }
}

function fail(code: ProjectContextBridgeErrorCode): never {
  throw new ProjectContextBridgeError(code);
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

function exactRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  code: ProjectContextBridgeErrorCode,
): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== objectPrototype && prototype !== null) fail(code);
  if (Object.getOwnPropertySymbols(value).length > 0) fail(code);
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.size || names.some(name => !keys.has(name))) {
    fail(code);
  }
  const output = Object.create(null) as UnknownRecord;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      descriptor.enumerable !== true
    ) {
      fail(code);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function strictArray(
  value: unknown,
  maximum: number,
  code: ProjectContextBridgeErrorCode,
): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== arrayPrototype) {
    return fail(code);
  }
  const mapDescriptor = Object.getOwnPropertyDescriptor(arrayPrototype, 'map');
  if (
    mapDescriptor?.value !== arrayMap ||
    Object.getPrototypeOf(arrayPrototype) !== objectPrototype ||
    Object.prototype.hasOwnProperty.call(arrayPrototype, 'toJSON') ||
    Object.prototype.hasOwnProperty.call(objectPrototype, 'toJSON') ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    fail(code);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximum
  ) {
    fail(code);
  }
  const length = lengthDescriptor.value as number;
  const allowed = new Set(['length']);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    allowed.add(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      descriptor.enumerable !== true
    ) {
      fail(code);
    }
    result[index] = descriptor.value;
  }
  if (Object.getOwnPropertyNames(value).some(name => !allowed.has(name))) {
    fail(code);
  }
  return result;
}

function boundedString(
  value: unknown,
  maximumBytes: number,
  allowEmpty = false,
): string | null {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    return null;
  }
  const bytes = utf8Bytes(value);
  return bytes !== null && bytes <= maximumBytes ? value : null;
}

function hasControlCharacter(value: string, includeSpace = false): boolean {
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

function nonNegativeInteger(value: unknown, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= 0 &&
    value <= maximum
  );
}

function canonicalUUID(value: unknown): value is string {
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
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

function safePath(value: unknown): string | null {
  const path = boundedString(value, 4096);
  if (
    path === null ||
    path.startsWith('/') ||
    path.includes('\\') ||
    hasControlCharacter(path)
  ) {
    return null;
  }
  const components = path.split('/');
  return components.some(part => part === '' || part === '.' || part === '..')
    ? null
    : path;
}

function projectName(value: unknown): string | null {
  const name = boundedString(value, 120);
  if (
    name === null ||
    name.trim() !== name ||
    hasControlCharacter(name) ||
    name.includes('/') ||
    name.includes('\\') ||
    name === '.' ||
    name === '..'
  ) {
    return null;
  }
  return name;
}

function gitBranch(value: unknown): string | null {
  if (value === null) return null;
  const branch = boundedString(value, 1024);
  if (
    branch === null ||
    branch === '@' ||
    hasControlCharacter(branch, true) ||
    ['~', '^', ':', '?', '*', '[', '\\'].some(character =>
      branch.includes(character),
    ) ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.startsWith('.') ||
    branch.endsWith('.') ||
    branch.split('/').some(part => part === '' || part.startsWith('.') || part.endsWith('.lock'))
  ) {
    return null;
  }
  return branch;
}

function cursor(value: unknown): string | null {
  return value === null ||
    (typeof value === 'string' && /^[A-Za-z0-9_-]{98}$/u.test(value))
    ? (value as string | null)
    : fail('E_CONTEXT_RESULT_INVALID');
}

function projectSelection(value: unknown): ProjectContextSelectionV1 {
  const row = exactRecord(value, selectionKeys, 'E_CONTEXT_REQUEST_INVALID');
  if (
    row.schema_version !== 1 ||
    !canonicalUUID(row.project_id) ||
    !canonicalUUID(row.conversation_id) ||
    row.provider !== 'deepseek' ||
    typeof row.model !== 'string' ||
    !models.has(row.model) ||
    row.policy !== 'chat-read-v1'
  ) {
    fail('E_CONTEXT_REQUEST_INVALID');
  }
  const paths = strictArray(
    row.selected_paths,
    5000,
    'E_CONTEXT_REQUEST_INVALID',
  ).map(item => {
    const path = safePath(item);
    if (path === null) fail('E_CONTEXT_REQUEST_INVALID');
    return path;
  });
  const unique = new Set(paths);
  if (unique.size !== paths.length) fail('E_CONTEXT_REQUEST_INVALID');
  paths.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    schema_version: 1,
    project_id: row.project_id,
    conversation_id: row.conversation_id,
    provider: 'deepseek',
    model: row.model as DeepSeekModelId,
    policy: 'chat-read-v1',
    selected_paths: paths,
  };
}

function projectCandidate(value: unknown) {
  const row = exactRecord(value, candidateKeys, 'E_CONTEXT_RESULT_INVALID');
  const path = safePath(row.path);
  if (
    path === null ||
    !nonNegativeInteger(row.size, Number.MAX_SAFE_INTEGER) ||
    typeof row.revision !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(row.revision) ||
    typeof row.git_state !== 'string' ||
    !gitStates.has(row.git_state) ||
    typeof row.eligible !== 'boolean' ||
    (row.omission_reason !== null &&
      (typeof row.omission_reason !== 'string' ||
        !omissionReasons.has(row.omission_reason))) ||
    row.eligible !== (row.omission_reason === null)
  ) {
    fail('E_CONTEXT_RESULT_INVALID');
  }
  return {
    path,
    size: row.size,
    revision: row.revision,
    git_state: row.git_state as
      | 'unchanged'
      | 'staged'
      | 'unstaged'
      | 'conflicted',
    eligible: row.eligible,
    omission_reason: row.omission_reason as ProjectContextOmissionReason | null,
  };
}

function projectPage(
  value: unknown,
  projectId: string,
): ProjectContextCandidatePageV1 {
  const row = exactRecord(value, pageKeys, 'E_CONTEXT_RESULT_INVALID');
  if (row.schema_version !== 1 || row.project_id !== projectId) {
    fail('E_CONTEXT_RESULT_INVALID');
  }
  const candidates = strictArray(
    row.candidates,
    100,
    'E_CONTEXT_RESULT_INVALID',
  ).map(projectCandidate);
  if (new Set(candidates.map(item => item.path)).size !== candidates.length) {
    fail('E_CONTEXT_RESULT_INVALID');
  }
  return {
    schema_version: 1,
    project_id: projectId,
    candidates,
    next_cursor: cursor(row.next_cursor),
  };
}

function projectIncluded(value: unknown): ProjectContextIncludedItemV1 {
  const row = exactRecord(value, includedKeys, 'E_CONTEXT_RESULT_INVALID');
  const path = safePath(row.path);
  if (
    path === null ||
    typeof row.source !== 'string' ||
    !sources.has(row.source) ||
    !nonNegativeInteger(row.bytes, 256 * 1024) ||
    !digest(row.sha256)
  ) {
    fail('E_CONTEXT_RESULT_INVALID');
  }
  return {
    path,
    source: row.source as ProjectContextIncludedItemV1['source'],
    bytes: row.bytes,
    sha256: row.sha256,
  };
}

function projectManifest(
  value: unknown,
  correlation: {
    projectId?: string;
    snapshotId?: string;
    model?: DeepSeekModelId;
  } = {},
): ProjectContextManifestV1 {
  const row = exactRecord(value, manifestKeys, 'E_CONTEXT_RESULT_INVALID');
  const branch = gitBranch(row.branch);
  const name = projectName(row.project_name);
  if (
    row.schema_version !== 1 ||
    !canonicalUUID(row.snapshot_id) ||
    !canonicalUUID(row.project_id) ||
    name === null ||
    (row.branch !== null && branch === null) ||
    (row.head_oid !== null &&
      (typeof row.head_oid !== 'string' || !/^[0-9a-f]{40}$/u.test(row.head_oid))) ||
    typeof row.clean !== 'boolean' ||
    typeof row.conflicted !== 'boolean' ||
    (row.clean && row.conflicted) ||
    !timestamp(row.captured_at) ||
    row.policy_version !== 'chat-read-v1.0.0' ||
    row.provider_host !== 'api.deepseek.com' ||
    typeof row.model !== 'string' ||
    !models.has(row.model) ||
    !nonNegativeInteger(row.context_bytes, 256 * 1024) ||
    row.context_bytes < 1 ||
    !nonNegativeInteger(row.estimated_tokens, 65536) ||
    row.estimated_tokens !== Math.floor((row.context_bytes + 3) / 4) ||
    !digest(row.snapshot_sha256) ||
    !digest(row.source_fingerprint) ||
    (correlation.projectId !== undefined && row.project_id !== correlation.projectId) ||
    (correlation.snapshotId !== undefined && row.snapshot_id !== correlation.snapshotId) ||
    (correlation.model !== undefined && row.model !== correlation.model)
  ) {
    fail('E_CONTEXT_RESULT_INVALID');
  }
  const included = strictArray(
    row.included,
    32,
    'E_CONTEXT_RESULT_INVALID',
  ).map(projectIncluded);
  const includedIds = new Set(included.map(item => `${item.path}\n${item.source}`));
  if (includedIds.size !== included.length) fail('E_CONTEXT_RESULT_INVALID');
  const omitted = strictArray(
    row.omitted,
    5000,
    'E_CONTEXT_RESULT_INVALID',
  ).map(item => {
    const omittedRow = exactRecord(
      item,
      omittedKeys,
      'E_CONTEXT_RESULT_INVALID',
    );
    const path = safePath(omittedRow.path);
    if (
      path === null ||
      typeof omittedRow.reason !== 'string' ||
      !omissionReasons.has(omittedRow.reason)
    ) {
      fail('E_CONTEXT_RESULT_INVALID');
    }
    return {
      path,
      reason: omittedRow.reason as ProjectContextOmissionReason,
    };
  });
  const omittedIds = new Set(omitted.map(item => `${item.path}\n${item.reason}`));
  if (omittedIds.size !== omitted.length) fail('E_CONTEXT_RESULT_INVALID');
  return {
    schema_version: 1,
    snapshot_id: row.snapshot_id,
    project_id: row.project_id,
    project_name: name,
    branch,
    head_oid: row.head_oid as string | null,
    clean: row.clean,
    conflicted: row.conflicted,
    captured_at: row.captured_at,
    policy_version: 'chat-read-v1.0.0',
    provider_host: 'api.deepseek.com',
    model: row.model as DeepSeekModelId,
    included,
    omitted,
    context_bytes: row.context_bytes,
    estimated_tokens: row.estimated_tokens,
    snapshot_sha256: row.snapshot_sha256,
    source_fingerprint: row.source_fingerprint,
  };
}

function projectConsent(value: unknown, snapshotId: string): ProjectContextConsentV1 {
  const row = exactRecord(value, consentKeys, 'E_CONTEXT_RESULT_INVALID');
  if (
    row.schema_version !== 1 ||
    !canonicalUUID(row.consent_receipt_id) ||
    row.snapshot_id !== snapshotId ||
    !digest(row.snapshot_sha256) ||
    !timestamp(row.confirmed_at)
  ) {
    fail('E_CONTEXT_RESULT_INVALID');
  }
  return {
    schema_version: 1,
    consent_receipt_id: row.consent_receipt_id,
    snapshot_id: snapshotId,
    snapshot_sha256: row.snapshot_sha256,
    confirmed_at: row.confirmed_at,
  };
}

function projectInspection(
  value: unknown,
  snapshotId: string,
): ProjectContextInspectionV1 {
  const row = exactRecord(value, inspectionKeys, 'E_CONTEXT_RESULT_INVALID');
  if (
    row.schema_version !== 1 ||
    (row.state !== 'prepared' && row.state !== 'confirmed' && row.state !== 'stale')
  ) {
    fail('E_CONTEXT_RESULT_INVALID');
  }
  return {
    schema_version: 1,
    state: row.state,
    manifest: projectManifest(row.manifest, { snapshotId }),
  };
}

function projectDiscard(value: unknown): ProjectContextDiscardResultV1 {
  const row = exactRecord(value, discardKeys, 'E_CONTEXT_RESULT_INVALID');
  if (row.schema_version !== 1 || row.status !== 'discarded') {
    fail('E_CONTEXT_RESULT_INVALID');
  }
  return { schema_version: 1, status: 'discarded' };
}

function currentNative(): unknown {
  return (NativeModules as Record<string, unknown>).LocalProjectContext;
}

function hasCapabilities(value: unknown): value is NativeLocalProjectContext {
  try {
    if (typeof value !== 'object' || value === null) return false;
    const row = value as Partial<Record<keyof NativeLocalProjectContext, unknown>>;
    return (
      typeof row.listProjectContextCandidates === 'function' &&
      typeof row.prepareProjectContext === 'function' &&
      typeof row.confirmProjectContext === 'function' &&
      typeof row.inspectProjectContext === 'function' &&
      typeof row.discardProjectContext === 'function'
    );
  } catch {
    return false;
  }
}

function required(): NativeLocalProjectContext {
  let value: unknown;
  try {
    value = currentNative();
  } catch {
    return fail('E_CONTEXT_NATIVE');
  }
  if (!hasCapabilities(value)) fail('E_CONTEXT_NATIVE');
  return value;
}

function sanitize(error: unknown): ProjectContextBridgeError {
  try {
    if (typeof error === 'object' && error !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
      if (
        descriptor !== undefined &&
        'value' in descriptor &&
        typeof descriptor.value === 'string' &&
        knownCodes.has(descriptor.value)
      ) {
        return new ProjectContextBridgeError(
          descriptor.value as ProjectContextBridgeErrorCode,
        );
      }
    }
  } catch {
    // Hostile thrown values always collapse to the value-free native code.
  }
  return new ProjectContextBridgeError('E_CONTEXT_NATIVE');
}

async function boundary<T>(operation: () => Promise<unknown>, project: (raw: unknown) => T): Promise<T> {
  try {
    return project(await operation());
  } catch (error) {
    throw sanitize(error);
  }
}

export const LocalProjectContext = {
  isAvailable: () => {
    try {
      return hasCapabilities(currentNative());
    } catch {
      return false;
    }
  },
  listCandidates: async (
    projectIdValue: unknown,
    queryValue: unknown = '',
    cursorValue: unknown = null,
  ) => {
    try {
      if (!canonicalUUID(projectIdValue) ||
          typeof queryValue !== 'string' || queryValue.length > 256 ||
          utf8Bytes(queryValue) === null ||
          (cursorValue !== null &&
           (typeof cursorValue !== 'string' ||
            !/^[A-Za-z0-9_-]{98}$/u.test(cursorValue)))) {
        fail('E_CONTEXT_REQUEST_INVALID');
      }
      const projectId = projectIdValue;
      const query = queryValue;
      const nextCursor = cursorValue as string | null;
      return await boundary(
        () => required().listProjectContextCandidates(projectId, query, nextCursor),
        raw => projectPage(raw, projectId),
      );
    } catch (error) {
      throw sanitize(error);
    }
  },
  prepare: async (selectionValue: unknown) => {
    try {
      const selection = projectSelection(selectionValue);
      return await boundary(
        () => required().prepareProjectContext(selection),
        raw => projectManifest(raw, {
          projectId: selection.project_id,
          model: selection.model,
        }),
      );
    } catch (error) {
      throw sanitize(error);
    }
  },
  confirm: async (snapshotIdValue: unknown) => {
    try {
      if (!canonicalUUID(snapshotIdValue)) fail('E_CONTEXT_REQUEST_INVALID');
      const snapshotId = snapshotIdValue;
      return await boundary(
        () => required().confirmProjectContext(snapshotId),
        raw => projectConsent(raw, snapshotId),
      );
    } catch (error) {
      throw sanitize(error);
    }
  },
  inspect: async (snapshotIdValue: unknown) => {
    try {
      if (!canonicalUUID(snapshotIdValue)) fail('E_CONTEXT_REQUEST_INVALID');
      const snapshotId = snapshotIdValue;
      return await boundary(
        () => required().inspectProjectContext(snapshotId),
        raw => projectInspection(raw, snapshotId),
      );
    } catch (error) {
      throw sanitize(error);
    }
  },
  discard: async (snapshotIdValue: unknown) => {
    try {
      if (!canonicalUUID(snapshotIdValue)) fail('E_CONTEXT_REQUEST_INVALID');
      const snapshotId = snapshotIdValue;
      return await boundary(
        () => required().discardProjectContext(snapshotId),
        projectDiscard,
      );
    } catch (error) {
      throw sanitize(error);
    }
  },
};

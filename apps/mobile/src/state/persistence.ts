import {
  ATTACHMENT_CHAT_STATE_SCHEMA_VERSION,
  ATTEMPT_CONTEXT_DISPOSITIONS,
  ATTEMPT_PROJECT_CONTEXT_SCHEMA_VERSION,
  ATTACHMENT_DESCRIPTOR_SCHEMA_VERSION,
  CHAT_STATE_SCHEMA_VERSION,
  COMPLETION_FINISH_REASONS,
  COMPLETION_ROUND_RECEIPT_SCHEMA_VERSION,
  CONVERSATION_TURN_SCHEMA_VERSION,
  LEGACY_CHAT_STATE_SCHEMA_VERSION,
  OLDER_CHAT_STATE_SCHEMA_VERSION,
  PREVIOUS_CHAT_STATE_SCHEMA_VERSION,
  WORKSPACE_CHAT_STATE_SCHEMA_VERSION,
  PROJECT_CONTEXT_DESTRUCTIVE_ACTIONS,
  PROJECT_CONTEXT_DESTRUCTIVE_PHASES,
  PROJECT_CONTEXT_DESTRUCTIVE_TRANSITION_SCHEMA_VERSION,
  TURN_ATTEMPT_SCHEMA_VERSION,
  TURN_ATTEMPT_STATUSES,
  ChatStateValidationError,
  type ChatAttachment,
  type ChatMessage,
  type ChatMessageMetadata,
  type ChatState,
  type CompletionRoundReceiptV1,
  type Conversation,
  type ConversationTurnV1,
  type HydrationResult,
  type PersistedChatAttachmentV1,
  type PersistedChatMessageV4,
  type PersistedChatStateV7,
  type PersistedCompletionRoundReceiptV1,
  type PersistedConversationTurnV1,
  type PersistedTurnAttemptV1,
  type TurnAttemptStatus,
  type AttemptContextDisposition,
  type TurnAttemptV1,
  type ProjectContextDestructiveTransitionV1,
} from './types';
import {
  DEFAULT_THINKING_MODE,
  MAX_ATTACHMENT_ID_LENGTH,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TOTAL_ATTACHMENT_SIZE,
  MAX_ATTEMPT_VISIBLE_MESSAGES,
  MAX_ATTEMPT_ATTACHMENT_IDS,
  MAX_PROJECT_CONTEXT_RECEIPT_BYTES,
  MAX_COMPLETION_ROUNDS,
  isAttemptFailureCode,
  isCanonicalTimestamp,
  isCanonicalLifecycleId,
  isAttachmentMimeType,
  isAttachmentSize,
  isChatAttachmentKind,
  isConversationThinkingMode,
  isModelId,
  isProjectId,
  isSha256Digest,
  isWorkspaceId,
  orderConversationIds,
  selectActiveMessages,
  hasProjectContextDestructiveReferences,
} from './reducer';
import {
  createProjectContextState,
  isProjectContextSendable,
} from '../project-context/reducer';
import {
  hydrateProjectContextState,
  serializeProjectContextState,
} from '../project-context/persistence';
import type { ProjectContextState } from '../project-context/types';

const MAX_CONVERSATIONS = 10_000;
const MAX_MESSAGES_PER_CONVERSATION = 100_000;
const MAX_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 1_000_000;
const MAX_TURNS_PER_CONVERSATION = 100_000;
const MAX_ATTEMPTS_PER_CONVERSATION = 100_000;
const MAX_ATTEMPT_MESSAGE_REFERENCES = 1_000_000;
const MAX_OPAQUE_ID_LENGTH = 128;
const finishReasons: ReadonlySet<string> = new Set(COMPLETION_FINISH_REASONS);
const attemptStatuses: ReadonlySet<string> = new Set(TURN_ATTEMPT_STATUSES);
const contextDispositions: ReadonlySet<string> = new Set(
  ATTEMPT_CONTEXT_DISPOSITIONS,
);
const destructiveActions: ReadonlySet<string> = new Set(
  PROJECT_CONTEXT_DESTRUCTIVE_ACTIONS,
);
const destructivePhases: ReadonlySet<string> = new Set(
  PROJECT_CONTEXT_DESTRUCTIVE_PHASES,
);
const opaqueIdPattern = /^[A-Za-z0-9._:-]+$/u;

type PersistedSchemaVersion =
  | typeof LEGACY_CHAT_STATE_SCHEMA_VERSION
  | typeof OLDER_CHAT_STATE_SCHEMA_VERSION
  | typeof ATTACHMENT_CHAT_STATE_SCHEMA_VERSION
  | typeof WORKSPACE_CHAT_STATE_SCHEMA_VERSION
  | typeof PREVIOUS_CHAT_STATE_SCHEMA_VERSION
  | typeof CHAT_STATE_SCHEMA_VERSION;

function hasWorkspaceShape(schemaVersion: PersistedSchemaVersion): boolean {
  return (
    schemaVersion === WORKSPACE_CHAT_STATE_SCHEMA_VERSION ||
    schemaVersion === PREVIOUS_CHAT_STATE_SCHEMA_VERSION ||
    schemaVersion === CHAT_STATE_SCHEMA_VERSION
  );
}

function hasProjectContextShape(
  schemaVersion: PersistedSchemaVersion,
): boolean {
  return (
    schemaVersion === PREVIOUS_CHAT_STATE_SCHEMA_VERSION ||
    schemaVersion === CHAT_STATE_SCHEMA_VERSION
  );
}

type UnknownRecord = Record<string, unknown>;

function invalid(path: string, message: string): never {
  throw new ChatStateValidationError(path, message);
}

function record(value: unknown, path: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(path, 'must be an object');
  }
  return value as UnknownRecord;
}

function exactRecord(
  value: unknown,
  path: string,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(path, 'must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(path, 'must be a plain record');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return invalid(path, 'must not contain symbol properties');
  }
  const allowed = new Set(keys);
  const optional = new Set(optionalKeys);
  Object.getOwnPropertyNames(value).forEach(key => {
    if (!allowed.has(key)) invalid(`${path}.${key}`, 'is not recognized');
  });
  const raw = Object.create(null) as UnknownRecord;
  keys.forEach(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      if (optional.has(key)) return;
      invalid(`${path}.${key}`, 'is required');
    }
    if (
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      descriptor.enumerable !== true
    ) {
      invalid(`${path}.${key}`, 'must be an own data property');
    }
    raw[key] = descriptor.value;
  });
  return raw;
}

function array(
  value: unknown,
  path: string,
  maximumLength: number,
): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return invalid(path, 'must be an array');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximumLength
  ) {
    return invalid(path, 'exceeds the array limit');
  }
  const length = lengthDescriptor.value as number;
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return invalid(path, 'must not contain symbol properties');
  }
  const names = Object.getOwnPropertyNames(value);
  const allowed = new Set<string>(['length']);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    allowed.add(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      descriptor.enumerable !== true
    ) {
      return invalid(`${path}[${index}]`, 'must be a dense data array');
    }
    result[index] = descriptor.value;
  }
  names.forEach(name => {
    if (!allowed.has(name)) invalid(`${path}.${name}`, 'is not recognized');
  });
  return result;
}

function boundedString(
  value: unknown,
  path: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string') {
    return invalid(path, 'must be a string');
  }
  if (
    (!allowEmpty && value.trim().length === 0) ||
    value.length > maximumLength
  ) {
    return invalid(
      path,
      `must contain ${
        allowEmpty ? 'at most' : 'between 1 and'
      } ${maximumLength} characters`,
    );
  }
  return value;
}

function timestamp(value: unknown, path: string): string {
  if (!isCanonicalTimestamp(value)) {
    return invalid(path, 'must be a canonical ISO-8601 timestamp');
  }
  return value;
}

function canonicalLifecycleId(value: unknown, path: string): string {
  if (!isCanonicalLifecycleId(value)) {
    return invalid(path, 'must be a canonical lowercase UUID');
  }
  return value;
}

function sha256(value: unknown, path: string): string {
  if (!isSha256Digest(value)) {
    return invalid(path, 'must be a lowercase SHA-256 digest');
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return invalid(path, 'must be a non-negative safe integer');
  }
  return value;
}

function lifecycleEpoch(
  value: unknown,
  path: string,
  allowZero: boolean,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < (allowZero ? 0 : 1)
  ) {
    return invalid(
      path,
      allowZero
        ? 'must be a non-negative safe integer without negative zero'
        : 'must be a positive safe integer',
    );
  }
  return value;
}

function parseDestructiveTransition(
  value: unknown,
  path: string,
): ProjectContextDestructiveTransitionV1 {
  const raw = exactRecord(value, path, [
    'schema_version',
    'lifecycle_id',
    'epoch',
    'action',
    'phase',
    'conversation_id',
    'source_project_id',
    'source_runtime_context_id',
    'source_model_id',
    'snapshot_id',
    'snapshot_sha256',
    'consent_receipt_id',
    'target_project_id',
    'created_at',
    'updated_at',
  ]);
  if (
    raw.schema_version !==
    PROJECT_CONTEXT_DESTRUCTIVE_TRANSITION_SCHEMA_VERSION
  ) {
    return invalid(`${path}.schema_version`, 'must equal 1');
  }
  if (
    typeof raw.action !== 'string' ||
    !destructiveActions.has(raw.action)
  ) {
    return invalid(`${path}.action`, 'is not a supported destructive action');
  }
  if (
    typeof raw.phase !== 'string' ||
    !destructivePhases.has(raw.phase)
  ) {
    return invalid(`${path}.phase`, 'is not a supported lifecycle phase');
  }
  if (!isProjectId(raw.source_project_id)) {
    return invalid(`${path}.source_project_id`, 'must be a valid project id');
  }
  if (!isModelId(raw.source_model_id)) {
    return invalid(`${path}.source_model_id`, 'must be a supported model');
  }
  const sourceRuntimeContextId =
    raw.source_runtime_context_id === null
      ? null
      : canonicalLifecycleId(
          raw.source_runtime_context_id,
          `${path}.source_runtime_context_id`,
        );
  const consentReceiptId =
    raw.consent_receipt_id === null
      ? null
      : canonicalLifecycleId(
          raw.consent_receipt_id,
          `${path}.consent_receipt_id`,
        );
  const targetProjectId =
    raw.target_project_id === null ? null : raw.target_project_id;
  if (targetProjectId !== null && !isProjectId(targetProjectId)) {
    return invalid(
      `${path}.target_project_id`,
      'must be a valid project id or null',
    );
  }
  if (
    (raw.action === 'rebind') !== (targetProjectId !== null) ||
    (raw.action === 'rebind' && targetProjectId === raw.source_project_id)
  ) {
    return invalid(
      `${path}.target_project_id`,
      'must be a distinct project only for rebind',
    );
  }
  const createdAt = timestamp(raw.created_at, `${path}.created_at`);
  const updatedAt = timestamp(raw.updated_at, `${path}.updated_at`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    return invalid(`${path}.updated_at`, 'must not precede created_at');
  }
  return {
    schemaVersion: PROJECT_CONTEXT_DESTRUCTIVE_TRANSITION_SCHEMA_VERSION,
    lifecycleId: canonicalLifecycleId(
      raw.lifecycle_id,
      `${path}.lifecycle_id`,
    ),
    epoch: lifecycleEpoch(raw.epoch, `${path}.epoch`, false),
    action: raw.action as ProjectContextDestructiveTransitionV1['action'],
    phase: raw.phase as ProjectContextDestructiveTransitionV1['phase'],
    conversationId: boundedString(
      raw.conversation_id,
      `${path}.conversation_id`,
      MAX_ID_LENGTH,
    ),
    sourceProjectId: raw.source_project_id,
    sourceRuntimeContextId,
    sourceModelId: raw.source_model_id,
    snapshotId: canonicalLifecycleId(
      raw.snapshot_id,
      `${path}.snapshot_id`,
    ),
    snapshotSha256: sha256(
      raw.snapshot_sha256,
      `${path}.snapshot_sha256`,
    ),
    consentReceiptId,
    targetProjectId,
    createdAt,
    updatedAt,
  };
}

function opaqueProviderId(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_OPAQUE_ID_LENGTH ||
    !opaqueIdPattern.test(value)
  ) {
    return invalid(path, 'must be a bounded opaque provider identifier');
  }
  return value;
}

function uniqueStringArray(
  value: unknown,
  path: string,
  maximum: number,
  canonicalIds = false,
): string[] {
  const raw = array(value, path, maximum);
  if (raw.length > maximum) {
    return invalid(path, `must contain no more than ${maximum} entries`);
  }
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const parsed = canonicalIds
      ? canonicalLifecycleId(entry, entryPath)
      : boundedString(entry, entryPath, MAX_ID_LENGTH);
    if (seen.has(parsed)) return invalid(entryPath, 'must be unique');
    seen.add(parsed);
    return parsed;
  });
}

function utf8ByteLength(value: string): number | null {
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

function boundedUtf8(value: string, maximum: number): boolean {
  const bytes = utf8ByteLength(value);
  return bytes !== null && bytes > 0 && bytes <= maximum;
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

function safeProjectPath(value: string): boolean {
  if (
    !boundedUtf8(value, 4096) ||
    value.startsWith('/') ||
    value.includes('\\') ||
    hasControlCharacter(value)
  ) {
    return false;
  }
  return !value
    .split('/')
    .some(component =>
      component === '' || component === '.' || component === '..'
    );
}

function safeProjectName(value: string): boolean {
  return (
    boundedUtf8(value, 120) &&
    value.trim() === value &&
    !hasControlCharacter(value) &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..'
  );
}

function safeGitBranch(value: string | null): boolean {
  if (value === null) return true;
  return (
    boundedUtf8(value, 1024) &&
    value !== '@' &&
    !hasControlCharacter(value, true) &&
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

function strictProjectTimestamp(value: string): boolean {
  return (
    boundedUtf8(value, 64) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

function strictNonNegativeInteger(value: number, maximum: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= 0 &&
    value <= maximum
  );
}

function preflightArrayCap(
  value: unknown,
  maximum: number,
  path: string,
): void {
  if (!Array.isArray(value)) {
    invalid(path, 'must be an array');
  }
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximum
  ) {
    invalid(path, 'exceeds the array limit');
  }
}

function ownDataValue(
  value: object,
  key: string,
  path: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
    descriptor.enumerable !== true
  ) {
    return invalid(path, 'must be an enumerable own data property');
  }
  return descriptor.value;
}

function preflightV6ProjectContext(
  persistedValue: unknown,
  path: string,
): void {
  const persisted = record(persistedValue, path);
  preflightArrayCap(
    ownDataValue(persisted, 'selected_paths', `${path}.selected_paths`),
    5000,
    `${path}.selected_paths`,
  );
  const manifestValue = ownDataValue(
    persisted,
    'manifest',
    `${path}.manifest`,
  );
  if (manifestValue === null) return;
  const manifest = record(manifestValue, `${path}.manifest`);
  preflightArrayCap(
    ownDataValue(manifest, 'included', `${path}.manifest.included`),
    32,
    `${path}.manifest.included`,
  );
  preflightArrayCap(
    ownDataValue(manifest, 'omitted', `${path}.manifest.omitted`),
    5000,
    `${path}.manifest.omitted`,
  );
}

function validateV6ProjectContext(
  state: ProjectContextState,
  persistedValue: unknown,
  path: string,
): ProjectContextState {
  const persisted = record(persistedValue, path);
  const selected = array(
    ownDataValue(persisted, 'selected_paths', `${path}.selected_paths`),
    `${path}.selected_paths`,
    5000,
  );
  if (selected.length > 5000) {
    return invalid(`${path}.selected_paths`, 'exceeds the path limit');
  }
  const selectedPaths: string[] = [];
  selected.forEach((entry, index) => {
    if (typeof entry !== 'string' || !safeProjectPath(entry)) {
      invalid(`${path}.selected_paths[${index}]`, 'is not a safe path');
    }
    if (index > 0 && selectedPaths[index - 1]! >= entry) {
      invalid(
        `${path}.selected_paths[${index}]`,
        'must be strictly ordered and unique',
      );
    }
    selectedPaths[index] = entry;
  });
  if (
    state.selectedPaths.length !== selectedPaths.length ||
    !state.selectedPaths.every(
      (selectedPath, index) => selectedPath === selectedPaths[index],
    )
  ) {
    return invalid(`${path}.selected_paths`, 'must be canonical');
  }

  const manifest = state.snapshot;
  if (manifest === null) return state;
  if (
    !isCanonicalLifecycleId(state.projectId) ||
    !isCanonicalLifecycleId(manifest.snapshot_id) ||
    manifest.project_id !== state.projectId ||
    !safeProjectName(manifest.project_name) ||
    !safeGitBranch(manifest.branch) ||
    (manifest.clean && manifest.conflicted) ||
    !strictProjectTimestamp(manifest.captured_at) ||
    manifest.policy_version !== 'chat-read-v1.0.0' ||
    manifest.included.length > 32 ||
    manifest.omitted.length > 5000 ||
    !strictNonNegativeInteger(manifest.context_bytes, 256 * 1024) ||
    manifest.context_bytes < 1 ||
    !strictNonNegativeInteger(manifest.estimated_tokens, 65_536) ||
    manifest.estimated_tokens !==
      Math.floor((manifest.context_bytes + 3) / 4)
  ) {
    return invalid(`${path}.manifest`, 'violates the v6 context contract');
  }
  const includedIdentities = new Set<string>();
  manifest.included.forEach((item, index) => {
    const identity = `${item.path}\n${item.source}`;
    if (
      !safeProjectPath(item.path) ||
      !strictNonNegativeInteger(item.bytes, 256 * 1024) ||
      !isSha256Digest(item.sha256) ||
      includedIdentities.has(identity)
    ) {
      invalid(
        `${path}.manifest.included[${index}]`,
        'violates the included-item contract',
      );
    }
    includedIdentities.add(identity);
  });
  const omittedIdentities = new Set<string>();
  manifest.omitted.forEach((item, index) => {
    const identity = `${item.path}\n${item.reason}`;
    if (!safeProjectPath(item.path) || omittedIdentities.has(identity)) {
      invalid(
        `${path}.manifest.omitted[${index}]`,
        'violates the omitted-item contract',
      );
    }
    omittedIdentities.add(identity);
  });
  const consent = state.consent;
  if (
    consent !== null &&
    (!isCanonicalLifecycleId(consent.consent_receipt_id) ||
      !isCanonicalLifecycleId(consent.snapshot_id) ||
      consent.snapshot_id !== manifest.snapshot_id ||
      consent.snapshot_sha256 !== manifest.snapshot_sha256 ||
      !strictProjectTimestamp(consent.confirmed_at) ||
      Date.parse(consent.confirmed_at) < Date.parse(manifest.captured_at))
  ) {
    return invalid(`${path}.consent`, 'violates the consent contract');
  }
  return state;
}

function parseMetadata(
  value: unknown,
  path: string,
  strict = false,
): ChatMessageMetadata {
  const raw = strict
    ? exactRecord(
        value,
        path,
        ['model_id', 'latency_ms', 'finish_reason', 'reasoning'],
        ['model_id', 'latency_ms', 'finish_reason', 'reasoning'],
      )
    : record(value, path);
  const metadata: {
    modelId?: ChatMessageMetadata['modelId'];
    latencyMs?: number;
    finishReason?: string;
    reasoning?: string;
  } = {};

  if (raw.model_id !== undefined) {
    if (!isModelId(raw.model_id)) {
      return invalid(`${path}.model_id`, 'is not a supported model');
    }
    metadata.modelId = raw.model_id;
  }
  if (raw.latency_ms !== undefined) {
    if (
      typeof raw.latency_ms !== 'number' ||
      !Number.isFinite(raw.latency_ms) ||
      raw.latency_ms < 0
    ) {
      return invalid(
        `${path}.latency_ms`,
        'must be a non-negative finite number',
      );
    }
    metadata.latencyMs = raw.latency_ms;
  }
  if (raw.finish_reason !== undefined) {
    metadata.finishReason = boundedString(
      raw.finish_reason,
      `${path}.finish_reason`,
      256,
    );
  }
  if (raw.reasoning !== undefined) {
    metadata.reasoning = boundedString(
      raw.reasoning,
      `${path}.reasoning`,
      MAX_MESSAGE_LENGTH,
    );
  }
  return metadata;
}

function parseAttachment(
  value: unknown,
  path: string,
  strict = false,
): ChatAttachment {
  const raw = strict
    ? exactRecord(value, path, [
        'schema_version',
        'id',
        'kind',
        'name',
        'mime_type',
        'size',
      ])
    : record(value, path);
  if (raw.schema_version !== ATTACHMENT_DESCRIPTOR_SCHEMA_VERSION) {
    return invalid(`${path}.schema_version`, 'must equal 1');
  }
  if (!isChatAttachmentKind(raw.kind)) {
    return invalid(`${path}.kind`, 'must be image, text, or pdf');
  }
  const id = boundedString(raw.id, `${path}.id`, MAX_ATTACHMENT_ID_LENGTH);
  const name = boundedString(
    raw.name,
    `${path}.name`,
    MAX_ATTACHMENT_NAME_LENGTH,
  );
  if (name.includes('\0')) {
    return invalid(`${path}.name`, 'must not contain null characters');
  }
  if (!isAttachmentMimeType(raw.mime_type, raw.kind)) {
    return invalid(
      `${path}.mime_type`,
      'must be a valid MIME type matching the attachment kind',
    );
  }
  if (!isAttachmentSize(raw.size, raw.kind)) {
    return invalid(
      `${path}.size`,
      'must be a positive safe integer within the attachment size limit',
    );
  }
  if (raw.thumbnail_data_url !== undefined) {
    return invalid(
      `${path}.thumbnail_data_url`,
      'must not be persisted in chat state',
    );
  }
  return {
    schema_version: ATTACHMENT_DESCRIPTOR_SCHEMA_VERSION,
    id,
    kind: raw.kind,
    name,
    mime_type: raw.mime_type,
    size: raw.size,
  };
}

function parseAttachments(
  value: unknown,
  path: string,
  strict = false,
): ChatAttachment[] {
  const raw = array(value, path, MAX_ATTACHMENTS_PER_MESSAGE);
  if (raw.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return invalid(
      path,
      `must contain no more than ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`,
    );
  }

  const ids = new Set<string>();
  let totalSize = 0;
  return raw.map((entry, index) => {
    const attachment = parseAttachment(
      entry,
      `${path}[${index}]`,
      strict,
    );
    if (ids.has(attachment.id)) {
      return invalid(
        `${path}[${index}].id`,
        'must be unique within the message',
      );
    }
    ids.add(attachment.id);
    totalSize += attachment.size;
    if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
      return invalid(path, 'exceeds the total attachment size limit');
    }
    return attachment;
  });
}

function parseMessage(
  value: unknown,
  path: string,
  schemaVersion: PersistedSchemaVersion,
): ChatMessage {
  const strict = hasProjectContextShape(schemaVersion);
  const raw = strict
    ? exactRecord(
        value,
        path,
        ['id', 'role', 'text', 'created_at', 'attachments', 'metadata'],
        ['metadata'],
      )
    : record(value, path);
  const role = raw.role;
  if (role !== 'user' && role !== 'assistant') {
    return invalid(`${path}.role`, 'must be user or assistant');
  }

  const metadata =
    raw.metadata === undefined
      ? undefined
      : parseMetadata(raw.metadata, `${path}.metadata`, strict);
  const attachments =
    schemaVersion === LEGACY_CHAT_STATE_SCHEMA_VERSION ||
    schemaVersion === OLDER_CHAT_STATE_SCHEMA_VERSION
      ? []
      : parseAttachments(raw.attachments, `${path}.attachments`, strict);
  const text = boundedString(
    raw.text,
    `${path}.text`,
    MAX_MESSAGE_LENGTH,
    true,
  );
  if (
    text.trim().length === 0 &&
    (role === 'assistant' || attachments.length === 0)
  ) {
    return invalid(
      `${path}.text`,
      role === 'assistant'
        ? 'must not be empty for assistant messages'
        : 'must not be empty when the user message has no attachments',
    );
  }
  return {
    id: boundedString(raw.id, `${path}.id`, MAX_ID_LENGTH),
    role,
    text,
    createdAt: timestamp(raw.created_at, `${path}.created_at`),
    attachments,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function parseMessages(
  value: unknown,
  path: string,
  schemaVersion: PersistedSchemaVersion,
): ChatMessage[] {
  const raw = array(value, path, MAX_MESSAGES_PER_CONVERSATION);
  if (raw.length > MAX_MESSAGES_PER_CONVERSATION) {
    return invalid(
      path,
      `must contain no more than ${MAX_MESSAGES_PER_CONVERSATION} messages`,
    );
  }

  const ids = new Set<string>();
  return raw.map((entry, index) => {
    const message = parseMessage(entry, `${path}[${index}]`, schemaVersion);
    if (ids.has(message.id)) {
      return invalid(
        `${path}[${index}].id`,
        'must be unique within the conversation',
      );
    }
    ids.add(message.id);
    return message;
  });
}

function parseAttemptProjectContext(
  value: unknown,
  path: string,
): TurnAttemptV1['projectContext'] {
  if (value === null) return null;
  const raw = exactRecord(value, path, [
    'schema_version',
    'runtime_context_id',
    'project_id',
    'snapshot_id',
    'snapshot_sha256',
    'source_fingerprint',
    'context_bytes',
    'consent_receipt_id',
    'provider',
    'policy',
    'policy_version',
  ]);
  if (raw.schema_version !== ATTEMPT_PROJECT_CONTEXT_SCHEMA_VERSION) {
    return invalid(`${path}.schema_version`, 'must equal 1');
  }
  if (raw.provider !== 'deepseek') {
    return invalid(`${path}.provider`, 'must equal deepseek');
  }
  if (raw.policy !== 'chat-read-v1') {
    return invalid(`${path}.policy`, 'must equal chat-read-v1');
  }
  if (raw.policy_version !== 'chat-read-v1.0.0') {
    return invalid(
      `${path}.policy_version`,
      'must equal chat-read-v1.0.0',
    );
  }
  if (!isProjectId(raw.project_id)) {
    return invalid(`${path}.project_id`, 'must be a valid project id');
  }
  return {
    schemaVersion: ATTEMPT_PROJECT_CONTEXT_SCHEMA_VERSION,
    runtimeContextId: canonicalLifecycleId(
      raw.runtime_context_id,
      `${path}.runtime_context_id`,
    ),
    projectId: raw.project_id,
    snapshotId: canonicalLifecycleId(
      raw.snapshot_id,
      `${path}.snapshot_id`,
    ),
    snapshotSha256: sha256(
      raw.snapshot_sha256,
      `${path}.snapshot_sha256`,
    ),
    sourceFingerprint: sha256(
      raw.source_fingerprint,
      `${path}.source_fingerprint`,
    ),
    contextBytes: (() => {
      const contextBytes = nonNegativeSafeInteger(
        raw.context_bytes,
        `${path}.context_bytes`,
      );
      if (
        contextBytes < 1 ||
        contextBytes > MAX_PROJECT_CONTEXT_RECEIPT_BYTES
      ) {
        return invalid(
          `${path}.context_bytes`,
          'must be between 1 and 262144 bytes',
        );
      }
      return contextBytes;
    })(),
    consentReceiptId: canonicalLifecycleId(
      raw.consent_receipt_id,
      `${path}.consent_receipt_id`,
    ),
    provider: 'deepseek',
    policy: 'chat-read-v1',
    policyVersion: 'chat-read-v1.0.0',
  };
}

function parseProjectContextReceipt(
  value: unknown,
  path: string,
): CompletionRoundReceiptV1['projectContextReceipt'] {
  if (value === null) return null;
  const raw = exactRecord(value, path, [
    'schema_version',
    'snapshot_id',
    'snapshot_sha256',
    'source_fingerprint',
    'context_bytes',
    'verified_at',
  ]);
  if (raw.schema_version !== 1) {
    return invalid(`${path}.schema_version`, 'must equal 1');
  }
  return {
    schema_version: 1,
    snapshot_id: canonicalLifecycleId(
      raw.snapshot_id,
      `${path}.snapshot_id`,
    ),
    snapshot_sha256: sha256(
      raw.snapshot_sha256,
      `${path}.snapshot_sha256`,
    ),
    source_fingerprint: sha256(
      raw.source_fingerprint,
      `${path}.source_fingerprint`,
    ),
    context_bytes: (() => {
      const contextBytes = nonNegativeSafeInteger(
        raw.context_bytes,
        `${path}.context_bytes`,
      );
      if (
        contextBytes < 1 ||
        contextBytes > MAX_PROJECT_CONTEXT_RECEIPT_BYTES
      ) {
        return invalid(
          `${path}.context_bytes`,
          'must be between 1 and 262144 bytes',
        );
      }
      return contextBytes;
    })(),
    verified_at: timestamp(raw.verified_at, `${path}.verified_at`),
  };
}

function parseRoundReceipt(
  value: unknown,
  path: string,
): CompletionRoundReceiptV1 {
  const raw = exactRecord(value, path, [
    'schema_version',
    'transport_schema_version',
    'turn_id',
    'attempt_id',
    'round_id',
    'round_index',
    'provider_request_id',
    'provider_response_id',
    'requested_model',
    'model',
    'thinking_mode',
    'finish_reason',
    'latency_ms',
    'visible_history_sha256',
    'model_input_sha256',
    'request_body_sha256',
    'project_context_receipt',
  ]);
  if (raw.schema_version !== COMPLETION_ROUND_RECEIPT_SCHEMA_VERSION) {
    return invalid(`${path}.schema_version`, 'must equal 1');
  }
  if (raw.transport_schema_version !== 2 && raw.transport_schema_version !== 3) {
    return invalid(
      `${path}.transport_schema_version`,
      'must equal 2 or 3',
    );
  }
  if (!isModelId(raw.requested_model) || !isModelId(raw.model)) {
    return invalid(`${path}.model`, 'must contain supported models');
  }
  if (!isConversationThinkingMode(raw.thinking_mode)) {
    return invalid(`${path}.thinking_mode`, 'must be supported');
  }
  if (
    typeof raw.finish_reason !== 'string' ||
    !finishReasons.has(raw.finish_reason)
  ) {
    return invalid(`${path}.finish_reason`, 'must be supported');
  }
  const roundIndex = nonNegativeSafeInteger(
    raw.round_index,
    `${path}.round_index`,
  );
  if (roundIndex >= MAX_COMPLETION_ROUNDS) {
    return invalid(`${path}.round_index`, 'must be less than 8');
  }
  return {
    schemaVersion: COMPLETION_ROUND_RECEIPT_SCHEMA_VERSION,
    transportSchemaVersion: raw.transport_schema_version,
    turnId: canonicalLifecycleId(raw.turn_id, `${path}.turn_id`),
    attemptId: canonicalLifecycleId(
      raw.attempt_id,
      `${path}.attempt_id`,
    ),
    roundId: canonicalLifecycleId(raw.round_id, `${path}.round_id`),
    roundIndex,
    providerRequestId: canonicalLifecycleId(
      raw.provider_request_id,
      `${path}.provider_request_id`,
    ),
    providerResponseId: opaqueProviderId(
      raw.provider_response_id,
      `${path}.provider_response_id`,
    ),
    requestedModel: raw.requested_model,
    model: raw.model,
    thinkingMode: raw.thinking_mode,
    finishReason:
      raw.finish_reason as CompletionRoundReceiptV1['finishReason'],
    latencyMs: nonNegativeSafeInteger(
      raw.latency_ms,
      `${path}.latency_ms`,
    ),
    visibleHistorySha256: sha256(
      raw.visible_history_sha256,
      `${path}.visible_history_sha256`,
    ),
    modelInputSha256: sha256(
      raw.model_input_sha256,
      `${path}.model_input_sha256`,
    ),
    requestBodySha256: sha256(
      raw.request_body_sha256,
      `${path}.request_body_sha256`,
    ),
    projectContextReceipt: parseProjectContextReceipt(
      raw.project_context_receipt,
      `${path}.project_context_receipt`,
    ),
  };
}

function parseTurn(value: unknown, path: string): ConversationTurnV1 {
  const raw = exactRecord(value, path, [
    'schema_version',
    'turn_id',
    'user_message_id',
    'attempt_ids',
    'created_at',
  ]);
  if (raw.schema_version !== CONVERSATION_TURN_SCHEMA_VERSION) {
    return invalid(`${path}.schema_version`, 'must equal 1');
  }
  const attemptIds = uniqueStringArray(
    raw.attempt_ids,
    `${path}.attempt_ids`,
    MAX_ATTEMPTS_PER_CONVERSATION,
    true,
  );
  if (attemptIds.length === 0) {
    return invalid(`${path}.attempt_ids`, 'must not be empty');
  }
  return {
    schemaVersion: CONVERSATION_TURN_SCHEMA_VERSION,
    turnId: canonicalLifecycleId(raw.turn_id, `${path}.turn_id`),
    userMessageId: boundedString(
      raw.user_message_id,
      `${path}.user_message_id`,
      MAX_ID_LENGTH,
    ),
    attemptIds,
    createdAt: timestamp(raw.created_at, `${path}.created_at`),
  };
}

function parseAttempt(value: unknown, path: string): TurnAttemptV1 {
  const raw = exactRecord(value, path, [
    'schema_version',
    'attempt_id',
    'turn_id',
    'status',
    'visible_message_ids',
    'visible_history_sha256',
    'attachment_ids',
    'model_id',
    'thinking_mode',
    'context_disposition',
    'context_project_id',
    'project_context',
    'active_round',
    'rounds',
    'assistant_message_id',
    'failure_code',
    'created_at',
    'updated_at',
  ]);
  if (raw.schema_version !== TURN_ATTEMPT_SCHEMA_VERSION) {
    return invalid(`${path}.schema_version`, 'must equal 1');
  }
  if (
    typeof raw.status !== 'string' ||
    !attemptStatuses.has(raw.status)
  ) {
    return invalid(`${path}.status`, 'must be a supported attempt status');
  }
  if (!isModelId(raw.model_id)) {
    return invalid(`${path}.model_id`, 'must be a supported model');
  }
  if (!isConversationThinkingMode(raw.thinking_mode)) {
    return invalid(`${path}.thinking_mode`, 'must be supported');
  }
  if (
    typeof raw.context_disposition !== 'string' ||
    !contextDispositions.has(raw.context_disposition)
  ) {
    return invalid(
      `${path}.context_disposition`,
      'must be a supported context disposition',
    );
  }
  const roundsRaw = array(
    raw.rounds,
    `${path}.rounds`,
    MAX_COMPLETION_ROUNDS,
  );
  if (roundsRaw.length > MAX_COMPLETION_ROUNDS) {
    return invalid(`${path}.rounds`, 'must contain no more than 8 rounds');
  }
  const rounds = roundsRaw.map((entry, index) =>
    parseRoundReceipt(entry, `${path}.rounds[${index}]`),
  );
  const activeRound =
    raw.active_round === null
      ? null
      : (() => {
          const active = exactRecord(raw.active_round, `${path}.active_round`, [
            'round_id',
            'round_index',
          ]);
          const roundIndex = nonNegativeSafeInteger(
            active.round_index,
            `${path}.active_round.round_index`,
          );
          if (roundIndex >= MAX_COMPLETION_ROUNDS) {
            return invalid(
              `${path}.active_round.round_index`,
              'must be less than 8',
            );
          }
          return {
            roundId: canonicalLifecycleId(
              active.round_id,
              `${path}.active_round.round_id`,
            ),
            roundIndex,
          };
        })();
  const failureCode =
    raw.failure_code === null
      ? null
      : isAttemptFailureCode(raw.failure_code)
        ? raw.failure_code
        : invalid(`${path}.failure_code`, 'must be a stable error code');
  const createdAt = timestamp(raw.created_at, `${path}.created_at`);
  const updatedAt = timestamp(raw.updated_at, `${path}.updated_at`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    return invalid(`${path}.updated_at`, 'must not precede created_at');
  }
  const attempt: TurnAttemptV1 = {
    schemaVersion: TURN_ATTEMPT_SCHEMA_VERSION,
    attemptId: canonicalLifecycleId(
      raw.attempt_id,
      `${path}.attempt_id`,
    ),
    turnId: canonicalLifecycleId(raw.turn_id, `${path}.turn_id`),
    status: raw.status as TurnAttemptStatus,
    visibleMessageIds: uniqueStringArray(
      raw.visible_message_ids,
      `${path}.visible_message_ids`,
      MAX_ATTEMPT_VISIBLE_MESSAGES,
    ),
    visibleHistorySha256:
      raw.visible_history_sha256 === null
        ? null
        : sha256(
            raw.visible_history_sha256,
            `${path}.visible_history_sha256`,
          ),
    attachmentIds: uniqueStringArray(
      raw.attachment_ids,
      `${path}.attachment_ids`,
      MAX_ATTEMPT_ATTACHMENT_IDS,
    ),
    modelId: raw.model_id,
    thinkingMode: raw.thinking_mode,
    contextDisposition:
      raw.context_disposition as AttemptContextDisposition,
    contextProjectId:
      raw.context_project_id === null
        ? null
        : isProjectId(raw.context_project_id)
          ? raw.context_project_id
          : invalid(
              `${path}.context_project_id`,
              'must be a valid project id or null',
            ),
    projectContext: parseAttemptProjectContext(
      raw.project_context,
      `${path}.project_context`,
    ),
    activeRound,
    rounds,
    assistantMessageId:
      raw.assistant_message_id === null
        ? null
        : boundedString(
            raw.assistant_message_id,
            `${path}.assistant_message_id`,
            MAX_ID_LENGTH,
          ),
    failureCode,
    createdAt,
    updatedAt,
  };
  if (
    (attempt.status === 'sending') !== (attempt.activeRound !== null) ||
    (attempt.status === 'completed') !==
      (attempt.assistantMessageId !== null) ||
    (attempt.status === 'failed') !== (attempt.failureCode !== null) ||
    (attempt.status === 'cancelled' && attempt.failureCode !== null) ||
    (attempt.status !== 'completed' && attempt.assistantMessageId !== null) ||
    ((attempt.status === 'prepared' || attempt.status === 'sending') &&
      attempt.failureCode !== null) ||
    (attempt.rounds.length > 0 && attempt.visibleHistorySha256 === null)
  ) {
    return invalid(path, 'contains an invalid attempt status combination');
  }
  if (
    (attempt.contextDisposition === 'verified') !==
      (attempt.projectContext !== null) ||
    (attempt.contextDisposition === 'unbound' &&
      (attempt.projectContext !== null ||
        attempt.contextProjectId !== null)) ||
    (attempt.contextDisposition === 'explicit_without_context' &&
      (attempt.projectContext !== null ||
        attempt.contextProjectId === null)) ||
    (attempt.contextDisposition === 'verified' &&
      attempt.contextProjectId !== attempt.projectContext?.projectId)
  ) {
    return invalid(
      `${path}.context_disposition`,
      'does not match project_context',
    );
  }
  if (
    attempt.activeRound !== null &&
    attempt.activeRound.roundIndex !== attempt.rounds.length
  ) {
    return invalid(
      `${path}.active_round.round_index`,
      'must equal the completed round count',
    );
  }
  return attempt;
}

function sameStringSequence(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function samePersistedAttemptBinding(
  left: TurnAttemptV1['projectContext'],
  right: TurnAttemptV1['projectContext'],
): boolean {
  return (
    (left === null && right === null) ||
    (left !== null &&
      right !== null &&
      left.schemaVersion === right.schemaVersion &&
      left.runtimeContextId === right.runtimeContextId &&
      left.projectId === right.projectId &&
      left.snapshotId === right.snapshotId &&
      left.snapshotSha256 === right.snapshotSha256 &&
      left.sourceFingerprint === right.sourceFingerprint &&
      left.contextBytes === right.contextBytes &&
      left.consentReceiptId === right.consentReceiptId &&
      left.provider === right.provider &&
      left.policy === right.policy &&
      left.policyVersion === right.policyVersion)
  );
}

function sameFrozenAttempt(
  left: TurnAttemptV1,
  right: TurnAttemptV1,
): boolean {
  return (
    sameStringSequence(left.visibleMessageIds, right.visibleMessageIds) &&
    sameStringSequence(left.attachmentIds, right.attachmentIds) &&
    left.modelId === right.modelId &&
    left.thinkingMode === right.thinkingMode &&
    left.contextDisposition === right.contextDisposition &&
    left.contextProjectId === right.contextProjectId &&
    samePersistedAttemptBinding(left.projectContext, right.projectContext)
  );
}

function parseConversation(
  value: unknown,
  path: string,
  schemaVersion: PersistedSchemaVersion,
): Conversation {
  const raw =
    hasProjectContextShape(schemaVersion)
      ? exactRecord(value, path, [
          'id',
          'project_id',
          'workspace_id',
          'runtime_context_id',
          'project_context',
          'title',
          'title_source',
          'model_id',
          'thinking_mode',
          'messages',
          'turns',
          'attempts',
          'created_at',
          'updated_at',
        ])
      : record(value, path);
  if (raw.title_source !== 'auto' && raw.title_source !== 'manual') {
    return invalid(`${path}.title_source`, 'must be auto or manual');
  }
  if (!isModelId(raw.model_id)) {
    return invalid(`${path}.model_id`, 'is not a supported model');
  }
  const thinkingMode =
    raw.thinking_mode === undefined ? DEFAULT_THINKING_MODE : raw.thinking_mode;
  if (!isConversationThinkingMode(thinkingMode)) {
    return invalid(`${path}.thinking_mode`, 'is not a supported thinking mode');
  }
  const projectId =
    schemaVersion === LEGACY_CHAT_STATE_SCHEMA_VERSION ? null : raw.project_id;
  if (projectId !== null && !isProjectId(projectId)) {
    return invalid(`${path}.project_id`, 'must be a valid project id or null');
  }
  const workspaceId =
    hasWorkspaceShape(schemaVersion)
      ? raw.workspace_id
      : null;
  if (workspaceId !== null && !isWorkspaceId(workspaceId)) {
    return invalid(
      `${path}.workspace_id`,
      'must be a valid workspace id or null',
    );
  }

  const createdAt = timestamp(raw.created_at, `${path}.created_at`);
  const updatedAt = timestamp(raw.updated_at, `${path}.updated_at`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    return invalid(`${path}.updated_at`, 'must not be earlier than created_at');
  }
  const messages = parseMessages(
    raw.messages,
    `${path}.messages`,
    schemaVersion,
  );
  const messageAfterUpdate = messages.find(
    message => Date.parse(message.createdAt) > Date.parse(updatedAt),
  );
  if (messageAfterUpdate !== undefined) {
    return invalid(
      `${path}.updated_at`,
      `must not be earlier than message ${messageAfterUpdate.id}`,
    );
  }

  const runtimeContextId =
    hasProjectContextShape(schemaVersion)
      ? raw.runtime_context_id === null
        ? null
        : canonicalLifecycleId(
            raw.runtime_context_id,
            `${path}.runtime_context_id`,
          )
      : null;
  const projectContext =
    hasProjectContextShape(schemaVersion)
      ? raw.project_context === null
        ? null
        : (() => {
            try {
              preflightV6ProjectContext(
                raw.project_context,
                `${path}.project_context`,
              );
              return validateV6ProjectContext(
                hydrateProjectContextState(raw.project_context),
                raw.project_context,
                `${path}.project_context`,
              );
            } catch {
              return invalid(
                `${path}.project_context`,
                'violates the v6 context contract',
              );
            }
          })()
      : projectId === null
        ? null
        : createProjectContextState(projectId);
  if (
    (projectId === null) !== (projectContext === null) ||
    (projectContext !== null && projectContext.projectId !== projectId)
  ) {
    return invalid(
      `${path}.project_context`,
      'must correspond exactly to project_id',
    );
  }
  if (
    projectContext !== null &&
    isProjectContextSendable(projectContext) &&
    (runtimeContextId === null ||
      projectContext.snapshot?.model !== raw.model_id)
  ) {
    return invalid(
      `${path}.project_context`,
      'a sendable context must match runtime_context_id and model_id',
    );
  }
  const turnsRaw =
    hasProjectContextShape(schemaVersion)
      ? array(
          raw.turns,
          `${path}.turns`,
          MAX_TURNS_PER_CONVERSATION,
        )
      : [];
  if (turnsRaw.length > MAX_TURNS_PER_CONVERSATION) {
    return invalid(`${path}.turns`, 'contains too many turns');
  }
  const turns = turnsRaw.map((entry, index) =>
    parseTurn(entry, `${path}.turns[${index}]`),
  );
  const attemptsRaw =
    hasProjectContextShape(schemaVersion)
      ? array(
          raw.attempts,
          `${path}.attempts`,
          MAX_ATTEMPTS_PER_CONVERSATION,
        )
      : [];
  if (attemptsRaw.length > MAX_ATTEMPTS_PER_CONVERSATION) {
    return invalid(`${path}.attempts`, 'contains too many attempts');
  }
  const attempts = attemptsRaw.map((entry, index) =>
    parseAttempt(entry, `${path}.attempts[${index}]`),
  );
  const messageById = new Map(messages.map(message => [message.id, message]));
  const messageIndexById = new Map(
    messages.map((message, index) => [message.id, index]),
  );
  const attemptById = new Map<string, TurnAttemptV1>();
  const attemptIndexById = new Map<string, number>();
  const referencedAttempts = new Set<string>();
  const assistantAttemptReferences = new Set<string>();
  const turnIds = new Set<string>();
  let turnAttemptReferences = 0;
  let previousTurnMessageIndex = -1;
  let attemptMessageReferences = 0;
  attempts.forEach((attempt, index) => {
    attemptMessageReferences += attempt.visibleMessageIds.length;
    if (attemptMessageReferences > MAX_ATTEMPT_MESSAGE_REFERENCES) {
      invalid(
        `${path}.attempts[${index}].visible_message_ids`,
        'exceeds the aggregate visible-message reference limit',
      );
    }
    if (attemptById.has(attempt.attemptId)) {
      invalid(`${path}.attempts[${index}].attempt_id`, 'must be unique');
    }
    attemptById.set(attempt.attemptId, attempt);
    attemptIndexById.set(attempt.attemptId, index);
  });
  if (
    attempts.filter(
      attempt =>
        attempt.status === 'prepared' || attempt.status === 'sending',
    ).length > 1
  ) {
    return invalid(`${path}.attempts`, 'must contain at most one live attempt');
  }
  turns.forEach((turn, index) => {
    if (turnIds.has(turn.turnId)) {
      invalid(`${path}.turns[${index}].turn_id`, 'must be unique');
    }
    turnIds.add(turn.turnId);
    const userMessage = messageById.get(turn.userMessageId);
    const turnMessageIndex = messageIndexById.get(turn.userMessageId);
    if (userMessage?.role !== 'user') {
      invalid(
        `${path}.turns[${index}].user_message_id`,
        'must reference a user message',
      );
    }
    if (
      turnMessageIndex === undefined ||
      turnMessageIndex <= previousTurnMessageIndex
    ) {
      invalid(
        `${path}.turns[${index}].user_message_id`,
        'turns must follow visible message order',
      );
    }
    previousTurnMessageIndex = turnMessageIndex;
    if (turn.createdAt !== userMessage.createdAt) {
      invalid(
        `${path}.turns[${index}].created_at`,
        'must match the user message timestamp',
      );
    }
    let completedAttempts = 0;
    let knownVisibleHistorySha256: string | null = null;
    turn.attemptIds.forEach((attemptId, attemptIndexValue) => {
      turnAttemptReferences += 1;
      if (turnAttemptReferences > MAX_ATTEMPTS_PER_CONVERSATION) {
        invalid(
          `${path}.turns[${index}].attempt_ids`,
          'exceeds the aggregate attempt reference limit',
        );
      }
      const attempt = attemptById.get(attemptId);
      const persistedAttemptIndex = attemptIndexById.get(attemptId);
      if (
        attempt === undefined ||
        persistedAttemptIndex === undefined ||
        attempt.turnId !== turn.turnId
      ) {
        invalid(
          `${path}.turns[${index}].attempt_ids[${attemptIndexValue}]`,
          'must reference an attempt for this turn',
        );
      }
      if (referencedAttempts.has(attemptId)) {
        invalid(
          `${path}.turns[${index}].attempt_ids[${attemptIndexValue}]`,
          'must be referenced exactly once',
        );
      }
      referencedAttempts.add(attemptId);
      if (attemptIndexValue === 0 && attempt.createdAt !== turn.createdAt) {
        invalid(
          `${path}.turns[${index}].attempt_ids[0]`,
          'the initial attempt timestamp must match the turn',
        );
      }
      if (
        attemptIndexValue < turn.attemptIds.length - 1 &&
        attempt.status !== 'failed' &&
        attempt.status !== 'cancelled'
      ) {
        invalid(
          `${path}.turns[${index}].attempt_ids[${attemptIndexValue}]`,
          'non-final attempts must be retryable terminal states',
        );
      }
      const firstAttempt = attemptById.get(turn.attemptIds[0]!);
      if (
        attemptIndexValue > 0 &&
        (firstAttempt === undefined ||
          !sameFrozenAttempt(firstAttempt, attempt))
      ) {
        invalid(
          `${path}.turns[${index}].attempt_ids[${attemptIndexValue}]`,
          'retry attempts must preserve the frozen request',
        );
      }
      if (attempt.visibleHistorySha256 === null) {
        if (knownVisibleHistorySha256 !== null) {
          invalid(
            `${path}.attempts[${persistedAttemptIndex}].visible_history_sha256`,
            'must retain the first verified visible-history digest',
          );
        }
      } else if (knownVisibleHistorySha256 === null) {
        knownVisibleHistorySha256 = attempt.visibleHistorySha256;
      } else if (
        attempt.visibleHistorySha256 !== knownVisibleHistorySha256
      ) {
        invalid(
          `${path}.attempts[${persistedAttemptIndex}].visible_history_sha256`,
          'must match the first verified visible-history digest',
        );
      }
      if (
        attempt.rounds.length === 0 &&
        attempt.visibleHistorySha256 !== null
      ) {
        const hasDigestProvenance =
          attemptIndexValue > 0 &&
          turn.attemptIds
            .slice(0, attemptIndexValue)
            .some(previousAttemptId => {
              const previous = attemptById.get(previousAttemptId);
              return (
                previous !== undefined &&
                previous.rounds.length > 0 &&
                previous.visibleHistorySha256 ===
                  attempt.visibleHistorySha256 &&
                sameFrozenAttempt(previous, attempt)
              );
            });
        if (!hasDigestProvenance) {
          invalid(
            `${path}.attempts[${persistedAttemptIndex}].visible_history_sha256`,
            'requires an earlier correlated round receipt',
          );
        }
      }
      if (attempt.status === 'completed') {
        completedAttempts += 1;
        if (
          completedAttempts > 1 ||
          attempt.assistantMessageId === null ||
          assistantAttemptReferences.has(attempt.assistantMessageId)
        ) {
          invalid(
            `${path}.turns[${index}].attempt_ids[${attemptIndexValue}]`,
            'must have at most one uniquely referenced completion',
          );
        }
        assistantAttemptReferences.add(attempt.assistantMessageId);
      }
      const userIndex = messageIndexById.get(turn.userMessageId);
      if (userIndex === undefined) {
        invalid(
          `${path}.turns[${index}].user_message_id`,
          'must reference a visible message',
        );
      }
      const expectedWindowStart = Math.max(
        0,
        userIndex + 1 - MAX_ATTEMPT_VISIBLE_MESSAGES,
      );
      const expectedWindowLength = userIndex + 1 - expectedWindowStart;
      if (
        attempt.visibleMessageIds.length !== expectedWindowLength ||
        !attempt.visibleMessageIds.every(
          (messageId, visibleIndex) =>
            messageId ===
            messages[expectedWindowStart + visibleIndex]?.id,
        )
      ) {
        invalid(
          `${path}.attempts[${persistedAttemptIndex}].visible_message_ids`,
          'must freeze the contiguous visible-message window',
        );
      }
      const expectedAttachments: string[] = [];
      const seenAttachmentIds = new Set<string>();
      let visibleAttachmentCount = 0;
      let visibleAttachmentBytes = 0;
      attempt.visibleMessageIds.forEach(messageId => {
        messageById.get(messageId)?.attachments.forEach(attachment => {
          visibleAttachmentCount += 1;
          visibleAttachmentBytes += attachment.size;
          if (seenAttachmentIds.has(attachment.id)) return;
          seenAttachmentIds.add(attachment.id);
          expectedAttachments.push(attachment.id);
        });
      });
      if (
        visibleAttachmentCount > MAX_ATTEMPT_ATTACHMENT_IDS ||
        visibleAttachmentBytes > MAX_TOTAL_ATTACHMENT_SIZE ||
        attempt.attachmentIds.length !== expectedAttachments.length ||
        !attempt.attachmentIds.every(
          (attachmentId, attachmentIndex) =>
            attachmentId === expectedAttachments[attachmentIndex],
        )
      ) {
        invalid(
          `${path}.attempts[${persistedAttemptIndex}].attachment_ids`,
          'must match the user message attachments',
        );
      }
    });
  });
  if (referencedAttempts.size !== attempts.length) {
    return invalid(`${path}.attempts`, 'every attempt must belong to one turn');
  }
  attempts.forEach((attempt, index) => {
    attempt.rounds.forEach((receipt, roundIndex) => {
      const binding = attempt.projectContext;
      const projectReceipt = receipt.projectContextReceipt;
      if (
        receipt.turnId !== attempt.turnId ||
        receipt.attemptId !== attempt.attemptId ||
        receipt.roundIndex !== roundIndex ||
        receipt.requestedModel !== attempt.modelId ||
        receipt.model !== attempt.modelId ||
        receipt.thinkingMode !== attempt.thinkingMode ||
        receipt.visibleHistorySha256 !== attempt.visibleHistorySha256 ||
        (binding === null
          ? receipt.transportSchemaVersion !== 2 || projectReceipt !== null
          : receipt.transportSchemaVersion !== 3 ||
            projectReceipt === null ||
            projectReceipt.snapshot_id !== binding.snapshotId ||
            projectReceipt.snapshot_sha256 !== binding.snapshotSha256 ||
            projectReceipt.source_fingerprint !==
              binding.sourceFingerprint ||
            projectReceipt.context_bytes !== binding.contextBytes)
      ) {
        invalid(
          `${path}.attempts[${index}].rounds[${roundIndex}]`,
          'does not correlate with its attempt',
        );
      }
      if (
        roundIndex < attempt.rounds.length - 1 &&
        receipt.finishReason !== 'tool_calls'
      ) {
        invalid(
          `${path}.attempts[${index}].rounds[${roundIndex}].finish_reason`,
          'only tool_calls may be followed by another round',
        );
      }
    });
    if (
      attempt.status === 'completed' &&
      (attempt.rounds.length === 0 ||
        attempt.rounds[attempt.rounds.length - 1]?.finishReason ===
          'tool_calls')
    ) {
      invalid(
        `${path}.attempts[${index}].status`,
        'completed requires a terminal round receipt',
      );
    }
    if (
      attempt.projectContext !== null &&
      (runtimeContextId === null ||
        attempt.projectContext.runtimeContextId !== runtimeContextId)
    ) {
      invalid(
        `${path}.attempts[${index}].project_context.runtime_context_id`,
        'must match the conversation runtime context',
      );
    }
    if (
      (attempt.status === 'prepared' || attempt.status === 'sending') &&
      attempt.contextProjectId !== projectId
    ) {
      invalid(
        `${path}.attempts[${index}].context_project_id`,
        'a live attempt must match the conversation project binding',
      );
    }
    if (attempt.assistantMessageId !== null) {
      const assistant = messageById.get(attempt.assistantMessageId);
      const attemptTurn = turns.find(turn => turn.turnId === attempt.turnId);
      const userMessageIndex =
        attemptTurn === undefined
          ? undefined
          : messageIndexById.get(attemptTurn.userMessageId);
      const assistantMessageIndex = messageIndexById.get(
        attempt.assistantMessageId,
      );
      if (assistant?.role !== 'assistant') {
        invalid(
          `${path}.attempts[${index}].assistant_message_id`,
          'must reference an assistant message',
        );
      }
      if (
        userMessageIndex === undefined ||
        assistantMessageIndex === undefined ||
        assistantMessageIndex <= userMessageIndex ||
        Date.parse(assistant.createdAt) < Date.parse(attempt.createdAt)
      ) {
        invalid(
          `${path}.attempts[${index}].assistant_message_id`,
          'must follow the user turn',
        );
      }
      const lastReceipt = attempt.rounds[attempt.rounds.length - 1];
      if (
        lastReceipt === undefined ||
        assistant.metadata?.modelId !== lastReceipt.model ||
        assistant.metadata.latencyMs !== lastReceipt.latencyMs ||
        assistant.metadata.finishReason !== lastReceipt.finishReason
      ) {
        invalid(
          `${path}.attempts[${index}].assistant_message_id`,
          'assistant metadata must match the terminal round receipt',
        );
      }
    }
  });

  return {
    id: boundedString(raw.id, `${path}.id`, MAX_ID_LENGTH),
    projectId,
    workspaceId,
    runtimeContextId,
    projectContext,
    title: boundedString(raw.title, `${path}.title`, MAX_TITLE_LENGTH),
    titleSource: raw.title_source,
    modelId: raw.model_id,
    thinkingMode,
    messages,
    turns,
    attempts,
    createdAt,
    updatedAt,
  };
}

function messageMetadataEqual(
  left: ChatMessageMetadata | undefined,
  right: ChatMessageMetadata | undefined,
): boolean {
  return (
    left?.modelId === right?.modelId &&
    left?.latencyMs === right?.latencyMs &&
    left?.finishReason === right?.finishReason &&
    left?.reasoning === right?.reasoning
  );
}

function attachmentsEqual(
  left: readonly ChatAttachment[],
  right: readonly ChatAttachment[],
): boolean {
  return (
    left.length === right.length &&
    left.every((attachment, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        attachment.schema_version === candidate.schema_version &&
        attachment.id === candidate.id &&
        attachment.kind === candidate.kind &&
        attachment.name === candidate.name &&
        attachment.mime_type === candidate.mime_type &&
        attachment.size === candidate.size
      );
    })
  );
}

function messagesEqual(
  left: readonly ChatMessage[],
  right: readonly ChatMessage[],
): boolean {
  return (
    left.length === right.length &&
    left.every((message, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        message.id === candidate.id &&
        message.role === candidate.role &&
        message.text === candidate.text &&
        message.createdAt === candidate.createdAt &&
        attachmentsEqual(message.attachments, candidate.attachments) &&
        messageMetadataEqual(message.metadata, candidate.metadata)
      );
    })
  );
}

function toPersistedAttachment(
  attachment: ChatAttachment,
): PersistedChatAttachmentV1 {
  return {
    schema_version: attachment.schema_version,
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mime_type: attachment.mime_type,
    size: attachment.size,
  };
}

function toPersistedMessage(message: ChatMessage): PersistedChatMessageV4 {
  const sourceMetadata = message.metadata;
  const metadata =
    sourceMetadata === undefined
      ? undefined
      : {
          ...(sourceMetadata.modelId === undefined
            ? {}
            : { model_id: sourceMetadata.modelId }),
          ...(sourceMetadata.latencyMs === undefined
            ? {}
            : { latency_ms: sourceMetadata.latencyMs }),
          ...(sourceMetadata.finishReason === undefined
            ? {}
            : { finish_reason: sourceMetadata.finishReason }),
          ...(sourceMetadata.reasoning === undefined
            ? {}
            : { reasoning: sourceMetadata.reasoning }),
        };
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    created_at: message.createdAt,
    attachments: message.attachments.map(toPersistedAttachment),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function toPersistedTurn(
  turn: ConversationTurnV1,
): PersistedConversationTurnV1 {
  return {
    schema_version: turn.schemaVersion,
    turn_id: turn.turnId,
    user_message_id: turn.userMessageId,
    attempt_ids: [...turn.attemptIds],
    created_at: turn.createdAt,
  };
}

function toPersistedRoundReceipt(
  receipt: CompletionRoundReceiptV1,
): PersistedCompletionRoundReceiptV1 {
  return {
    schema_version: receipt.schemaVersion,
    transport_schema_version: receipt.transportSchemaVersion,
    turn_id: receipt.turnId,
    attempt_id: receipt.attemptId,
    round_id: receipt.roundId,
    round_index: receipt.roundIndex,
    provider_request_id: receipt.providerRequestId,
    provider_response_id: receipt.providerResponseId,
    requested_model: receipt.requestedModel,
    model: receipt.model,
    thinking_mode: receipt.thinkingMode,
    finish_reason: receipt.finishReason,
    latency_ms: receipt.latencyMs,
    visible_history_sha256: receipt.visibleHistorySha256,
    model_input_sha256: receipt.modelInputSha256,
    request_body_sha256: receipt.requestBodySha256,
    project_context_receipt: receipt.projectContextReceipt,
  };
}

function toPersistedAttempt(
  attempt: TurnAttemptV1,
): PersistedTurnAttemptV1 {
  return {
    schema_version: attempt.schemaVersion,
    attempt_id: attempt.attemptId,
    turn_id: attempt.turnId,
    status: attempt.status,
    visible_message_ids: [...attempt.visibleMessageIds],
    visible_history_sha256: attempt.visibleHistorySha256,
    attachment_ids: [...attempt.attachmentIds],
    model_id: attempt.modelId,
    thinking_mode: attempt.thinkingMode,
    context_disposition: attempt.contextDisposition,
    context_project_id: attempt.contextProjectId,
    project_context:
      attempt.projectContext === null
        ? null
        : {
            schema_version: attempt.projectContext.schemaVersion,
            runtime_context_id: attempt.projectContext.runtimeContextId,
            project_id: attempt.projectContext.projectId,
            snapshot_id: attempt.projectContext.snapshotId,
            snapshot_sha256: attempt.projectContext.snapshotSha256,
            source_fingerprint: attempt.projectContext.sourceFingerprint,
            context_bytes: attempt.projectContext.contextBytes,
            consent_receipt_id: attempt.projectContext.consentReceiptId,
            provider: attempt.projectContext.provider,
            policy: attempt.projectContext.policy,
            policy_version: attempt.projectContext.policyVersion,
          },
    active_round:
      attempt.activeRound === null
        ? null
        : {
            round_id: attempt.activeRound.roundId,
            round_index: attempt.activeRound.roundIndex,
          },
    rounds: attempt.rounds.map(toPersistedRoundReceipt),
    assistant_message_id: attempt.assistantMessageId,
    failure_code: attempt.failureCode,
    created_at: attempt.createdAt,
    updated_at: attempt.updatedAt,
  };
}

function toPersistedDestructiveTransition(
  transition: ProjectContextDestructiveTransitionV1,
): NonNullable<
  PersistedChatStateV7['project_context_destructive_transition']
> {
  return {
    schema_version: transition.schemaVersion,
    lifecycle_id: transition.lifecycleId,
    epoch: transition.epoch,
    action: transition.action,
    phase: transition.phase,
    conversation_id: transition.conversationId,
    source_project_id: transition.sourceProjectId,
    source_runtime_context_id: transition.sourceRuntimeContextId,
    source_model_id: transition.sourceModelId,
    snapshot_id: transition.snapshotId,
    snapshot_sha256: transition.snapshotSha256,
    consent_receipt_id: transition.consentReceiptId,
    target_project_id: transition.targetProjectId,
    created_at: transition.createdAt,
    updated_at: transition.updatedAt,
  };
}

function toPersistedState(state: ChatState): PersistedChatStateV7 {
  const conversationOrder = orderConversationIds(state.conversations);
  const conversations = conversationOrder.map(id => {
    const conversation = state.conversations[id];
    if (conversation === undefined) {
      return invalid(`state.conversations.${id}`, 'is missing');
    }
    return {
      id: conversation.id,
      project_id: conversation.projectId,
      workspace_id: conversation.workspaceId,
      runtime_context_id: conversation.runtimeContextId,
      project_context:
        conversation.projectContext === null
          ? null
          : (JSON.parse(
              serializeProjectContextState(conversation.projectContext),
            ) as PersistedChatStateV7['conversations'][number]['project_context']),
      title: conversation.title,
      title_source: conversation.titleSource,
      model_id: conversation.modelId,
      thinking_mode: conversation.thinkingMode,
      messages: conversation.messages.map(toPersistedMessage),
      turns: conversation.turns.map(toPersistedTurn),
      attempts: conversation.attempts.map(toPersistedAttempt),
      created_at: conversation.createdAt,
      updated_at: conversation.updatedAt,
    };
  });
  return {
    schema_version: CHAT_STATE_SCHEMA_VERSION,
    project_context_destructive_epoch:
      state.projectContextDestructiveEpoch,
    project_context_destructive_transition:
      state.projectContextDestructiveTransition === null
        ? null
        : toPersistedDestructiveTransition(
            state.projectContextDestructiveTransition,
          ),
    active_conversation_id: state.selectedConversationId,
    conversations,
    messages: selectActiveMessages(state).map(toPersistedMessage),
  };
}

export function hydrateChatState(input: unknown): ChatState {
  let decoded: unknown = input;
  if (typeof input === 'string') {
    try {
      decoded = JSON.parse(input) as unknown;
    } catch {
      return invalid('$', 'must be valid JSON');
    }
  }

  let raw = record(decoded, '$');
  const decodedSchemaVersion = ownDataValue(
    raw,
    'schema_version',
    '$.schema_version',
  );
  if (
    decodedSchemaVersion !== LEGACY_CHAT_STATE_SCHEMA_VERSION &&
    decodedSchemaVersion !== OLDER_CHAT_STATE_SCHEMA_VERSION &&
    decodedSchemaVersion !== ATTACHMENT_CHAT_STATE_SCHEMA_VERSION &&
    decodedSchemaVersion !== WORKSPACE_CHAT_STATE_SCHEMA_VERSION &&
    decodedSchemaVersion !== PREVIOUS_CHAT_STATE_SCHEMA_VERSION &&
    decodedSchemaVersion !== CHAT_STATE_SCHEMA_VERSION
  ) {
    return invalid(
      '$.schema_version',
      `must equal ${LEGACY_CHAT_STATE_SCHEMA_VERSION}, ${OLDER_CHAT_STATE_SCHEMA_VERSION}, ${ATTACHMENT_CHAT_STATE_SCHEMA_VERSION}, ${WORKSPACE_CHAT_STATE_SCHEMA_VERSION}, ${PREVIOUS_CHAT_STATE_SCHEMA_VERSION}, or ${CHAT_STATE_SCHEMA_VERSION}`,
    );
  }
  const schemaVersion = decodedSchemaVersion;
  if (hasProjectContextShape(schemaVersion)) {
    // App persistence deliberately co-locates the independently validated
    // preferences envelope at the root.
    raw = exactRecord(
      decoded,
      '$',
      schemaVersion === CHAT_STATE_SCHEMA_VERSION
        ? [
            'schema_version',
            'project_context_destructive_epoch',
            'project_context_destructive_transition',
            'active_conversation_id',
            'conversations',
            'messages',
            'preferences',
          ]
        : [
            'schema_version',
            'active_conversation_id',
            'conversations',
            'messages',
            'preferences',
          ],
      ['preferences'],
    );
  }
  if (
    raw.active_conversation_id !== null &&
    typeof raw.active_conversation_id !== 'string'
  ) {
    return invalid('$.active_conversation_id', 'must be a string or null');
  }

  const destructiveEpoch =
    schemaVersion === CHAT_STATE_SCHEMA_VERSION
      ? lifecycleEpoch(
          raw.project_context_destructive_epoch,
          '$.project_context_destructive_epoch',
          true,
        )
      : 0;
  const destructiveTransition =
    schemaVersion === CHAT_STATE_SCHEMA_VERSION &&
    raw.project_context_destructive_transition !== null
      ? parseDestructiveTransition(
          raw.project_context_destructive_transition,
          '$.project_context_destructive_transition',
        )
      : null;
  if (
    destructiveTransition !== null &&
    destructiveTransition.epoch !== destructiveEpoch
  ) {
    return invalid(
      '$.project_context_destructive_transition.epoch',
      'must match the root destructive epoch',
    );
  }

  const rawConversations = array(
    raw.conversations,
    '$.conversations',
    MAX_CONVERSATIONS,
  );
  if (rawConversations.length > MAX_CONVERSATIONS) {
    return invalid(
      '$.conversations',
      `must contain no more than ${MAX_CONVERSATIONS} conversations`,
    );
  }

  const conversations: Record<string, Conversation> = {};
  rawConversations.forEach((entry, index) => {
    const conversation = parseConversation(
      entry,
      `$.conversations[${index}]`,
      schemaVersion,
    );
    if (conversations[conversation.id] !== undefined) {
      return invalid(`$.conversations[${index}].id`, 'must be unique');
    }
    conversations[conversation.id] = conversation;
  });

  const lifecycleIds = new Set<string>();
  const providerRequestIds = new Set<string>();
  const providerResponseIds = new Set<string>();
  const claimLifecycleId = (value: string, path: string) => {
    if (lifecycleIds.has(value)) invalid(path, 'must be globally unique');
    lifecycleIds.add(value);
  };
  Object.values(conversations).forEach((conversation, conversationIndex) => {
    if (conversation.runtimeContextId !== null) {
      claimLifecycleId(
        conversation.runtimeContextId,
        `$.conversations[${conversationIndex}].runtime_context_id`,
      );
    }
    conversation.turns.forEach((turn, turnIndex) =>
      claimLifecycleId(
        turn.turnId,
        `$.conversations[${conversationIndex}].turns[${turnIndex}].turn_id`,
      ),
    );
    conversation.attempts.forEach((attempt, attemptIndexValue) => {
      claimLifecycleId(
        attempt.attemptId,
        `$.conversations[${conversationIndex}].attempts[${attemptIndexValue}].attempt_id`,
      );
      attempt.rounds.forEach((round, roundIndex) =>
        {
          const roundPath = `$.conversations[${conversationIndex}].attempts[${attemptIndexValue}].rounds[${roundIndex}]`;
          claimLifecycleId(round.roundId, `${roundPath}.round_id`);
          if (providerRequestIds.has(round.providerRequestId)) {
            invalid(
              `${roundPath}.provider_request_id`,
              'must be globally unique',
            );
          }
          providerRequestIds.add(round.providerRequestId);
          if (providerResponseIds.has(round.providerResponseId)) {
            invalid(
              `${roundPath}.provider_response_id`,
              'must be globally unique',
            );
          }
          providerResponseIds.add(round.providerResponseId);
        },
      );
      if (attempt.activeRound !== null) {
        claimLifecycleId(
          attempt.activeRound.roundId,
          `$.conversations[${conversationIndex}].attempts[${attemptIndexValue}].active_round.round_id`,
        );
      }
    });
  });
  if (destructiveTransition !== null) {
    claimLifecycleId(
      destructiveTransition.lifecycleId,
      '$.project_context_destructive_transition.lifecycle_id',
    );
  }

  const hydratedConversations: Record<string, Conversation> = {};
  Object.values(conversations).forEach(conversation => {
    hydratedConversations[conversation.id] = {
      ...conversation,
      attempts: conversation.attempts.map(attempt =>
        attempt.status === 'sending' ||
        (attempt.status === 'prepared' && attempt.rounds.length > 0)
          ? {
              ...attempt,
              status: 'failed' as const,
              activeRound: null,
              failureCode: 'E_ATTEMPT_INTERRUPTED' as const,
            }
          : attempt,
      ),
    };
  });

  if (destructiveTransition !== null) {
    const conversation =
      hydratedConversations[destructiveTransition.conversationId];
    if (conversation === undefined) {
      return invalid(
        '$.project_context_destructive_transition.conversation_id',
        'must reference an existing conversation',
      );
    }
    if (
      conversation.projectId !== destructiveTransition.sourceProjectId ||
      conversation.runtimeContextId !==
        destructiveTransition.sourceRuntimeContextId ||
      conversation.modelId !== destructiveTransition.sourceModelId ||
      conversation.projectContext === null
    ) {
      return invalid(
        '$.project_context_destructive_transition',
        'must match the frozen conversation owner',
      );
    }
    const context = conversation.projectContext;
    if (destructiveTransition.phase === 'intent') {
      if (
        destructiveTransition.updatedAt !== destructiveTransition.createdAt ||
        Date.parse(conversation.updatedAt) >
          Date.parse(destructiveTransition.createdAt) ||
        context.activePreparationId !== null ||
        context.snapshot?.snapshot_id !== destructiveTransition.snapshotId ||
        context.snapshot?.snapshot_sha256 !==
          destructiveTransition.snapshotSha256 ||
        (context.consent?.consent_receipt_id ?? null) !==
          destructiveTransition.consentReceiptId
      ) {
        return invalid(
          '$.project_context_destructive_transition',
          'must match the exact source snapshot and consent',
        );
      }
    } else {
      if (
        context.status !== 'setup_required' ||
        context.selectedPaths.length !== 0 ||
        context.activePreparationId !== null ||
        context.snapshot !== null ||
        context.consent !== null ||
        context.staleReason !== null ||
        context.errorCode !== null
      ) {
        return invalid(
          '$.project_context_destructive_transition.phase',
          'requires the exact disabled project context',
        );
      }
      if (
        (destructiveTransition.phase === 'cleanup_pending' &&
          conversation.updatedAt !== destructiveTransition.updatedAt) ||
        (destructiveTransition.phase === 'ready_to_finalize' &&
          Date.parse(conversation.updatedAt) >
            Date.parse(destructiveTransition.updatedAt))
      ) {
        return invalid(
          '$.project_context_destructive_transition.updated_at',
          'must match its reachable phase checkpoint',
        );
      }
    }
    const referenceState: ChatState = {
      schemaVersion: CHAT_STATE_SCHEMA_VERSION,
      projectContextDestructiveEpoch: destructiveEpoch,
      projectContextDestructiveTransition: destructiveTransition,
      conversations: hydratedConversations,
      conversationOrder: orderConversationIds(hydratedConversations),
      selectedConversationId:
        typeof raw.active_conversation_id === 'string'
          ? raw.active_conversation_id
          : null,
    };
    if (
      hasProjectContextDestructiveReferences(
        referenceState,
        destructiveTransition,
      )
    ) {
      return invalid(
        '$.project_context_destructive_transition.snapshot_id',
        'must not be referenced by an attempt',
      );
    }
  }

  const activeConversationId = raw.active_conversation_id;
  if (
    activeConversationId !== null &&
    hydratedConversations[activeConversationId] === undefined
  ) {
    return invalid(
      '$.active_conversation_id',
      'must reference an existing conversation',
    );
  }

  const projectedMessages = parseMessages(
    raw.messages,
    '$.messages',
    schemaVersion,
  );
  const activeMessages =
    activeConversationId === null
      ? []
      : hydratedConversations[activeConversationId]?.messages ?? [];
  if (!messagesEqual(projectedMessages, activeMessages)) {
    return invalid(
      '$.messages',
      'must exactly mirror the active conversation messages',
    );
  }

  return {
    schemaVersion: CHAT_STATE_SCHEMA_VERSION,
    projectContextDestructiveEpoch: destructiveEpoch,
    projectContextDestructiveTransition: destructiveTransition,
    conversations: hydratedConversations,
    conversationOrder: orderConversationIds(hydratedConversations),
    selectedConversationId: activeConversationId,
  };
}

export function safeHydrateChatState(input: unknown): HydrationResult {
  try {
    return { ok: true, state: hydrateChatState(input) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof ChatStateValidationError
          ? error
          : new ChatStateValidationError('$', 'could not hydrate chat state'),
    };
  }
}

export function serializeChatState(state: ChatState): string {
  try {
    const persisted = toPersistedState(state);
    hydrateChatState(persisted);
    return JSON.stringify(persisted);
  } catch (error) {
    if (error instanceof ChatStateValidationError) throw error;
    throw new ChatStateValidationError(
      '$',
      'could not serialize chat state',
    );
  }
}

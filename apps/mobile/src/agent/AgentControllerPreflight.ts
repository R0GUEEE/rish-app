/**
 * Closed, pure controller intent seeds for the Agent lifecycle.
 *
 * This boundary validates only shape and relationships already present in the
 * seed. It does not read the Store, call native code, execute an effect, or
 * accept post-dispatch evidence.
 */
import type {
  AgentCancelTargetV2,
  AgentCancelTokenV2,
  AgentConversationGrantV2,
  AgentRuntimeControllerCASV1,
  AgentRuntimeRootV1,
  AgentRuntimeTranscriptHandleV1,
  DeepSeekModelId,
  DeepSeekThinkingMode,
} from '../native/AgentRuntime';

type AgentControllerPreflightBaseV1 = {
  readonly schema_version: 1;
  readonly source: 'completion_controller';
  readonly operation_id: string;
  readonly base_cas: AgentRuntimeControllerCASV1;
  readonly conversation_id: string;
  readonly task_id: string;
  readonly attempt_id: string;
};

export type AgentBeginRoundPreflightV1 = AgentControllerPreflightBaseV1 & {
  readonly kind: 'begin_round';
  readonly round_id: string;
  readonly round_index: number;
  readonly launch_attempt: number;
  readonly expected_round_revision: number;
  readonly transport_schema_version: 2 | 3;
  readonly model: DeepSeekModelId;
  readonly thinking_mode: DeepSeekThinkingMode;
  readonly visible_history_sha256: string;
  readonly visible_message_count: number;
  readonly project_context_sha256: string | null;
  readonly transcript: AgentRuntimeTranscriptHandleV1;
  readonly root: AgentRuntimeRootV1;
  readonly registry_version: 1;
  readonly toolset_sha256: string;
};

export type AgentApprovalDecisionPreflightV1 =
  AgentControllerPreflightBaseV1 & {
    readonly kind: 'decide_approval';
    readonly round_id: string;
    readonly round_index: number;
    readonly batch_revision: number;
    readonly manifest_sha256: string;
    readonly call_index: number;
    readonly call_id: string;
    readonly name: string;
    readonly arguments_sha256: string;
    readonly approval_token: string;
    readonly decision:
      | 'denied'
      | 'allow_once'
      | 'allow_conversation'
      | 'cancelled';
    readonly source_event_id: string;
    readonly access: 'conversation_confirm' | 'confirm_once';
    readonly workspace_id: string;
    readonly project_id: string | null;
    readonly binding_revision: number;
    readonly root_fingerprint_sha256: string;
    readonly policy_version: 'agent-v1';
    readonly registry_version: 1;
    readonly tool_family: 'file_write' | 'git_commit' | null;
    readonly grant: AgentConversationGrantV2 | null;
  };

export type AgentBeginExecutionPreflightV1 =
  AgentControllerPreflightBaseV1 & {
    readonly kind: 'begin_execution';
    readonly round_id: string;
    readonly round_index: number;
    readonly batch_kind: 'write_batch' | 'read_only_batch';
    readonly batch_revision: number;
    readonly manifest_sha256: string | null;
    readonly call_index: number;
    readonly call_id: string;
    readonly name: string;
    readonly arguments_sha256: string;
    readonly idempotency_key: string;
    readonly expected_execution_revision: number;
    readonly transcript: AgentRuntimeTranscriptHandleV1;
    readonly root: AgentRuntimeRootV1;
    readonly access: 'auto' | 'conversation_confirm' | 'confirm_once';
    readonly approval_state: 'not_required' | 'bound';
    readonly approval_reference: string | null;
    readonly source_event_id: string;
  };

export type AgentCancelPreflightV1 = AgentControllerPreflightBaseV1 & {
  readonly kind: 'request_cancel';
  readonly target: AgentCancelTargetV2;
  readonly cancel_token: AgentCancelTokenV2;
  readonly expected_round_revision: number | null;
  readonly expected_execution_revision: number | null;
  readonly expected_transcript: AgentRuntimeTranscriptHandleV1;
  readonly root: AgentRuntimeRootV1;
};

export type AgentControllerPreflightV1 =
  | AgentBeginRoundPreflightV1
  | AgentApprovalDecisionPreflightV1
  | AgentBeginExecutionPreflightV1
  | AgentCancelPreflightV1;

type RecordValue = Record<string, unknown>;

const MAX_SAFE = Number.MAX_SAFE_INTEGER - 1;
const MAX_ROUNDS = 7;
const MAX_CALLS = 15;
const MAX_VISIBLE_MESSAGES = 96;
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const OPAQUE = /^[A-Za-z0-9._:-]{1,128}$/u;
const TOOL_NAME = /^[A-Za-z0-9._:-]{1,64}$/u;

const COMMON_KEYS = [
  'schema_version',
  'source',
  'kind',
  'operation_id',
  'base_cas',
  'conversation_id',
  'task_id',
  'attempt_id',
] as const;

const BEGIN_ROUND_KEYS = [
  ...COMMON_KEYS,
  'round_id',
  'round_index',
  'launch_attempt',
  'expected_round_revision',
  'transport_schema_version',
  'model',
  'thinking_mode',
  'visible_history_sha256',
  'visible_message_count',
  'project_context_sha256',
  'transcript',
  'root',
  'registry_version',
  'toolset_sha256',
] as const;

const DECIDE_APPROVAL_KEYS = [
  ...COMMON_KEYS,
  'round_id',
  'round_index',
  'batch_revision',
  'manifest_sha256',
  'call_index',
  'call_id',
  'name',
  'arguments_sha256',
  'approval_token',
  'decision',
  'source_event_id',
  'access',
  'workspace_id',
  'project_id',
  'binding_revision',
  'root_fingerprint_sha256',
  'policy_version',
  'registry_version',
  'tool_family',
  'grant',
] as const;

const BEGIN_EXECUTION_KEYS = [
  ...COMMON_KEYS,
  'round_id',
  'round_index',
  'batch_kind',
  'batch_revision',
  'manifest_sha256',
  'call_index',
  'call_id',
  'name',
  'arguments_sha256',
  'idempotency_key',
  'expected_execution_revision',
  'transcript',
  'root',
  'access',
  'approval_state',
  'approval_reference',
  'source_event_id',
] as const;

const REQUEST_CANCEL_KEYS = [
  ...COMMON_KEYS,
  'target',
  'cancel_token',
  'expected_round_revision',
  'expected_execution_revision',
  'expected_transcript',
  'root',
] as const;

function ownRecord(value: unknown): RecordValue | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const result = Object.create(null) as RecordValue;
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        descriptor.enumerable !== true
      )
        return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function exact(value: unknown, keys: readonly string[]): RecordValue | null {
  const record = ownRecord(value);
  if (record === null) return null;
  const allowed = new Set(keys);
  const names = Object.keys(record);
  if (names.length !== keys.length || names.some(key => !allowed.has(key)))
    return null;
  return record;
}

function exactArray(value: unknown, maximum: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
      return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      lengthDescriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ||
      lengthDescriptor.enumerable !== false ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      Object.is(lengthDescriptor.value, -0) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maximum
    )
      return null;
    const length = lengthDescriptor.value as number;
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
      )
        return null;
      result.push(descriptor.value);
    }
    if (Object.getOwnPropertyNames(value).some(key => !allowed.has(key)))
      return null;
    return result;
  } catch {
    return null;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value))
    return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    const entry = (value as Record<string, unknown>)[key];
    deepFreeze(entry);
  }
  return Object.freeze(value);
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function nullableDigest(value: unknown): value is string | null {
  return value === null || digest(value);
}

function opaque(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE.test(value);
}

function toolName(value: unknown): value is string {
  return typeof value === 'string' && TOOL_NAME.test(value);
}

function safeInteger(
  value: unknown,
  maximum = MAX_SAFE,
  allowZero = true,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= (allowZero ? 0 : 1) &&
    value <= maximum
  );
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function model(value: unknown): value is DeepSeekModelId {
  return (
    value === 'deepseek-v4-flash' ||
    value === 'deepseek-v4-pro' ||
    value === 'deepseek-v4-flash-vision-exp'
  );
}

function thinkingMode(value: unknown): value is DeepSeekThinkingMode {
  return value === 'off' || value === 'high' || value === 'max';
}

function validateCAS(value: unknown): AgentRuntimeControllerCASV1 | null {
  const cas = exact(value, [
    'schema_version',
    'conversation_id',
    'task_id',
    'attempt_id',
    'expected_controller_generation',
    'expected_journal_revision',
    'expected_session_generation',
    'expected_session_sha256',
  ]);
  if (
    cas === null ||
    cas.schema_version !== 1 ||
    !uuid(cas.conversation_id) ||
    !uuid(cas.task_id) ||
    !uuid(cas.attempt_id) ||
    !safeInteger(cas.expected_controller_generation) ||
    !safeInteger(cas.expected_journal_revision) ||
    !safeInteger(cas.expected_session_generation, MAX_SAFE, false) ||
    !digest(cas.expected_session_sha256)
  )
    return null;
  return {
    schema_version: 1,
    conversation_id: cas.conversation_id,
    task_id: cas.task_id,
    attempt_id: cas.attempt_id,
    expected_controller_generation: cas.expected_controller_generation,
    expected_journal_revision: cas.expected_journal_revision,
    expected_session_generation: cas.expected_session_generation,
    expected_session_sha256: cas.expected_session_sha256,
  };
}

function validateTranscript(
  value: unknown,
): AgentRuntimeTranscriptHandleV1 | null {
  const transcript = exact(value, [
    'schema_version',
    'transcript_ref',
    'generation',
    'transcript_sha256',
    'transcript_bytes',
  ]);
  if (
    transcript === null ||
    transcript.schema_version !== 1 ||
    !uuid(transcript.transcript_ref) ||
    !safeInteger(transcript.generation) ||
    !digest(transcript.transcript_sha256) ||
    !safeInteger(transcript.transcript_bytes, MAX_TRANSCRIPT_BYTES)
  )
    return null;
  return {
    schema_version: 1,
    transcript_ref: transcript.transcript_ref,
    generation: transcript.generation,
    transcript_sha256: transcript.transcript_sha256,
    transcript_bytes: transcript.transcript_bytes,
  };
}

function validateRoot(value: unknown): AgentRuntimeRootV1 | null {
  const root = exact(value, [
    'schema_version',
    'kind',
    'workspace_id',
    'workspace_binding_revision',
    'project_id',
    'root_fingerprint_sha256',
    'capabilities',
  ]);
  if (
    root === null ||
    root.schema_version !== 1 ||
    (root.kind !== 'project' && root.kind !== 'workspace') ||
    !uuid(root.workspace_id) ||
    !safeInteger(root.workspace_binding_revision, MAX_SAFE, false) ||
    (root.project_id !== null && !uuid(root.project_id)) ||
    (root.kind === 'project') !== (root.project_id !== null) ||
    !digest(root.root_fingerprint_sha256)
  )
    return null;
  const rawCapabilities = exactArray(root.capabilities, 5);
  if (rawCapabilities === null) return null;
  const allowed = new Set([
    'file_read',
    'file_write',
    'git_status',
    'git_commit',
    'git_push',
  ]);
  const capabilities: AgentRuntimeRootV1['capabilities'][number][] = [];
  const seen = new Set<string>();
  for (const capability of rawCapabilities) {
    if (
      typeof capability !== 'string' ||
      !allowed.has(capability) ||
      seen.has(capability) ||
      (root.kind === 'workspace' && capability.startsWith('git_'))
    )
      return null;
    seen.add(capability);
    capabilities.push(
      capability as AgentRuntimeRootV1['capabilities'][number],
    );
  }
  return {
    schema_version: 1,
    kind: root.kind,
    workspace_id: root.workspace_id,
    workspace_binding_revision: root.workspace_binding_revision,
    project_id: root.project_id,
    root_fingerprint_sha256: root.root_fingerprint_sha256,
    capabilities,
  };
}

function validateGrant(value: unknown): AgentConversationGrantV2 | null {
  const grant = exact(value, [
    'schema_version',
    'grant_id',
    'conversation_id',
    'workspace_id',
    'project_id',
    'binding_revision',
    'root_fingerprint_sha256',
    'tool_family',
    'registry_version',
    'policy_version',
    'issued_for',
    'created_at',
  ]);
  if (
    grant === null ||
    grant.schema_version !== 2 ||
    !uuid(grant.grant_id) ||
    !uuid(grant.conversation_id) ||
    !uuid(grant.workspace_id) ||
    (grant.project_id !== null && !uuid(grant.project_id)) ||
    !safeInteger(grant.binding_revision, MAX_SAFE, false) ||
    !digest(grant.root_fingerprint_sha256) ||
    (grant.tool_family !== 'file_write' && grant.tool_family !== 'git_commit') ||
    (grant.tool_family === 'git_commit' && grant.project_id === null) ||
    grant.registry_version !== 1 ||
    !opaque(grant.policy_version) ||
    !timestamp(grant.created_at)
  )
    return null;
  const issuedFor = exact(grant.issued_for, [
    'schema_version',
    'task_id',
    'attempt_id',
  ]);
  if (
    issuedFor === null ||
    issuedFor.schema_version !== 1 ||
    !uuid(issuedFor.task_id) ||
    !uuid(issuedFor.attempt_id)
  )
    return null;
  return {
    schema_version: 2,
    grant_id: grant.grant_id,
    conversation_id: grant.conversation_id,
    workspace_id: grant.workspace_id,
    project_id: grant.project_id,
    binding_revision: grant.binding_revision,
    root_fingerprint_sha256: grant.root_fingerprint_sha256,
    tool_family: grant.tool_family,
    registry_version: 1,
    policy_version: grant.policy_version,
    issued_for: {
      schema_version: 1,
      task_id: issuedFor.task_id,
      attempt_id: issuedFor.attempt_id,
    },
    created_at: grant.created_at,
  };
}

function validateTarget(value: unknown): AgentCancelTargetV2 | null {
  const header = ownRecord(value);
  if (header === null || header.schema_version !== 2) return null;
  if (header.kind === 'attempt') {
    const target = exact(value, [
      'schema_version',
      'kind',
      'task_id',
      'attempt_id',
    ]);
    if (
      target === null ||
      !uuid(target.task_id) ||
      !uuid(target.attempt_id)
    )
      return null;
    return {
      schema_version: 2,
      kind: 'attempt',
      task_id: target.task_id,
      attempt_id: target.attempt_id,
    };
  }
  if (header.kind === 'round') {
    const target = exact(value, [
      'schema_version',
      'kind',
      'task_id',
      'attempt_id',
      'round_id',
      'round_index',
    ]);
    if (
      target === null ||
      !uuid(target.task_id) ||
      !uuid(target.attempt_id) ||
      !uuid(target.round_id) ||
      !safeInteger(target.round_index, MAX_ROUNDS)
    )
      return null;
    return {
      schema_version: 2,
      kind: 'round',
      task_id: target.task_id,
      attempt_id: target.attempt_id,
      round_id: target.round_id,
      round_index: target.round_index,
    };
  }
  if (header.kind === 'tool') {
    const target = exact(value, [
      'schema_version',
      'kind',
      'task_id',
      'attempt_id',
      'round_id',
      'round_index',
      'call_index',
      'call_id',
      'idempotency_key',
    ]);
    if (
      target === null ||
      !uuid(target.task_id) ||
      !uuid(target.attempt_id) ||
      !uuid(target.round_id) ||
      !safeInteger(target.round_index, MAX_ROUNDS) ||
      !safeInteger(target.call_index, MAX_CALLS) ||
      !opaque(target.call_id) ||
      !digest(target.idempotency_key)
    )
      return null;
    return {
      schema_version: 2,
      kind: 'tool',
      task_id: target.task_id,
      attempt_id: target.attempt_id,
      round_id: target.round_id,
      round_index: target.round_index,
      call_index: target.call_index,
      call_id: target.call_id,
      idempotency_key: target.idempotency_key,
    };
  }
  return null;
}

function validateCancelToken(value: unknown): AgentCancelTokenV2 | null {
  const token = exact(value, [
    'schema_version',
    'issuer',
    'source_event_id',
    'token',
    'task_id',
    'attempt_id',
    'expected_phase',
    'reason_code',
  ]);
  if (
    token === null ||
    token.schema_version !== 2 ||
    token.issuer !== 'completion_controller' ||
    !uuid(token.source_event_id) ||
    token.token !== token.source_event_id ||
    !uuid(token.task_id) ||
    !uuid(token.attempt_id) ||
    (token.expected_phase !== 'round_in_flight' &&
      token.expected_phase !== 'approval_pending' &&
      token.expected_phase !== 'execution_intent' &&
      token.expected_phase !== 'tool_result_pending') ||
    (token.reason_code !== 'E_AGENT_CANCELLED' &&
      token.reason_code !== 'E_AGENT_ROOT_STALE' &&
      token.reason_code !== 'E_AGENT_PERSISTENCE')
  )
    return null;
  return {
    schema_version: 2,
    issuer: 'completion_controller',
    source_event_id: token.source_event_id,
    token: token.source_event_id,
    task_id: token.task_id,
    attempt_id: token.attempt_id,
    expected_phase: token.expected_phase,
    reason_code: token.reason_code,
  };
}

function validateCommon(raw: RecordValue): AgentControllerPreflightBaseV1 | null {
  if (
    raw.schema_version !== 1 ||
    raw.source !== 'completion_controller' ||
    !uuid(raw.operation_id) ||
    !uuid(raw.conversation_id) ||
    !uuid(raw.task_id) ||
    !uuid(raw.attempt_id)
  )
    return null;
  const cas = validateCAS(raw.base_cas);
  if (
    cas === null ||
    cas.conversation_id !== raw.conversation_id ||
    cas.task_id !== raw.task_id ||
    cas.attempt_id !== raw.attempt_id
  )
    return null;
  return {
    schema_version: 1,
    source: 'completion_controller',
    operation_id: raw.operation_id,
    base_cas: cas,
    conversation_id: raw.conversation_id,
    task_id: raw.task_id,
    attempt_id: raw.attempt_id,
  };
}

function validateBeginRound(value: unknown): AgentBeginRoundPreflightV1 | null {
  const raw = exact(value, BEGIN_ROUND_KEYS);
  if (
    raw === null ||
    raw.kind !== 'begin_round' ||
    !uuid(raw.round_id) ||
    !safeInteger(raw.round_index, MAX_ROUNDS) ||
    !safeInteger(raw.launch_attempt, 8, false) ||
    !safeInteger(raw.expected_round_revision) ||
    (raw.transport_schema_version !== 2 && raw.transport_schema_version !== 3) ||
    !model(raw.model) ||
    !thinkingMode(raw.thinking_mode) ||
    !digest(raw.visible_history_sha256) ||
    !safeInteger(raw.visible_message_count, MAX_VISIBLE_MESSAGES) ||
    !nullableDigest(raw.project_context_sha256) ||
    raw.registry_version !== 1 ||
    !digest(raw.toolset_sha256)
  )
    return null;
  const common = validateCommon(raw);
  const transcript = validateTranscript(raw.transcript);
  const root = validateRoot(raw.root);
  if (common === null || transcript === null || root === null) return null;
  if (
    (raw.transport_schema_version === 2 &&
      raw.project_context_sha256 !== null) ||
    (raw.transport_schema_version === 3 &&
      (raw.project_context_sha256 === null ||
        root.kind !== 'project' ||
        root.project_id === null))
  )
    return null;
  return {
    ...common,
    kind: 'begin_round',
    round_id: raw.round_id,
    round_index: raw.round_index,
    launch_attempt: raw.launch_attempt,
    expected_round_revision: raw.expected_round_revision,
    transport_schema_version: raw.transport_schema_version,
    model: raw.model,
    thinking_mode: raw.thinking_mode,
    visible_history_sha256: raw.visible_history_sha256,
    visible_message_count: raw.visible_message_count,
    project_context_sha256: raw.project_context_sha256,
    transcript,
    root,
    registry_version: 1,
    toolset_sha256: raw.toolset_sha256,
  };
}

function validateApproval(
  value: unknown,
): AgentApprovalDecisionPreflightV1 | null {
  const raw = exact(value, DECIDE_APPROVAL_KEYS);
  if (
    raw === null ||
    raw.kind !== 'decide_approval' ||
    !uuid(raw.round_id) ||
    !safeInteger(raw.round_index, MAX_ROUNDS) ||
    !safeInteger(raw.batch_revision, MAX_SAFE, false) ||
    !digest(raw.manifest_sha256) ||
    !safeInteger(raw.call_index, MAX_CALLS) ||
    !opaque(raw.call_id) ||
    !toolName(raw.name) ||
    !digest(raw.arguments_sha256) ||
    !opaque(raw.approval_token) ||
    (raw.decision !== 'denied' &&
      raw.decision !== 'allow_once' &&
      raw.decision !== 'allow_conversation' &&
      raw.decision !== 'cancelled') ||
    !uuid(raw.source_event_id) ||
    (raw.access !== 'conversation_confirm' && raw.access !== 'confirm_once') ||
    !uuid(raw.workspace_id) ||
    (raw.project_id !== null && !uuid(raw.project_id)) ||
    !safeInteger(raw.binding_revision, MAX_SAFE, false) ||
    !digest(raw.root_fingerprint_sha256) ||
    raw.policy_version !== 'agent-v1' ||
    raw.registry_version !== 1 ||
    (raw.tool_family !== 'file_write' &&
      raw.tool_family !== 'git_commit' &&
      raw.tool_family !== null)
  )
    return null;
  const common = validateCommon(raw);
  if (common === null || common.operation_id !== raw.source_event_id) return null;
  if (
    (raw.name === 'write_file' &&
      (raw.access !== 'conversation_confirm' ||
        raw.tool_family !== 'file_write')) ||
    (raw.name === 'git_commit' &&
      (raw.access !== 'conversation_confirm' ||
        raw.tool_family !== 'git_commit' ||
        raw.project_id === null)) ||
    (raw.name === 'git_push' &&
      (raw.access !== 'confirm_once' ||
        raw.tool_family !== null ||
        raw.project_id === null ||
        raw.decision === 'allow_conversation')) ||
    (raw.name !== 'write_file' &&
      raw.name !== 'git_commit' &&
      raw.name !== 'git_push')
  )
    return null;
  const grant = raw.grant === null ? null : validateGrant(raw.grant);
  if (raw.grant !== null && grant === null) return null;
  if (raw.decision === 'allow_conversation') {
    if (
      grant === null ||
      grant.conversation_id !== common.conversation_id ||
      grant.issued_for.task_id !== common.task_id ||
      grant.issued_for.attempt_id !== common.attempt_id ||
      grant.workspace_id !== raw.workspace_id ||
      grant.project_id !== raw.project_id ||
      grant.binding_revision !== raw.binding_revision ||
      grant.root_fingerprint_sha256 !== raw.root_fingerprint_sha256 ||
      grant.policy_version !== raw.policy_version ||
      grant.registry_version !== raw.registry_version ||
      grant.tool_family !== raw.tool_family
    )
      return null;
  } else if (grant !== null) return null;
  return {
    ...common,
    kind: 'decide_approval',
    round_id: raw.round_id,
    round_index: raw.round_index,
    batch_revision: raw.batch_revision,
    manifest_sha256: raw.manifest_sha256,
    call_index: raw.call_index,
    call_id: raw.call_id,
    name: raw.name,
    arguments_sha256: raw.arguments_sha256,
    approval_token: raw.approval_token,
    decision: raw.decision,
    source_event_id: raw.source_event_id,
    access: raw.access,
    workspace_id: raw.workspace_id,
    project_id: raw.project_id,
    binding_revision: raw.binding_revision,
    root_fingerprint_sha256: raw.root_fingerprint_sha256,
    policy_version: 'agent-v1',
    registry_version: 1,
    tool_family: raw.tool_family,
    grant,
  };
}

function validateExecution(
  value: unknown,
): AgentBeginExecutionPreflightV1 | null {
  const raw = exact(value, BEGIN_EXECUTION_KEYS);
  if (
    raw === null ||
    raw.kind !== 'begin_execution' ||
    !uuid(raw.round_id) ||
    !safeInteger(raw.round_index, MAX_ROUNDS) ||
    (raw.batch_kind !== 'write_batch' && raw.batch_kind !== 'read_only_batch') ||
    !safeInteger(raw.batch_revision, MAX_SAFE, false) ||
    !nullableDigest(raw.manifest_sha256) ||
    !safeInteger(raw.call_index, MAX_CALLS) ||
    !opaque(raw.call_id) ||
    !toolName(raw.name) ||
    !digest(raw.arguments_sha256) ||
    !digest(raw.idempotency_key) ||
    !safeInteger(raw.expected_execution_revision, MAX_SAFE, false) ||
    (raw.access !== 'auto' &&
      raw.access !== 'conversation_confirm' &&
      raw.access !== 'confirm_once') ||
    (raw.approval_state !== 'not_required' &&
      raw.approval_state !== 'bound') ||
    (raw.approval_reference !== null && !uuid(raw.approval_reference)) ||
    !uuid(raw.source_event_id)
  )
    return null;
  if (
    (raw.batch_kind === 'write_batch' && raw.manifest_sha256 === null) ||
    (raw.batch_kind === 'read_only_batch' && raw.manifest_sha256 !== null)
  )
    return null;
  if (
    ((raw.name === 'list_dir' ||
      raw.name === 'read_file' ||
      raw.name === 'git_status') &&
      (raw.access !== 'auto' ||
        raw.approval_state !== 'not_required' ||
        raw.approval_reference !== null)) ||
    ((raw.name === 'write_file' || raw.name === 'git_commit') &&
      (raw.batch_kind !== 'write_batch' ||
        raw.access !== 'conversation_confirm' ||
        raw.approval_state !== 'bound' ||
        raw.approval_reference === null)) ||
    (raw.name === 'git_push' &&
      (raw.batch_kind !== 'write_batch' ||
        raw.access !== 'confirm_once' ||
        raw.approval_state !== 'bound' ||
        raw.approval_reference === null)) ||
    (raw.name !== 'list_dir' &&
      raw.name !== 'read_file' &&
      raw.name !== 'git_status' &&
      raw.name !== 'write_file' &&
      raw.name !== 'git_commit' &&
      raw.name !== 'git_push')
  )
    return null;
  const common = validateCommon(raw);
  const transcript = validateTranscript(raw.transcript);
  const root = validateRoot(raw.root);
  if (
    common === null ||
    transcript === null ||
    root === null ||
    common.operation_id !== raw.source_event_id
  )
    return null;
  const requiredCapability: AgentRuntimeRootV1['capabilities'][number] =
    raw.name === 'list_dir' || raw.name === 'read_file'
      ? 'file_read'
      : raw.name === 'write_file'
        ? 'file_write'
      : (raw.name as AgentRuntimeRootV1['capabilities'][number]);
  if (!root.capabilities.includes(requiredCapability)) return null;
  return {
    ...common,
    kind: 'begin_execution',
    round_id: raw.round_id,
    round_index: raw.round_index,
    batch_kind: raw.batch_kind,
    batch_revision: raw.batch_revision,
    manifest_sha256: raw.manifest_sha256,
    call_index: raw.call_index,
    call_id: raw.call_id,
    name: raw.name,
    arguments_sha256: raw.arguments_sha256,
    idempotency_key: raw.idempotency_key,
    expected_execution_revision: raw.expected_execution_revision,
    transcript,
    root,
    access: raw.access,
    approval_state: raw.approval_state,
    approval_reference: raw.approval_reference,
    source_event_id: raw.source_event_id,
  };
}

function validateCancellation(value: unknown): AgentCancelPreflightV1 | null {
  const raw = exact(value, REQUEST_CANCEL_KEYS);
  if (raw === null || raw.kind !== 'request_cancel') return null;
  const common = validateCommon(raw);
  const target = validateTarget(raw.target);
  const cancelToken = validateCancelToken(raw.cancel_token);
  const transcript = validateTranscript(raw.expected_transcript);
  const root = validateRoot(raw.root);
  if (
    common === null ||
    target === null ||
    cancelToken === null ||
    transcript === null ||
    root === null ||
    common.operation_id !== cancelToken.source_event_id ||
    common.operation_id !== cancelToken.token ||
    target.task_id !== common.task_id ||
    target.attempt_id !== common.attempt_id ||
    cancelToken.task_id !== common.task_id ||
    cancelToken.attempt_id !== common.attempt_id ||
    (raw.expected_round_revision !== null &&
      !safeInteger(raw.expected_round_revision, MAX_SAFE)) ||
    (raw.expected_execution_revision !== null &&
      !safeInteger(raw.expected_execution_revision, MAX_SAFE, false))
  )
    return null;
  const roundRevision = raw.expected_round_revision;
  const executionRevision = raw.expected_execution_revision;
  if (target.kind === 'attempt') {
    if (roundRevision !== null || executionRevision !== null) return null;
  } else if (target.kind === 'round') {
    if (
      cancelToken.expected_phase !== 'round_in_flight' ||
      roundRevision === null ||
      executionRevision !== null
    )
      return null;
  } else if (
    (cancelToken.expected_phase !== 'execution_intent' &&
      cancelToken.expected_phase !== 'tool_result_pending') ||
    roundRevision !== null ||
    executionRevision === null
  )
    return null;
  return {
    ...common,
    kind: 'request_cancel',
    target,
    cancel_token: cancelToken,
    expected_round_revision: raw.expected_round_revision as number | null,
    expected_execution_revision:
      raw.expected_execution_revision as number | null,
    expected_transcript: transcript,
    root,
  };
}

/**
 * Maps an untrusted controller seed into the closed V1 union. Invalid or
 * evidence-bearing inputs fail closed and return null.
 */
export function validateAgentControllerPreflight(
  value: unknown,
): AgentControllerPreflightV1 | null {
  const header = ownRecord(value);
  if (header === null) return null;
  let mapped: AgentControllerPreflightV1 | null;
  switch (header.kind) {
    case 'begin_round':
      mapped = validateBeginRound(value);
      break;
    case 'decide_approval':
      mapped = validateApproval(value);
      break;
    case 'begin_execution':
      mapped = validateExecution(value);
      break;
    case 'request_cancel':
      mapped = validateCancellation(value);
      break;
    default:
      return null;
  }
  return mapped === null ? null : deepFreeze(mapped);
}

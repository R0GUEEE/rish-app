/**
 * Pure V3 Agent journal reducer.
 *
 * Native state crosses this boundary only as a closed high-level
 * request/result pair. The mapper is called again here because a typed value
 * can still be forged by JavaScript callers. Invalid or conflicting evidence
 * returns the exact input state and never advances the journal.
 */
import {
  MAX_AGENT_CALLS_PER_BATCH,
  MAX_AGENT_DURATION_MS,
  MAX_AGENT_RESULT_BYTES,
  MAX_AGENT_ROUNDS,
  MAX_AGENT_SINGLE_WRITE_BYTES,
  MAX_AGENT_TRANSCRIPT_BYTES,
  AGENT_SAFE_SUMMARY_KEYS,
  isAgentPhaseLineageValid,
  type AgentAccess,
  type AgentApprovalDecision,
  type AgentConversationGrantV2,
  type AgentRuntimePolicyV1,
  type AgentRuntimeRootV1,
  type AgentRuntimeTranscriptHandleV1,
  type AgentToolReceiptV1,
  type PersistedAgentAttemptJournalV3,
  type PersistedAgentCallJournalV3,
} from '../state/types';
import {
  validateAgentStoreTransition,
  type AgentStoreOperation,
  type AgentStoreTransitionEvidence,
} from './AgentStoreTransitions';
import {
  validateAgentControllerPreflight,
  type AgentControllerPreflightV1,
} from './AgentControllerPreflight';

export type AgentAttemptPhase = PersistedAgentAttemptJournalV3['phase'];
export type AgentCallJournalV3 = PersistedAgentCallJournalV3;
export type AgentCallJournal = AgentCallJournalV3;
export type AgentRoundState = PersistedAgentAttemptJournalV3;
export type AgentRoundEvidence =
  | AgentStoreTransitionEvidence
  | AgentControllerPreflightV1;

export const AGENT_AUTO_TOOLS = ['list_dir', 'read_file', 'git_status'] as const;
export const AGENT_CONFIRM_TOOLS = ['write_file', 'git_commit', 'git_push'] as const;
export const AGENT_ONCE_ONLY_TOOLS = [] as const;
export const AGENT_TOOL_NAMES = [
  ...AGENT_AUTO_TOOLS,
  ...AGENT_CONFIRM_TOOLS,
  ...AGENT_ONCE_ONLY_TOOLS,
] as const;

const autoTools = new Set<string>(AGENT_AUTO_TOOLS);
const confirmTools = new Set<string>(AGENT_CONFIRM_TOOLS);
const onceTools = new Set<string>(AGENT_ONCE_ONLY_TOOLS);
const allTools = new Set<string>(AGENT_TOOL_NAMES);
const safeSummaryKeys = new Set<string>(AGENT_SAFE_SUMMARY_KEYS);
const failureCodes = new Set<string>([
  'E_AGENT_UNKNOWN_TOOL', 'E_AGENT_BAD_ARGUMENTS', 'E_AGENT_BAD_PATH',
  'E_AGENT_NO_ROOT', 'E_AGENT_ROOT_STALE', 'E_AGENT_CAPABILITY',
  'E_AGENT_APPROVAL', 'E_AGENT_TRANSCRIPT', 'E_AGENT_LEDGER',
  'E_AGENT_ROUND_AMBIGUOUS', 'E_AGENT_EXECUTION_AMBIGUOUS',
  'E_AGENT_RETRY_LINEAGE', 'E_AGENT_PERSISTENCE', 'E_AGENT_CONFLICT',
  'E_AGENT_ROUND_LIMIT', 'E_AGENT_CANCELLED', 'E_AGENT_TOOL_FAILED',
  'E_AGENT_NON_FAST_FORWARD', 'E_AGENT_AUTH_FAILED', 'E_AGENT_TIMEOUT',
  'E_COMPLETION_LENGTH', 'E_COMPLETION_CONTENT_FILTER',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const OPAQUE = /^[A-Za-z0-9._:-]{1,128}$/u;
const PRINTABLE = /^[\x21-\x7e]+$/u;

export function agentToolAccess(name: string): AgentAccess {
  if (autoTools.has(name)) return 'auto';
  if (confirmTools.has(name)) return 'conversation_confirm';
  if (onceTools.has(name)) return 'confirm_once';
  return 'durable_deny';
}
export const getAgentToolAccess = agentToolAccess;
export const isKnownAgentTool = (name: string): boolean => allTools.has(name);

export function isAgentGrantUsable(
  grant: AgentConversationGrantV2,
  input: {
    readonly conversation_id: string;
    readonly workspace_id: string;
    readonly project_id: string | null;
    readonly binding_revision: number;
    readonly root_fingerprint_sha256: string;
    readonly tool_family: 'file_write' | 'git_commit' | 'git_push';
    readonly registry_version: 1;
    readonly policy_version: string;
  },
): boolean {
  return grant.schema_version === 2 &&
    grant.conversation_id === input.conversation_id &&
    grant.workspace_id === input.workspace_id &&
    grant.project_id === input.project_id &&
    grant.binding_revision === input.binding_revision &&
    grant.root_fingerprint_sha256 === input.root_fingerprint_sha256 &&
    grant.tool_family === input.tool_family &&
    grant.registry_version === input.registry_version &&
    grant.policy_version === input.policy_version;
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE.test(value);
}
function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}
function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function ownRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.enumerable !== true) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const record = ownRecord(value);
  if (record === null) return null;
  const names = Object.keys(record);
  return names.length === keys.length && names.every(key => keys.includes(key)) ? record : null;
}
function exactRecordOptional(value: unknown, required: readonly string[], optional: readonly string[]): Record<string, unknown> | null {
  const record = ownRecord(value);
  if (record === null) return null;
  const allowed = new Set([...required, ...optional]);
  const names = Object.keys(record);
  if (names.some(key => !allowed.has(key)) || required.some(key => !Object.prototype.hasOwnProperty.call(record, key))) return null;
  return record;
}

function cloneReceipt(receipt: AgentToolReceiptV1): AgentToolReceiptV1 { return { ...receipt }; }
function cloneCall(call: PersistedAgentCallJournalV3): PersistedAgentCallJournalV3 {
  return { ...call, receipt: call.receipt === null ? null : cloneReceipt(call.receipt) };
}
function cloneJournal(journal: AgentRoundState): AgentRoundState {
  return {
    ...journal,
    root: { ...journal.root, capabilities: [...journal.root.capabilities] },
    policy: { ...journal.policy },
    transcript: { ...journal.transcript },
    round_lineage: journal.round_lineage === null ? null : { ...journal.round_lineage },
    batch: journal.batch.map(cloneCall),
    frozen_grant_ids: [...journal.frozen_grant_ids],
  };
}
function sameAgentTranscript(
  left: AgentRuntimeTranscriptHandleV1,
  right: AgentRuntimeTranscriptHandleV1,
): boolean {
  return left.schema_version === right.schema_version &&
    left.transcript_ref === right.transcript_ref &&
    left.generation === right.generation &&
    left.transcript_sha256 === right.transcript_sha256 &&
    left.transcript_bytes === right.transcript_bytes;
}

function validRoot(root: AgentRuntimeRootV1): boolean {
  if (root.schema_version !== 1 || (root.kind !== 'project' && root.kind !== 'workspace') || !isCanonicalUuid(root.workspace_id) || !Number.isSafeInteger(root.workspace_binding_revision) || root.workspace_binding_revision < 1 || !isDigest(root.root_fingerprint_sha256) || (root.project_id !== null && !isCanonicalUuid(root.project_id)) || (root.kind === 'project') !== (root.project_id !== null) || !Array.isArray(root.capabilities) || root.capabilities.length > 6) return false;
  const seen = new Set<string>();
  for (const capability of root.capabilities) {
    if (!['file_read', 'file_write', 'git_status', 'git_commit', 'git_push'].includes(capability) || seen.has(capability) || (root.kind === 'workspace' && capability.startsWith('git_'))) return false;
    seen.add(capability);
  }
  return true;
}
function validPolicy(policy: AgentRuntimePolicyV1): boolean {
  return policy.schema_version === 1 && policy.policy_version === 'agent-v1' && policy.max_single_write_bytes === MAX_AGENT_SINGLE_WRITE_BYTES && Number.isSafeInteger(policy.max_batch_write_bytes) && policy.max_batch_write_bytes >= MAX_AGENT_SINGLE_WRITE_BYTES && policy.max_batch_write_bytes <= 512 * 1024 && Number.isSafeInteger(policy.max_attempt_write_bytes) && policy.max_attempt_write_bytes >= policy.max_batch_write_bytes && policy.max_attempt_write_bytes <= 4 * 1024 * 1024;
}
function validTranscript(transcript: AgentRuntimeTranscriptHandleV1): boolean {
  return transcript.schema_version === 1 && isCanonicalUuid(transcript.transcript_ref) && Number.isSafeInteger(transcript.generation) && transcript.generation >= 0 && isDigest(transcript.transcript_sha256) && Number.isSafeInteger(transcript.transcript_bytes) && transcript.transcript_bytes >= 0 && transcript.transcript_bytes <= MAX_AGENT_TRANSCRIPT_BYTES;
}
function validReceipt(receipt: AgentToolReceiptV1, call?: PersistedAgentCallJournalV3): boolean {
  return receipt.schema_version === 1 && isBoundedIdentifier(receipt.call_id) && typeof receipt.name === 'string' && PRINTABLE.test(receipt.name) && isDigest(receipt.arguments_sha256) && isDigest(receipt.result_sha256) && Number.isSafeInteger(receipt.result_bytes) && receipt.result_bytes >= 0 && receipt.result_bytes <= MAX_AGENT_RESULT_BYTES && typeof receipt.truncated === 'boolean' && Number.isSafeInteger(receipt.duration_ms) && receipt.duration_ms >= 0 && receipt.duration_ms <= MAX_AGENT_DURATION_MS && ['ok', 'failed', 'denied', 'cancelled', 'ambiguous'].includes(receipt.outcome) && (receipt.failure_code === null || failureCodes.has(receipt.failure_code)) && (receipt.approval_reference === null || isBoundedIdentifier(receipt.approval_reference)) && (receipt.outcome !== 'ok' || receipt.failure_code === null) && (receipt.outcome !== 'ambiguous' || receipt.failure_code === 'E_AGENT_EXECUTION_AMBIGUOUS') && (call === undefined || (receipt.call_id === call.call_id && receipt.name === call.name && receipt.arguments_sha256 === call.arguments_sha256 && receipt.approval_reference === call.approval_reference));
}
function validCall(call: PersistedAgentCallJournalV3, index: number): boolean {
  const access = agentToolAccess(call.name);
  if (call.schema_version !== 3 || call.call_index !== index || !isBoundedIdentifier(call.call_id) || typeof call.name !== 'string' || !PRINTABLE.test(call.name) || !isDigest(call.arguments_sha256) || !safeSummaryKeys.has(call.safe_summary_key) || call.safe_summary_key !== (allTools.has(call.name) ? `agent.${call.name}` : 'agent.unknown') || call.access !== access || !['pending', 'denied', 'allow_once', 'allow_conversation', 'cancelled'].includes(call.approval_decision) || (call.approval_token !== null && !isBoundedIdentifier(call.approval_token)) || (call.approval_reference !== null && !isBoundedIdentifier(call.approval_reference)) || (call.idempotency_key !== null && !isDigest(call.idempotency_key)) || (call.native_row_revision !== null && (!Number.isSafeInteger(call.native_row_revision) || call.native_row_revision < 1)) || (call.receipt !== null && (call.native_row_revision === null || !validReceipt(call.receipt, call)))) return false;
  if (access === 'auto' && (call.approval_token !== null || call.approval_reference !== null || call.approval_decision !== 'pending')) return false;
  if (access === 'durable_deny' && (call.approval_token !== null || call.approval_reference !== null || call.idempotency_key !== null || call.approval_decision !== 'denied')) return false;
  if ((access === 'conversation_confirm' || access === 'confirm_once') && call.approval_decision === 'pending' && call.approval_token === null) return false;
  return call.approval_decision !== 'pending' || call.approval_reference === null;
}
function agentPhase(value: unknown): value is AgentAttemptPhase {
  return value === 'ready_for_round' || value === 'round_in_flight' || value === 'batch_frozen' || value === 'approval_pending' || value === 'execution_intent' || value === 'tool_result_pending' || value === 'final_response' || value === 'cancelled' || value === 'failed' || value === 'unknown' || value === 'ambiguous';
}
function validState(state: AgentRoundState): boolean {
  if (state.schema_version !== 3 || !agentPhase(state.phase) || !Number.isSafeInteger(state.controller_generation) || state.controller_generation < 0 || !validRoot(state.root) || !validPolicy(state.policy) || state.tool_registry_version !== 1 || !isDigest(state.toolset_sha256) || !validTranscript(state.transcript) || !Number.isSafeInteger(state.round_index) || state.round_index < 0 || state.round_index >= MAX_AGENT_ROUNDS || !Array.isArray(state.batch) || state.batch.length > MAX_AGENT_CALLS_PER_BATCH || !Array.isArray(state.frozen_grant_ids) || state.frozen_grant_ids.length > 2 || state.frozen_grant_ids.some((id, index) => !isCanonicalUuid(id) || state.frozen_grant_ids.indexOf(id) !== index) || !Number.isSafeInteger(state.reserved_write_bytes) || state.reserved_write_bytes < 0 || state.reserved_write_bytes > state.policy.max_attempt_write_bytes || !isCanonicalTimestamp(state.updated_at) || !isAgentPhaseLineageValid(state.phase, state.round_lineage?.status ?? null)) return false;
  if (state.round_lineage === null) return false;
  const lineage = state.round_lineage;
  if (lineage.schema_version !== 2 || !isCanonicalUuid(lineage.round_id) || lineage.round_index !== state.round_index || !Number.isSafeInteger(lineage.launch_attempt) || lineage.launch_attempt < 1 || lineage.launch_attempt > MAX_AGENT_ROUNDS || (lineage.native_row_revision !== null && (!Number.isSafeInteger(lineage.native_row_revision) || lineage.native_row_revision < 1))) return false;
  const ids = new Set<string>();
  for (let index = 0; index < state.batch.length; index += 1) { const call = state.batch[index]!; if (!validCall(call, index) || ids.has(call.call_id)) return false; ids.add(call.call_id); }
  if (state.call_index !== null && (!Number.isSafeInteger(state.call_index) || state.call_index < 0 || state.call_index >= state.batch.length)) return false;
  if (state.phase === 'ready_for_round' && (state.batch.length !== 0 || state.call_index !== null || lineage.status !== 'ready')) return false;
  if (state.phase === 'round_in_flight' && lineage.status !== 'active' && lineage.status !== 'cancel_requested') return false;
  if ((state.phase === 'batch_frozen' || state.phase === 'approval_pending' || state.phase === 'tool_result_pending') && lineage.status !== 'completed') return false;
  if (state.phase === 'execution_intent' && lineage.status !== 'completed' && lineage.status !== 'cancel_requested') return false;
  if (state.phase === 'approval_pending' && !state.batch.some(call => call.approval_decision === 'pending' && call.approval_token !== null)) return false;
  if (state.phase === 'execution_intent') { const call = state.call_index === null ? undefined : state.batch[state.call_index]; if (call === undefined || call.idempotency_key === null || (call.access !== 'auto' && call.approval_decision !== 'allow_once' && call.approval_decision !== 'allow_conversation')) return false; }
  if (state.phase === 'tool_result_pending') { const call = state.call_index === null ? undefined : state.batch[state.call_index]; if (call === undefined || call.receipt === null || !['ok', 'failed', 'denied'].includes(call.receipt.outcome)) return false; }
  if (state.phase === 'final_response' && (state.batch.length !== 0 || state.call_index !== null || lineage.status !== 'completed')) return false;
  if (state.phase === 'cancelled' && state.batch.some(call => call.receipt === null && call.approval_decision !== 'denied' && call.approval_decision !== 'cancelled')) return false;
  if (state.phase === 'ambiguous' && lineage.status !== 'ambiguous') return false;
  if (state.phase === 'unknown' && lineage.status !== 'unknown' && lineage.status !== 'ambiguous') return false;
  return state.phase !== 'failed' || lineage.status === 'failed_retryable' || lineage.status === 'completed';
}

export type AgentRoundReducerAction =
  | { readonly type: 'prepare_attempt'; readonly evidence: AgentRoundEvidence; readonly updated_at?: string }
  | { readonly type: 'start_round'; readonly evidence: AgentRoundEvidence; readonly updated_at?: string }
  | { readonly type: 'retry_round'; readonly evidence: AgentRoundEvidence; readonly updated_at?: string }
  | { readonly type: 'freeze_batch'; readonly evidence: AgentRoundEvidence; readonly updated_at?: string }
  | { readonly type: 'decide_approval'; readonly evidence: AgentRoundEvidence; readonly updated_at?: string }
  | { readonly type: 'execution_intent'; readonly evidence: AgentRoundEvidence; readonly updated_at?: string }
  | { readonly type: 'tool_result' | 'protected_receipt'; readonly evidence: AgentRoundEvidence; readonly updated_at?: string }
  | { readonly type: 'next_round'; readonly round_id: string; readonly round_index: number; readonly launch_attempt?: number; readonly updated_at?: string }
  | { readonly type: 'next_call'; readonly updated_at?: string }
  | { readonly type: 'final_response' | 'blocked' | 'cancel' | 'recover'; readonly evidence: AgentRoundEvidence; readonly updated_at?: string }
  | { readonly type: 'fail' | 'failed' | 'invalidate_root' | 'invalidate_grants' | 'root_changed' | 'grants_changed' | 'policy_changed'; readonly evidence: AgentRoundEvidence; readonly updated_at?: string };
export type AgentRoundAction = AgentRoundReducerAction;
export type CreateAgentRoundInput = {
  readonly controller_generation?: number;
  readonly policy: AgentRuntimePolicyV1;
  readonly root: AgentRuntimeRootV1;
  readonly toolset_sha256: string;
  readonly transcript: AgentRuntimeTranscriptHandleV1;
  readonly round_index?: number;
  readonly round_id?: string;
  readonly launch_attempt?: number;
  readonly updated_at?: string;
  readonly frozen_grant_ids?: readonly string[];
  readonly reserved_write_bytes?: number;
};
export type AgentRoundReduction = { readonly state: AgentRoundState; readonly accepted: boolean };

type MutableAgentRoundState = { -readonly [Key in keyof AgentRoundState]: AgentRoundState[Key] } & { batch: PersistedAgentCallJournalV3[]; frozen_grant_ids: string[] };
function reject(state: AgentRoundState): AgentRoundReduction { return { state, accepted: false }; }
function accept(current: AgentRoundState, candidate: MutableAgentRoundState): AgentRoundReduction { if (candidate.controller_generation >= Number.MAX_SAFE_INTEGER - 1) return reject(current); candidate.controller_generation += 1; return validState(candidate) ? { state: candidate, accepted: true } : reject(current); }
function nextPendingCall(state: AgentRoundState): number | null { for (let index = 0; index < state.batch.length; index += 1) if (state.batch[index]!.receipt === null) return index; return null; }
function hasPendingApproval(state: AgentRoundState): boolean { return state.batch.some(call => call.approval_decision === 'pending' && call.approval_token !== null); }

function mappedEvidence(value: unknown): AgentStoreTransitionEvidence | null {
  try {
    const raw = exactRecord(value, ['kind', 'operation_id', 'request', 'result']);
    if (raw === null || typeof raw.kind !== 'string') return null;
    const operations: readonly AgentStoreOperation[] = ['prepare_agent_attempt', 'complete_agent_round_v2', 'prepare_agent_tool_batch', 'bind_agent_approval', 'execute_agent_tool', 'cancel_agent_attempt', 'recover_agent_attempt'];
    if (!operations.includes(raw.kind as AgentStoreOperation)) return null;
    const mapped = validateAgentStoreTransition({ operation: raw.kind, request: raw.request, result: raw.result });
    return mapped !== null && mapped.operation_id === raw.operation_id ? mapped : null;
  } catch { return null; }
}
function mappedRoundEvidence(value: unknown): AgentRoundEvidence | null {
  try {
    const preflight = validateAgentControllerPreflight(value);
    return preflight ?? mappedEvidence(value);
  } catch {
    return null;
  }
}
function evidenceCASMatchesState(evidence: AgentRoundEvidence, state: AgentRoundState): boolean {
  return evidence.kind === 'begin_round' || evidence.kind === 'decide_approval' || evidence.kind === 'begin_execution' || evidence.kind === 'request_cancel'
    ? evidence.base_cas.expected_controller_generation === state.controller_generation
    : evidence.request.controller_cas.expected_controller_generation === state.controller_generation;
}
function evidenceRoundMatchesState(evidence: AgentRoundEvidence, state: AgentRoundState): boolean {
  if (evidence.kind === 'prepare_agent_attempt' || evidence.kind === 'recover_agent_attempt') return true;
  const roundId = evidence.kind === 'begin_round' || evidence.kind === 'decide_approval' || evidence.kind === 'begin_execution'
    ? evidence.round_id
    : evidence.kind === 'request_cancel'
      ? evidence.target.kind === 'attempt' ? null : evidence.target.round_id
      : 'round_id' in evidence.request ? evidence.request.round_id : null;
  const roundIndex = evidence.kind === 'begin_round' || evidence.kind === 'decide_approval' || evidence.kind === 'begin_execution'
    ? evidence.round_index
    : evidence.kind === 'request_cancel'
      ? evidence.target.kind === 'attempt' ? null : evidence.target.round_index
      : 'round_index' in evidence.request ? evidence.request.round_index : null;
  return roundId === null || (state.round_lineage !== null && state.round_lineage.round_id === roundId && state.round_lineage.round_index === roundIndex);
}
function copyUpdatedAt(value: string | undefined, fallback: string): string | null { return value === undefined ? fallback : isCanonicalTimestamp(value) ? value : null; }

function callFromProjection(value: unknown, index: number): PersistedAgentCallJournalV3 | null {
  const raw = exactRecord(value, ['schema_version', 'call_index', 'call_id', 'name', 'arguments_sha256', 'idempotency_key', 'safe_summary_key', 'access', 'approval_state', 'approval_token', 'approval_reference', 'execution_status', 'execution_revision', 'native_row_revision', 'receipt']);
  if (raw === null || raw.schema_version !== 2 || raw.call_index !== index) return null;
  const token = raw.approval_token === null ? null : exactRecord(raw.approval_token, ['schema_version', 'token', 'controller_cas', 'task_id', 'attempt_id', 'round_id', 'round_index', 'batch_call_ids', 'batch_arguments_sha256', 'batch_revision', 'manifest_sha256', 'call_index', 'call_id', 'name', 'arguments_sha256', 'idempotency_key', 'root_fingerprint_sha256', 'binding_revision', 'policy_version', 'registry_version', 'access', 'allowed_decisions']);
  const decision: AgentApprovalDecision = raw.approval_state === 'denied' ? 'denied' : raw.approval_state === 'cancelled' ? 'cancelled' : raw.approval_state === 'bound' ? 'allow_once' : 'pending';
  return { schema_version: 3, call_index: index, call_id: raw.call_id as string, name: raw.name as string, arguments_sha256: raw.arguments_sha256 as string, safe_summary_key: raw.safe_summary_key as string, access: raw.access as AgentAccess, approval_token: token === null ? null : token.token as string, approval_decision: decision, approval_reference: raw.approval_reference as string | null, idempotency_key: raw.idempotency_key as string | null, native_row_revision: raw.native_row_revision as number | null, receipt: raw.receipt === null ? null : raw.receipt as AgentToolReceiptV1 };
}
function callFromPresentation(value: unknown, index: number): PersistedAgentCallJournalV3 | null {
  const raw = exactRecord(value, ['schema_version', 'call_index', 'call_id', 'name', 'arguments_sha256', 'safe_summary_key', 'access', 'approval_state']);
  if (raw === null || raw.schema_version !== 3 || raw.call_index !== index) return null;
  return { schema_version: 3, call_index: index, call_id: raw.call_id as string, name: raw.name as string, arguments_sha256: raw.arguments_sha256 as string, safe_summary_key: raw.safe_summary_key as string, access: raw.access as AgentAccess, approval_token: null, approval_decision: raw.approval_state === 'durable_denied' ? 'denied' : 'pending', approval_reference: null, idempotency_key: null, native_row_revision: null, receipt: null };
}
function sameReceiptForCall(receipt: AgentToolReceiptV1, call: PersistedAgentCallJournalV3): boolean { return validReceipt(receipt, call); }

function stateFromProjection(current: AgentRoundState, projection: unknown, updatedAt: string): AgentRoundState | null {
  const raw = exactRecord(projection, ['schema_version', 'task_id', 'conversation_id', 'attempt_id', 'phase', 'controller_generation', 'journal_revision', 'authority_revision', 'root', 'policy', 'registry', 'transcript', 'round_index', 'round_id', 'round_revision', 'round_status', 'batch_kind', 'batch_revision', 'manifest_sha256', 'call_index', 'batch', 'frozen_grant_ids', 'reserved_write_bytes', 'cancel_source_event_id', 'cleanup_id']);
  if (raw === null || raw.schema_version !== 2 || raw.root === null || raw.policy === null || raw.transcript === null) return null;
  const calls = Array.isArray(raw.batch) ? raw.batch.map(callFromProjection) : [];
  if (calls.some(call => call === null)) return null;
  const previous = current.round_lineage;
  const roundId = raw.round_id as string | null;
  const lineage = roundId === null ? previous : { schema_version: 2 as const, round_id: roundId, round_index: raw.round_index as number, launch_attempt: previous?.launch_attempt ?? 1, status: (raw.round_status ?? 'ready') as NonNullable<AgentRoundState['round_lineage']>['status'], native_row_revision: raw.round_revision as number | null };
  if (lineage === null) return null;
  const registry = ownRecord(raw.registry);
  return { schema_version: 3, phase: raw.phase as AgentAttemptPhase, controller_generation: raw.controller_generation as number, policy: raw.policy as AgentRuntimePolicyV1, root: raw.root as AgentRuntimeRootV1, tool_registry_version: 1, toolset_sha256: registry?.toolset_sha256 as string ?? current.toolset_sha256, transcript: raw.transcript as AgentRuntimeTranscriptHandleV1, round_index: raw.round_index as number, round_lineage: lineage, call_index: raw.call_index as number | null, batch: calls as PersistedAgentCallJournalV3[], frozen_grant_ids: raw.frozen_grant_ids as string[], reserved_write_bytes: raw.reserved_write_bytes as number, updated_at: updatedAt };
}

export function createAgentAttemptJournal(input: CreateAgentRoundInput): AgentRoundState {
  if (!isCanonicalUuid(input.round_id) || !isCanonicalTimestamp(input.updated_at)) throw new Error('invalid Agent attempt journal');
  const roundIndex = input.round_index ?? 0;
  const journal: AgentRoundState = { schema_version: 3, phase: 'ready_for_round', controller_generation: input.controller_generation ?? 0, policy: { ...input.policy }, root: { ...input.root, capabilities: [...input.root.capabilities] }, tool_registry_version: 1, toolset_sha256: input.toolset_sha256, transcript: { ...input.transcript }, round_index: roundIndex, round_lineage: { schema_version: 2, round_id: input.round_id, round_index: roundIndex, launch_attempt: input.launch_attempt ?? 1, status: 'ready', native_row_revision: null }, call_index: null, batch: [], frozen_grant_ids: [...(input.frozen_grant_ids ?? [])], reserved_write_bytes: input.reserved_write_bytes ?? 0, updated_at: input.updated_at };
  if (!validState(journal)) throw new Error('invalid Agent attempt journal');
  return journal;
}
export const createInitialAgentAttempt = createAgentAttemptJournal;

export function reduceAgentRound(current: AgentRoundState, action: AgentRoundReducerAction, timestamp?: string): AgentRoundReduction {
  if (!validState(current)) return reject(current);
  const at = copyUpdatedAt(timestamp ?? action.updated_at, current.updated_at);
  if (at === null) return reject(current);
  const evidence = 'evidence' in action ? mappedRoundEvidence(action.evidence) : null;
  if ('evidence' in action && (evidence === null || !evidenceCASMatchesState(evidence, current) || !evidenceRoundMatchesState(evidence, current))) return reject(current);
  const state = cloneJournal(current) as MutableAgentRoundState;
  switch (action.type) {
    case 'prepare_attempt': {
      if (evidence?.kind !== 'prepare_agent_attempt' || (evidence.result.status !== 'prepared' && evidence.result.status !== 'already_prepared')) return reject(current);
      const projected = stateFromProjection(current, evidence.result.attempt, at);
      if (projected === null || projected.phase !== 'ready_for_round') return reject(current);
      return accept(current, { ...projected, controller_generation: current.controller_generation } as MutableAgentRoundState);
    }
    case 'start_round': {
      if (evidence?.kind !== 'begin_round' || state.phase !== 'ready_for_round' || state.round_lineage === null || state.round_lineage.round_id !== evidence.round_id || state.round_index !== evidence.round_index || state.root.root_fingerprint_sha256 !== evidence.root.root_fingerprint_sha256 || state.root.workspace_id !== evidence.root.workspace_id || state.root.workspace_binding_revision !== evidence.root.workspace_binding_revision || state.root.project_id !== evidence.root.project_id || state.toolset_sha256 !== evidence.toolset_sha256 || !sameAgentTranscript(state.transcript, evidence.transcript)) return reject(current);
      state.phase = 'round_in_flight'; state.round_lineage = { ...state.round_lineage, status: 'active', launch_attempt: evidence.launch_attempt, native_row_revision: null }; state.updated_at = at; return accept(current, state);
    }
    case 'retry_round': {
      if (evidence?.kind !== 'recover_agent_attempt' || evidence.result.status !== 'retryable' || state.phase !== 'failed') return reject(current);
      const projected = stateFromProjection(current, evidence.result.attempt, at); return projected === null || projected.phase !== 'round_in_flight' ? reject(current) : accept(current, { ...projected, updated_at: at } as MutableAgentRoundState);
    }
    case 'freeze_batch': {
      if (state.phase !== 'round_in_flight' || evidence === null) return reject(current);
      let calls: Array<PersistedAgentCallJournalV3 | null> = []; let transcript: AgentRuntimeTranscriptHandleV1 | null = null; let revision: number | null = null; let reserved = 0;
      if (evidence.kind === 'prepare_agent_tool_batch' && evidence.result.status !== 'rejected') { calls = evidence.result.receipt.calls.map(callFromProjection); transcript = evidence.result.receipt.transcript; revision = evidence.result.receipt.batch_revision; reserved = evidence.result.receipt.reserved_write_bytes; }
      else if (evidence.kind === 'complete_agent_round_v2' && evidence.result.status === 'completed' && evidence.result.outcome.kind === 'tool_batch') { calls = evidence.result.outcome.calls.map(callFromPresentation); transcript = evidence.result.outcome.transcript; revision = evidence.result.result_round_revision; }
      else return reject(current);
      if (calls.length === 0 || calls.some(call => call === null) || transcript === null) return reject(current);
      const nextCalls = calls as PersistedAgentCallJournalV3[];
      if (nextCalls.some(call => call.access !== 'auto' && call.access !== 'durable_deny' && call.approval_decision === 'pending' && call.approval_token === null)) return reject(current);
      state.batch = nextCalls; state.call_index = nextPendingCall(state); state.phase = hasPendingApproval(state) ? 'approval_pending' : 'batch_frozen'; state.transcript = { ...transcript }; state.reserved_write_bytes = reserved; if (state.round_lineage !== null) state.round_lineage = { ...state.round_lineage, status: 'completed', native_row_revision: revision ?? state.round_lineage.native_row_revision }; if (state.round_index >= MAX_AGENT_ROUNDS - 1) { state.phase = 'failed'; state.batch = []; state.call_index = null; } state.updated_at = at; return accept(current, state);
    }
    case 'decide_approval': {
      if (evidence?.kind !== 'decide_approval' || (state.phase !== 'approval_pending' && state.phase !== 'batch_frozen')) return reject(current);
      const call = state.batch[evidence.call_index]; if (call === undefined || call.call_id !== evidence.call_id || call.name !== evidence.name || call.arguments_sha256 !== evidence.arguments_sha256 || call.approval_token !== evidence.approval_token || call.access !== evidence.access || call.approval_decision !== 'pending') return reject(current);
      const decision = evidence.decision;
      state.batch[evidence.call_index] = { ...call, approval_decision: decision, approval_token: decision === 'denied' || decision === 'cancelled' ? null : call.approval_token, approval_reference: decision === 'denied' || decision === 'cancelled' ? null : evidence.operation_id };
      state.call_index = nextPendingCall(state); state.phase = hasPendingApproval(state) ? 'approval_pending' : 'batch_frozen'; state.updated_at = at; return accept(current, state);
    }
    case 'execution_intent': {
      if (evidence?.kind !== 'begin_execution' || state.phase !== 'batch_frozen') return reject(current);
      const call = state.batch[evidence.call_index];
      if (
        call === undefined ||
        state.call_index !== evidence.call_index ||
        call.call_id !== evidence.call_id ||
        call.name !== evidence.name ||
        call.arguments_sha256 !== evidence.arguments_sha256 ||
        call.access !== evidence.access ||
        evidence.approval_state !== (call.access === 'auto' ? 'not_required' : 'bound') ||
        (call.access !== 'auto' && call.approval_decision !== 'allow_once' && call.approval_decision !== 'allow_conversation') ||
        call.approval_reference !== evidence.approval_reference ||
        call.idempotency_key !== null ||
        call.native_row_revision !== evidence.expected_execution_revision ||
        call.receipt !== null
      ) return reject(current);
      state.batch[evidence.call_index] = {
        ...call,
        idempotency_key: evidence.idempotency_key,
        native_row_revision: evidence.expected_execution_revision,
      };
      state.call_index = evidence.call_index;
      state.phase = 'execution_intent';
      state.updated_at = at;
      return accept(current, state);
    }
    case 'tool_result':
    case 'protected_receipt': {
      if (evidence?.kind !== 'execute_agent_tool' || state.phase !== 'execution_intent') return reject(current);
      const result = evidence.result;
      if (result.status === 'unknown' || result.status === 'ambiguous') {
        const call = state.batch[result.call_index];
        if (call === undefined || call.call_id !== result.call_id || call.name !== result.name || call.idempotency_key !== result.idempotency_key || (result.status === 'unknown' ? result.receipt !== null : result.receipt === null)) return reject(current);
        if (result.status === 'ambiguous' && result.receipt !== null && !sameReceiptForCall(result.receipt as unknown as AgentToolReceiptV1, call)) return reject(current);
        state.batch[result.call_index] = { ...call, receipt: result.receipt === null ? null : cloneReceipt(result.receipt as unknown as AgentToolReceiptV1), native_row_revision: result.result_execution_revision };
        state.transcript = { ...result.transcript };
        state.call_index = result.call_index;
        state.phase = result.status;
        if (state.round_lineage !== null) state.round_lineage = { ...state.round_lineage, status: result.status, native_row_revision: result.result_execution_revision };
        state.updated_at = at;
        return accept(current, state);
      }
      if (result.status !== 'completed' && result.status !== 'failed' && result.status !== 'denied' && result.status !== 'cancelled' || result.receipt === null) return reject(current);
      const call = state.batch[result.call_index]; if (call === undefined || call.call_id !== result.call_id || call.name !== result.name || call.idempotency_key !== result.idempotency_key || !sameReceiptForCall(result.receipt as unknown as AgentToolReceiptV1, call)) return reject(current);
      state.batch[result.call_index] = { ...call, receipt: cloneReceipt(result.receipt as unknown as AgentToolReceiptV1), native_row_revision: result.result_execution_revision }; state.transcript = { ...result.transcript }; state.call_index = result.call_index; state.phase = result.status === 'cancelled' ? 'cancelled' : 'tool_result_pending'; if (state.round_lineage !== null && result.status === 'cancelled') state.round_lineage = { ...state.round_lineage, status: 'cancelled' }; state.updated_at = at; return accept(current, state);
    }
    case 'next_round': {
      if ((state.phase !== 'tool_result_pending' && state.phase !== 'batch_frozen') || !isCanonicalUuid(action.round_id) || action.round_index !== state.round_index + 1 || action.round_index >= MAX_AGENT_ROUNDS || nextPendingCall(state) !== null) return reject(current);
      state.phase = 'ready_for_round'; state.round_index = action.round_index; state.round_lineage = { schema_version: 2, round_id: action.round_id, round_index: action.round_index, launch_attempt: action.launch_attempt ?? 1, status: 'ready', native_row_revision: null }; state.batch = []; state.call_index = null; state.updated_at = at; return accept(current, state);
    }
    case 'next_call': {
      if (state.phase !== 'tool_result_pending') return reject(current); const next = nextPendingCall(state); if (next === null) return reject(current); state.call_index = next; state.phase = hasPendingApproval(state) ? 'approval_pending' : 'batch_frozen'; state.updated_at = at; return accept(current, state);
    }
    case 'final_response': {
      if (evidence?.kind !== 'complete_agent_round_v2' || evidence.result.status !== 'completed' || evidence.result.outcome.kind !== 'final' || state.phase !== 'round_in_flight' || nextPendingCall(state) !== null || state.round_lineage === null) return reject(current);
      state.phase = 'final_response'; state.batch = []; state.call_index = null; state.transcript = { ...evidence.result.outcome.transcript }; state.round_lineage = { ...state.round_lineage, status: 'completed', native_row_revision: evidence.result.result_round_revision }; state.updated_at = at; return accept(current, state);
    }
    case 'blocked': {
      if (evidence?.kind !== 'complete_agent_round_v2' || evidence.result.status !== 'completed' || evidence.result.outcome.kind !== 'blocked' || state.phase !== 'round_in_flight' || state.round_lineage === null) return reject(current);
      state.phase = 'failed'; state.batch = []; state.call_index = null; state.transcript = { ...evidence.result.outcome.transcript }; state.round_lineage = { ...state.round_lineage, status: 'completed', native_row_revision: evidence.result.result_round_revision }; state.updated_at = at; return accept(current, state);
    }
    case 'cancel': {
      if (evidence?.kind === 'request_cancel') {
        if (state.phase === 'final_response' || state.phase === 'cancelled' || state.round_lineage === null) return reject(current);
        const target = evidence.target;
        if (target.kind === 'round' && (state.round_lineage.round_id !== target.round_id || state.round_index !== target.round_index)) return reject(current);
        if (target.kind === 'tool') {
          const call = state.batch[target.call_index];
          if (call === undefined || call.call_id !== target.call_id || call.idempotency_key !== target.idempotency_key) return reject(current);
        }
        if (target.kind === 'round' || target.kind === 'tool') {
          state.round_lineage = { ...state.round_lineage, status: 'cancel_requested' };
        } else {
          state.phase = 'cancelled';
          state.round_lineage = { ...state.round_lineage, status: 'cancelled' };
          state.batch = state.batch.map(call => call.receipt === null && call.approval_decision !== 'denied' && call.approval_decision !== 'cancelled' ? { ...call, approval_decision: 'cancelled', approval_token: null, approval_reference: null } : call);
        }
        state.updated_at = at;
        return accept(current, state);
      }
      if (evidence?.kind !== 'cancel_agent_attempt' || state.phase === 'cancelled' || state.phase === 'final_response' || state.round_lineage === null) return reject(current);
      const result = evidence.result; state.transcript = { ...result.transcript };
      if (result.target.kind === 'tool' && result.receipt !== null) { const call = state.batch[result.target.call_index]; const receipt = result.receipt as unknown as AgentToolReceiptV1; if (call === undefined || call.call_id !== result.target.call_id || !sameReceiptForCall(receipt, call)) return reject(current); state.batch[result.target.call_index] = { ...call, receipt: cloneReceipt(receipt), native_row_revision: result.result_execution_revision }; }
      if (result.status === 'cancel_requested') state.round_lineage = { ...state.round_lineage, status: 'cancel_requested', native_row_revision: result.result_round_revision ?? state.round_lineage.native_row_revision };
      else if (result.status === 'unknown' || result.status === 'ambiguous') { state.phase = result.status; state.round_lineage = { ...state.round_lineage, status: result.status, native_row_revision: result.result_round_revision ?? state.round_lineage.native_row_revision }; }
      else if (result.status === 'settled' && result.receipt !== null) { state.phase = 'tool_result_pending'; state.call_index = result.target.kind === 'tool' ? result.target.call_index : state.call_index; }
      else { state.phase = 'cancelled'; state.round_lineage = { ...state.round_lineage, status: 'cancelled', native_row_revision: result.result_round_revision ?? state.round_lineage.native_row_revision }; state.batch = state.batch.map(call => call.receipt === null && call.approval_decision !== 'denied' && call.approval_decision !== 'cancelled' ? { ...call, approval_decision: 'cancelled', approval_token: null, approval_reference: null } : call); }
      state.updated_at = at; return accept(current, state);
    }
    case 'recover':
    case 'fail':
    case 'failed':
    case 'invalidate_root':
    case 'invalidate_grants':
    case 'root_changed':
    case 'grants_changed':
    case 'policy_changed': {
      if (evidence === null || state.phase === 'final_response' || state.phase === 'cancelled') return reject(current);
      if (evidence.kind === 'recover_agent_attempt') { const projected = stateFromProjection(current, evidence.result.attempt, at); return projected === null ? reject(current) : accept(current, { ...projected, updated_at: at } as MutableAgentRoundState); }
      if (evidence.kind !== 'complete_agent_round_v2' || evidence.result.status === 'completed' || evidence.result.status === 'in_flight') return reject(current);
      state.phase = evidence.result.status === 'unknown' || evidence.result.status === 'ambiguous' ? evidence.result.status : 'failed'; state.call_index = null; state.transcript = { ...evidence.result.transcript }; state.round_lineage = state.round_lineage === null ? null : { ...state.round_lineage, status: evidence.result.status === 'failed_retryable' ? 'failed_retryable' : evidence.result.status }; state.updated_at = at; return accept(current, state);
    }
  }
}

export function normalizeAgentRoundAction(value: unknown): AgentRoundReducerAction | null {
  const raw = ownRecord(value); if (raw === null || typeof raw.type !== 'string') return null;
  const evidenceTypes = new Set(['prepare_attempt', 'start_round', 'retry_round', 'freeze_batch', 'decide_approval', 'execution_intent', 'tool_result', 'protected_receipt', 'final_response', 'blocked', 'cancel', 'recover', 'fail', 'failed', 'invalidate_root', 'invalidate_grants', 'root_changed', 'grants_changed', 'policy_changed']);
  if (evidenceTypes.has(raw.type)) { const projected = exactRecordOptional(raw, ['type', 'evidence'], ['updated_at']); if (projected === null || (projected.updated_at !== undefined && !isCanonicalTimestamp(projected.updated_at))) return null; const evidence = mappedRoundEvidence(projected.evidence); return evidence === null ? null : { type: raw.type, evidence, ...(projected.updated_at === undefined ? {} : { updated_at: projected.updated_at as string }) } as AgentRoundReducerAction; }
  if (raw.type === 'next_round') {
    const projected = exactRecordOptional(raw, ['type', 'round_id', 'round_index'], ['launch_attempt', 'updated_at']);
    const roundIndex = projected?.round_index;
    const launchAttempt = projected?.launch_attempt;
    if (projected === null || !isCanonicalUuid(projected.round_id) || typeof roundIndex !== 'number' || !Number.isSafeInteger(roundIndex) || roundIndex < 0 || (launchAttempt !== undefined && (typeof launchAttempt !== 'number' || !Number.isSafeInteger(launchAttempt) || launchAttempt < 1)) || (projected.updated_at !== undefined && !isCanonicalTimestamp(projected.updated_at))) return null;
    return { type: 'next_round', round_id: projected.round_id, round_index: roundIndex, ...(launchAttempt === undefined ? {} : { launch_attempt: launchAttempt }), ...(projected.updated_at === undefined ? {} : { updated_at: projected.updated_at as string }) };
  }
  if (raw.type === 'next_call') { const projected = exactRecordOptional(raw, ['type'], ['updated_at']); return projected === null || (projected.updated_at !== undefined && !isCanonicalTimestamp(projected.updated_at)) ? null : projected as unknown as AgentRoundReducerAction; }
  return null;
}
export function reduceAgentRoundEvent(current: AgentRoundState, action: unknown, timestamp?: string): AgentRoundReduction { const normalized = normalizeAgentRoundAction(action); return normalized === null ? reject(current) : reduceAgentRound(current, normalized, timestamp); }
function actionForEvidence(evidence: AgentRoundEvidence): AgentRoundReducerAction {
  if (evidence.kind === 'begin_round') return { type: 'start_round', evidence };
  if (evidence.kind === 'decide_approval') return { type: 'decide_approval', evidence };
  if (evidence.kind === 'begin_execution') return { type: 'execution_intent', evidence };
  if (evidence.kind === 'request_cancel') return { type: 'cancel', evidence };
  if (evidence.kind === 'prepare_agent_attempt') return { type: 'prepare_attempt', evidence };
  if (evidence.kind === 'bind_agent_approval') return { type: 'decide_approval', evidence };
  if (evidence.kind === 'cancel_agent_attempt') return { type: 'cancel', evidence };
  if (evidence.kind === 'execute_agent_tool') return { type: evidence.result.status === 'running' || evidence.result.status === 'cancel_requested' ? 'execution_intent' : 'tool_result', evidence };
  if (evidence.kind === 'prepare_agent_tool_batch') return { type: 'freeze_batch', evidence };
  if (evidence.kind === 'recover_agent_attempt') return { type: 'recover', evidence };
  if (evidence.result.status === 'completed') return { type: evidence.result.outcome.kind === 'final' ? 'final_response' : evidence.result.outcome.kind === 'blocked' ? 'blocked' : 'freeze_batch', evidence };
  return { type: 'fail', evidence };
}
export function applyAgentRoundResult(current: AgentRoundState, result: unknown): AgentRoundReduction { const evidence = mappedEvidence(result); return evidence === null ? reject(current) : reduceAgentRound(current, actionForEvidence(evidence)); }
export function agentRoundReducer(current: AgentRoundState, action: unknown, timestamp?: string): AgentRoundState { const normalized = normalizeAgentRoundAction(action); return normalized === null ? current : reduceAgentRound(current, normalized, timestamp).state; }
export const reduceAgentAttempt = agentRoundReducer;
export const reduceAgentAttemptRound = agentRoundReducer;
export default agentRoundReducer;

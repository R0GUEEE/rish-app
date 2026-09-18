import type { ProviderBinding } from '../providers/configuration';
import type {
  PersistedProjectContextStateV1,
  ProjectContextAction,
  ProjectContextConsentV1,
  ProjectContextManifestV1,
  ProjectContextState,
} from '../project-context/types';
import type { HarnessId, ProviderId } from '../harness/types';
import type { PersistedAppPreferencesV1 } from '../preferences/types';

/** Closed high-level native evidence; the mapper owns its runtime validation. */
export type AgentStoreTransitionEvidence = import(
  '../agent/AgentStoreTransitions'
).AgentStoreTransitionEvidence;
/** Closed controller intent seed used before the native post-result evidence. */
export type AgentControllerPreflightV1 = import(
  '../agent/AgentControllerPreflight'
).AgentControllerPreflightV1;
export type AgentCheckpointEvidence =
  | AgentStoreTransitionEvidence
  | AgentControllerPreflightV1;

/** Native tool registry generations accepted by the session boundary. */
export type AgentRegistryVersion = 1 | 2 | 3;

/**
 * Schema 8 is kept as a first-class migration input.  Schema 9 is the first
 * session root that owns the Agent journal and event projection.
 */
export const CHAT_STATE_SCHEMA_VERSION = 9 as const;
export const AGENT_CHAT_STATE_SCHEMA_VERSION = CHAT_STATE_SCHEMA_VERSION;
export const CHAT_STATE_SCHEMA_VERSION_V8 = 8 as const;
export const PREVIOUS_CHAT_STATE_SCHEMA_VERSION = 7 as const;
export const WORKSPACE_CHAT_STATE_SCHEMA_VERSION = 5 as const;
export const PROJECT_CONTEXT_CHAT_STATE_SCHEMA_VERSION = 6 as const;
export const ATTACHMENT_CHAT_STATE_SCHEMA_VERSION = 4 as const;
export const LEGACY_CHAT_STATE_SCHEMA_VERSION = 2 as const;
export const OLDER_CHAT_STATE_SCHEMA_VERSION = 3 as const;
export const ATTACHMENT_DESCRIPTOR_SCHEMA_VERSION = 1 as const;
export const CONVERSATION_TURN_SCHEMA_VERSION = 1 as const;
export const TURN_ATTEMPT_SCHEMA_VERSION = 1 as const;
export const ATTEMPT_PROJECT_CONTEXT_SCHEMA_VERSION = 1 as const;
export const COMPLETION_ROUND_RECEIPT_SCHEMA_VERSION = 1 as const;
export const PROJECT_CONTEXT_DESTRUCTIVE_TRANSITION_SCHEMA_VERSION = 1 as const;
export const CONVERSATION_WORKSPACE_BINDING_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_AUTHORITY_OUTBOX_SCHEMA_VERSION = 1 as const;
export const AGENT_TRANSCRIPT_REFERENCE_SCHEMA_VERSION = 1 as const;
export const AGENT_ROOT_SCHEMA_VERSION = 1 as const;
export const AGENT_WRITE_POLICY_SCHEMA_VERSION = 1 as const;
export const AGENT_GRANT_SCHEMA_VERSION = 2 as const;
export const AGENT_ATTEMPT_JOURNAL_SCHEMA_VERSION = 2 as const;
export const AGENT_ROUND_LINEAGE_SCHEMA_VERSION = 2 as const;
export const AGENT_CALL_JOURNAL_SCHEMA_VERSION = 2 as const;
/** Final schema-9 nested Agent journal versions.  V2 remains a migration/runtime input. */
export const AGENT_ATTEMPT_JOURNAL_SCHEMA_VERSION_V3 = 3 as const;
export const AGENT_CALL_JOURNAL_SCHEMA_VERSION_V3 = 3 as const;
export const AGENT_CLEANUP_SCHEMA_VERSION = 1 as const;
export const SESSION_EVENT_V2_SCHEMA_VERSION = 2 as const;
export const PERSISTED_TURN_ATTEMPT_SCHEMA_VERSION = 2 as const;
export const PERSISTED_TURN_ATTEMPT_SCHEMA_VERSION_V3 = 3 as const;

export const MAX_AGENT_ROUNDS = 8 as const;
export const MAX_AGENT_CALLS_PER_BATCH = 16 as const;
export const MAX_AGENT_GRANTS_PER_CONVERSATION = 2 as const;
export const MAX_AGENT_CLEANUP_OUTBOX_ENTRIES = 64 as const;
// App-wide retained audit rows, not the per-attempt execution budget.
export const MAX_SESSION_EVENT_ROWS = 8192 as const;
// 8 rounds x 16 calls plus approval/execution/result/recovery bookkeeping.
export const AGENT_EVENT_START_RESERVE = 1024 as const;
export const MAX_AGENT_SINGLE_WRITE_BYTES = 32768 as const;
export const MAX_AGENT_BATCH_WRITE_BYTES = 512 * 1024;
export const MAX_AGENT_ATTEMPT_WRITE_BYTES = 4 * 1024 * 1024;
export const MAX_AGENT_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
export const MAX_AGENT_RESULT_BYTES = 32 * 1024 * 1024;
export const MAX_AGENT_SUMMARY_KEY_LENGTH = 128;
export const AGENT_SAFE_SUMMARY_KEYS = [
  'agent.list_dir',
  'agent.read_file',
  'agent.write_file',
  'agent.git_status',
  'agent.git_commit',
  'agent.git_push',
  'agent.start_guest_cgi',
  'agent.stop_guest_cgi',
  'agent.list_runtime_environments',
  'agent.install_runtime_environment',
  'agent.run_program',
  'agent.start_runtime_service',
  'agent.stop_runtime_service',
  'agent.unknown',
] as const;
export const MAX_AGENT_TRANSCRIPT_COUNT = 128;
export const MAX_AGENT_LEDGER_ROWS_PER_ATTEMPT = 128;
export const MAX_AGENT_STORE_BYTES = 64 * 1024 * 1024;
export const MAX_AGENT_DURATION_MS = 24 * 60 * 60 * 1000;

export const ATTACHMENT_KINDS = ['image', 'text', 'pdf'] as const;

export const SUPPORTED_MODEL_IDS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash-vision-exp',
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-haiku-4-5-20251001',
  'claude-fable-5-1',
  'gpt-5.6',
  'gpt-5.6-mini',
  'gpt-5.6-nano',
  'GLM-5.3',
  'GLM-5.3-Flash',
] as const;

export const CONVERSATION_THINKING_MODES = ['off', 'high', 'max'] as const;
export const TURN_ATTEMPT_STATUSES = [
  'prepared',
  'sending',
  'completed',
  'failed',
  'cancelled',
] as const;
export const COMPLETION_FINISH_REASONS = [
  'stop',
  'tool_calls',
  'length',
  'content_filter',
] as const;
export const ATTEMPT_CONTEXT_DISPOSITIONS = [
  'unbound',
  'verified',
  'explicit_without_context',
] as const;
export const PROJECT_CONTEXT_DESTRUCTIVE_ACTIONS = [
  'unbind',
  'delete',
  'rebind',
] as const;
export const PROJECT_CONTEXT_DESTRUCTIVE_PHASES = [
  'intent',
  'cleanup_pending',
  'ready_to_finalize',
] as const;
export const CONVERSATION_WORKSPACE_BOOTSTRAP_STATES = [
  'none',
  'pending_legacy_project',
  'pending_registry_resolution',
  'blocked_invalid_legacy_id',
  'blocked_missing_legacy_workspace',
] as const;
export const ATTEMPT_FAILURE_CODES = [
  'E_ATTEMPT_INTERRUPTED',
  'E_ATTEMPT_PERSISTENCE',
  'E_ATTEMPT_CONTEXT_REQUIRED',
  'E_COMPLETION_RESULT_KEYS',
  'E_COMPLETION_RESULT_TYPE',
  'E_COMPLETION_RESULT_IDENTIFIER',
  'E_COMPLETION_RESULT_BOUNDS',
  'E_COMPLETION_RESULT_ENUM',
  'E_COMPLETION_RESULT_DIGEST',
  'E_COMPLETION_RESULT_RELATION',
  'E_COMPLETION_RESULT_CORRELATION',
  'E_COMPLETION_NATIVE',
  'E_COMPLETION_SCHEMA',
  'E_COMPLETION_IDENTIFIER',
  'E_COMPLETION_ROUND',
  'E_COMPLETION_MODEL',
  'E_COMPLETION_THINKING',
  'E_COMPLETION_HISTORY',
  'E_COMPLETION_TRANSCRIPT',
  'E_COMPLETION_TOOLS',
  'E_COMPLETION_CONTEXT_INVALID',
  'E_COMPLETION_CONTEXT_UNSUPPORTED',
  'E_COMPLETION_CREDENTIAL_UNAVAILABLE',
  'E_COMPLETION_CREDENTIAL_CHANGED',
  'E_COMPLETION_BODY_INVALID',
  'E_COMPLETION_BODY_TOO_LARGE',
  'E_COMPLETION_BUSY',
  'E_COMPLETION_CANCELLED',
  'E_COMPLETION_REDIRECT',
  'E_COMPLETION_TIMEOUT',
  'E_COMPLETION_TRANSPORT',
  'E_COMPLETION_HTTP_STATUS',
  'E_COMPLETION_HTTP_429',
  'E_COMPLETION_RESPONSE_SIZE',
  'E_COMPLETION_RESPONSE_JSON',
  'E_COMPLETION_PROVIDER_REQUEST_ID',
  'E_COMPLETION_PROVIDER_RESPONSE_ID',
  'E_COMPLETION_RESPONSE_MODEL',
  'E_COMPLETION_MODEL_MISMATCH',
  'E_COMPLETION_FINISH_RELATION',
  'E_COMPLETION_TOOL_CALL_INVALID',
  'E_COMPLETION_EMPTY_RESPONSE',
  'E_PROJECT_ID_INVALID',
  'E_PROJECT_NOT_FOUND',
  'E_PROJECT_STORAGE_UNSAFE',
  'E_REPOSITORY_UNSUPPORTED',
  'E_CONTEXT_CHANGED',
  'E_CONTEXT_BUDGET',
  'E_CONTEXT_SECRET',
  'E_CONTEXT_ENCODING',
  'E_CONTEXT_TIMEOUT',
  'E_CONTEXT_CANCELLED',
  'E_CONTEXT_CONSENT_INVALID',
  'E_CONTEXT_SNAPSHOT_MISSING',
  'E_CONTEXT_REQUEST_INVALID',
  'E_CONTEXT_RESULT_INVALID',
  'E_CONTEXT_STORAGE',
  'E_CONTEXT_INTEGRITY',
  'E_CONTEXT_BUSY',
  'E_CONTEXT_NATIVE',
  'E_WORKSPACE_REVOKED',
  'E_AGENT_UNKNOWN_TOOL',
  'E_AGENT_BAD_ARGUMENTS',
  'E_AGENT_BAD_PATH',
  'E_AGENT_NO_ROOT',
  'E_AGENT_ROOT_STALE',
  'E_AGENT_CAPABILITY',
  'E_AGENT_APPROVAL',
  'E_AGENT_TRANSCRIPT',
  'E_AGENT_LEDGER',
  'E_AGENT_ROUND_AMBIGUOUS',
  'E_AGENT_EXECUTION_AMBIGUOUS',
  'E_AGENT_RETRY_LINEAGE',
  'E_AGENT_PERSISTENCE',
  'E_AGENT_EVENT_CAPACITY',
  'E_AGENT_CONFLICT',
  'E_AGENT_ROUND_LIMIT',
  'E_AGENT_CANCELLED',
  'E_AGENT_TOOL_FAILED',
  'E_COMPLETION_LENGTH',
  'E_COMPLETION_CONTENT_FILTER',
] as const;

export type ModelId = import("../harness/types").HarnessModelId;
export type ConversationThinkingMode =
  (typeof CONVERSATION_THINKING_MODES)[number];
export type ChatRole = 'user' | 'assistant';
export type ConversationTitleSource = 'auto' | 'manual';
export type ChatAttachmentKind = (typeof ATTACHMENT_KINDS)[number];
export type TurnAttemptStatus = (typeof TURN_ATTEMPT_STATUSES)[number];
export type CompletionFinishReason = (typeof COMPLETION_FINISH_REASONS)[number];
export type AttemptContextDisposition =
  (typeof ATTEMPT_CONTEXT_DISPOSITIONS)[number];
/**
 * An Agent round settles its attempt with the Agent's own failure code, so an
 * attempt may carry either family. Both are stable and value-free.
 */
export type AttemptFailureCode =
  | (typeof ATTEMPT_FAILURE_CODES)[number]
  | AgentFailureCode;
export type ProjectContextDestructiveAction =
  (typeof PROJECT_CONTEXT_DESTRUCTIVE_ACTIONS)[number];
export type ProjectContextDestructivePhase =
  (typeof PROJECT_CONTEXT_DESTRUCTIVE_PHASES)[number];
export type ConversationWorkspaceBootstrapState =
  (typeof CONVERSATION_WORKSPACE_BOOTSTRAP_STATES)[number];

/** Stable, value-free failures shared by the JS Agent journal and native WAL. */
export type AgentFailureCode =
  | 'E_AGENT_UNKNOWN_TOOL'
  | 'E_AGENT_BAD_ARGUMENTS'
  | 'E_AGENT_BAD_PATH'
  | 'E_AGENT_NO_ROOT'
  | 'E_AGENT_ROOT_STALE'
  | 'E_AGENT_CAPABILITY'
  | 'E_AGENT_APPROVAL'
  | 'E_AGENT_TRANSCRIPT'
  | 'E_AGENT_LEDGER'
  | 'E_AGENT_ROUND_AMBIGUOUS'
  | 'E_AGENT_EXECUTION_AMBIGUOUS'
  | 'E_AGENT_RETRY_LINEAGE'
  | 'E_AGENT_PERSISTENCE'
  | 'E_AGENT_CONFLICT'
  | 'E_AGENT_ROUND_LIMIT'
  | 'E_AGENT_CANCELLED'
  | 'E_AGENT_TOOL_FAILED'
  | 'E_AGENT_DENIED_BY_USER'
  | 'E_COMPLETION_LENGTH'
  | 'E_COMPLETION_CONTENT_FILTER';

export const AGENT_FAILURE_CODES = [
  'E_AGENT_UNKNOWN_TOOL',
  'E_AGENT_BAD_ARGUMENTS',
  'E_AGENT_BAD_PATH',
  'E_AGENT_NO_ROOT',
  'E_AGENT_ROOT_STALE',
  'E_AGENT_CAPABILITY',
  'E_AGENT_APPROVAL',
  'E_AGENT_TRANSCRIPT',
  'E_AGENT_LEDGER',
  'E_AGENT_ROUND_AMBIGUOUS',
  'E_AGENT_EXECUTION_AMBIGUOUS',
  'E_AGENT_RETRY_LINEAGE',
  'E_AGENT_PERSISTENCE',
  'E_AGENT_CONFLICT',
  'E_AGENT_ROUND_LIMIT',
  'E_AGENT_CANCELLED',
  'E_AGENT_TOOL_FAILED',
  'E_AGENT_DENIED_BY_USER',
  'E_COMPLETION_LENGTH',
  'E_COMPLETION_CONTENT_FILTER',
] as const satisfies readonly AgentFailureCode[];

export type AgentCapability =
  | 'file_read'
  | 'file_write'
  | 'git_status'
  | 'git_commit'
  | 'git_push'
  | 'guest_service';

export type AgentAccess =
  | 'auto'
  | 'conversation_confirm'
  | 'confirm_once'
  | 'durable_deny';

export type AgentApprovalDecision =
  | 'pending'
  | 'denied'
  | 'allow_once'
  | 'allow_conversation'
  | 'cancelled';

/**
 * Exact approval capability. The token is intentionally structured rather
 * than an opaque provider string: every field that can change the decision is
 * bound to the controller CAS and frozen Agent authority.
 */
export type AgentApprovalTokenV1 = {
  readonly schema_version: 1;
  readonly controller_cas: AgentControllerCASV1;
  readonly round_id: string;
  readonly round_index: number;
  readonly batch_call_ids: readonly string[];
  readonly batch_arguments_sha256: readonly string[];
  readonly call_index: number;
  readonly call_id: string;
  readonly name: string;
  readonly access: AgentAccess;
  readonly arguments_sha256: string;
  readonly root_fingerprint_sha256: string;
  readonly binding_revision: number;
  readonly policy_version: string;
  readonly registry_version: AgentRegistryVersion;
  readonly allowed_decisions: readonly Exclude<
    AgentApprovalDecision,
    'pending'
  >[];
};

/**
 * The object accepted from the pre-V3 schema-9 Store.  It is intentionally
 * retained as a legacy source type; it is never emitted by the final
 * persisted serializer.
 */
export type AgentApprovalTokenV1Legacy = AgentApprovalTokenV1;

/** Native-only structured binding.  The Store persists only `token`. */
export type AgentApprovalBindingTokenV2 = {
  readonly schema_version: 2;
  readonly token: string;
  readonly controller_cas: AgentControllerCASV1;
  readonly task_id: string;
  readonly attempt_id: string;
  readonly round_id: string;
  readonly round_index: number;
  readonly batch_call_ids: readonly string[];
  readonly batch_arguments_sha256: readonly string[];
  readonly batch_revision: number;
  readonly manifest_sha256: string;
  readonly call_index: number;
  readonly call_id: string;
  readonly name: string;
  readonly arguments_sha256: string;
  readonly idempotency_key: string;
  readonly root_fingerprint_sha256: string;
  readonly binding_revision: number;
  readonly policy_version: 'agent-v1';
  readonly registry_version: AgentRegistryVersion;
  readonly access: 'conversation_confirm' | 'confirm_once';
  readonly allowed_decisions: readonly (
    | 'denied'
    | 'allow_once'
    | 'allow_conversation'
    | 'cancelled'
  )[];
};

export type AgentApprovalTokenSourceV2 =
  | {
      readonly schema_version: 2;
      readonly source_kind: 'approved_opaque_string';
      readonly approval_token: string | null;
    }
  | {
      readonly schema_version: 2;
      readonly source_kind: 'current_object_legacy';
      readonly approval_token: AgentApprovalTokenV1Legacy;
    }
  | {
      readonly schema_version: 2;
      readonly source_kind: 'runtime_object_v2';
      readonly approval_token: AgentApprovalBindingTokenV2;
    };

/** Pure migration classification; this is never authority or an execution token. */
export type AgentApprovalTokenMigrationV3 =
  | {
      readonly schema_version: 3;
      readonly source_schema_version: 2;
      readonly source: Extract<
        AgentApprovalTokenSourceV2,
        { readonly source_kind: 'approved_opaque_string' }
      >;
      readonly status: 'preserved';
      readonly approval_token: string | null;
      readonly decision: AgentApprovalDecision;
      readonly historical_decision: null;
      readonly failure_code: null;
    }
  | {
      readonly schema_version: 3;
      readonly source_schema_version: 2;
      readonly source: Extract<
        AgentApprovalTokenSourceV2,
        {
          readonly source_kind:
            | 'approved_opaque_string'
            | 'current_object_legacy';
        }
      >;
      readonly status: 'needs_reprepare' | 'cancelled';
      readonly approval_token: null;
      readonly decision: 'denied' | 'cancelled';
      readonly historical_decision: AgentApprovalDecision;
      readonly failure_code:
        | 'E_AGENT_APPROVAL'
        | 'E_AGENT_TRANSCRIPT'
        | 'E_AGENT_CONFLICT';
    }
  | {
      readonly schema_version: 3;
      readonly source_schema_version: 2;
      readonly source: Extract<
        AgentApprovalTokenSourceV2,
        { readonly source_kind: 'runtime_object_v2' }
      >;
      readonly status: 'needs_reprepare';
      readonly approval_token: null;
      readonly decision: 'denied' | 'cancelled';
      readonly historical_decision: AgentApprovalDecision;
      readonly failure_code: 'E_AGENT_APPROVAL' | 'E_AGENT_TRANSCRIPT' | 'E_AGENT_CONFLICT';
    };

export type AgentAttemptPhase =
  | 'ready_for_round'
  | 'round_in_flight'
  | 'batch_frozen'
  | 'approval_pending'
  | 'execution_intent'
  | 'tool_result_pending'
  | 'final_response'
  | 'cancelled'
  | 'failed'
  | 'unknown'
  | 'ambiguous';

export const AGENT_ATTEMPT_PHASES = [
  'ready_for_round',
  'round_in_flight',
  'batch_frozen',
  'approval_pending',
  'execution_intent',
  'tool_result_pending',
  'final_response',
  'cancelled',
  'failed',
  'unknown',
  'ambiguous',
] as const satisfies readonly AgentAttemptPhase[];

/**
 * Closed phase/lineage relation shared by the persistence parser and the
 * reducer.  A ready Agent attempt may not have allocated a native round yet;
 * cancellation before launch also has no round. Other phases carry the lineage that explains
 * it.  Keeping this table in the state contract prevents the two validators
 * from drifting and admitting an authority transition at only one boundary.
 */
export const AGENT_PHASE_LINEAGE_MATRIX: Readonly<
  Record<
    AgentAttemptPhase,
    readonly PersistedAgentRoundLineageV2['status'][] | null
  >
> = {
  ready_for_round: ['ready'],
  round_in_flight: ['active', 'cancel_requested'],
  batch_frozen: ['completed'],
  approval_pending: ['completed'],
  execution_intent: ['completed', 'cancel_requested'],
  tool_result_pending: ['completed'],
  final_response: ['completed'],
  cancelled: ['completed', 'cancelled'],
  failed: ['completed', 'failed_retryable'],
  unknown: ['unknown'],
  ambiguous: ['ambiguous'],
};

/** Returns whether a final Agent phase has a permitted native lineage state. */
export function isAgentPhaseLineageValid(
  phase: AgentAttemptPhase,
  lineageStatus: PersistedAgentRoundLineageV2['status'] | null,
): boolean {
  const allowed = AGENT_PHASE_LINEAGE_MATRIX[phase];
  if ((phase === 'ready_for_round' || phase === 'cancelled') && lineageStatus === null) return true;
  return (
    lineageStatus !== null &&
    allowed !== null &&
    allowed.includes(lineageStatus)
  );
}

/** Root authority frozen before a provider round.  It never contains a path. */
export type FrozenAgentRootV1 = {
  readonly schema_version: typeof AGENT_ROOT_SCHEMA_VERSION;
  readonly kind: 'project' | 'workspace';
  readonly workspace_id: string;
  readonly workspace_binding_revision: number;
  readonly project_id: string | null;
  readonly root_fingerprint_sha256: string;
  readonly capabilities: readonly AgentCapability[];
};
export type AgentRootV1 = FrozenAgentRootV1;

export type AgentWritePolicyV1 = {
  readonly schema_version: typeof AGENT_WRITE_POLICY_SCHEMA_VERSION;
  readonly policy_version: string;
  readonly max_single_write_bytes: 32768;
  readonly max_batch_write_bytes: number;
  readonly max_attempt_write_bytes: number;
};

/** Names used by the high-level Agent Runtime addendum. */
export type AgentRuntimePolicyV1 = AgentWritePolicyV1;

export type AgentTranscriptReferenceV1 = {
  readonly schema_version: typeof AGENT_TRANSCRIPT_REFERENCE_SCHEMA_VERSION;
  readonly transcript_ref: string;
  readonly generation: number;
  readonly transcript_sha256: string;
  readonly transcript_bytes: number;
};

export type AgentRuntimeTranscriptHandleV1 = AgentTranscriptReferenceV1;
export type AgentRuntimeRootV1 = FrozenAgentRootV1;

export type AgentConversationGrantV2 = {
  readonly schema_version: typeof AGENT_GRANT_SCHEMA_VERSION;
  readonly grant_id: string;
  readonly conversation_id: string;
  readonly workspace_id: string;
  readonly project_id: string | null;
  readonly binding_revision: number;
  readonly root_fingerprint_sha256: string;
  readonly tool_family: 'file_write' | 'git_commit' | 'git_push' | 'guest_service';
  readonly registry_version: AgentRegistryVersion;
  readonly policy_version: string;
  readonly issued_for: {
    readonly schema_version: 1;
    readonly task_id: string;
    readonly attempt_id: string;
  };
  readonly created_at: string;
};


export type AgentControllerCASV1 = {
  readonly schema_version: 1;
  readonly conversation_id: string;
  readonly task_id: string;
  readonly attempt_id: string;
  readonly expected_controller_generation: number;
  readonly expected_journal_revision: number;
  readonly expected_session_generation: number;
  readonly expected_session_sha256: string;
};


export type AgentToolCallPresentationV1 = {
  readonly schema_version: 1;
  readonly call_id: string;
  readonly name: string;
  readonly arguments_sha256: string;
  readonly safe_summary_key: string;
  readonly access: AgentAccess;
};

export type AgentWritePriorV1 =
  | { readonly schema_version: 1; readonly kind: 'absent' }
  | {
      readonly schema_version: 1;
      readonly kind: 'known';
      readonly revision: string;
    }
  | {
      readonly schema_version: 1;
      readonly kind: 'unknown';
      readonly failure_code: AgentFailureCode;
    };

export type AgentRuntimeOperationKind =
  | 'list_runtime_environments'
  | 'install_runtime_environment'
  | 'run_program'
  | 'start_runtime_service'
  | 'stop_runtime_service';

export type AgentOperationPreconditionV2 =
  | {
      readonly schema_version: 1;
      readonly kind: AgentRuntimeOperationKind;
      readonly arguments_sha256: string;
      readonly snapshot_sha256: string | null;
      readonly environment_sha256: string | null;
    }
  | {
      readonly schema_version: 1;
      readonly kind: 'read_file';
      readonly source_revision: string;
    }
  | {
      readonly schema_version: 1;
      readonly kind: 'list_dir';
      readonly directory_fingerprint_sha256: string;
    }
  | {
      readonly schema_version: 2;
      readonly kind: 'write_file';
      readonly relative_path_sha256: string;
      readonly prior: AgentWritePriorV1;
      readonly content_sha256: string;
      readonly content_bytes: number;
    }
  | {
      readonly schema_version: 2;
      readonly kind: 'git_commit';
      readonly object_format: 'sha1' | 'sha256';
      readonly pre_head_oid: string | null;
      readonly ordered_parent_oids: readonly string[];
      readonly staged_index_sha256: string;
      readonly tree_oid: string;
      readonly author: AgentGitIdentityV1;
      readonly committer: AgentGitIdentityV1;
      readonly message_blob_ref: string;
      readonly message_sha256: string;
      readonly message_bytes: number;
      readonly encoding_header: null | 'UTF-8';
      readonly signature_policy: 'unsigned';
      readonly extra_headers: readonly [];
      readonly stage_all: true;
      readonly commit_payload_sha256: string;
      readonly expected_commit_oid: string;
    }
  | {
      readonly schema_version: 1;
      readonly kind: 'git_push';
      readonly remote: 'origin';
      readonly remote_ref: string;
      readonly pre_remote_oid: string | null;
      readonly target_oid: string;
    };

export type AgentGitIdentityV1 = {
  readonly schema_version: 1;
  readonly name: 'Rish Agent';
  readonly email: 'agent@rish.local';
  readonly timestamp_seconds: number;
  readonly timezone_offset: string;
};

export type AgentOperationSettledFactsV1 =
  | {
      readonly schema_version: 1;
      readonly kind: AgentRuntimeOperationKind;
      readonly arguments_sha256: string;
      readonly payload_sha256: string;
    }
  | {
      readonly schema_version: 1;
      readonly kind: 'read_file';
      readonly source_revision: string;
    }
  | {
      readonly schema_version: 1;
      readonly kind: 'list_dir';
      readonly directory_fingerprint_sha256: string;
    }
  | {
      readonly schema_version: 1;
      readonly kind: 'write_file';
      readonly actual_revision: string;
      readonly content_sha256: string;
    }
  | {
      readonly schema_version: 1;
      readonly kind: 'git_commit';
      readonly actual_commit_oid: string;
    }
  | {
      readonly schema_version: 1;
      readonly kind: 'git_push';
      readonly actual_remote_oid: string;
    };

export type AgentToolReceiptV1 = {
  readonly schema_version: 1;
  readonly call_id: string;
  readonly name: string;
  readonly arguments_sha256: string;
  readonly result_sha256: string;
  readonly result_bytes: number;
  readonly truncated: boolean;
  readonly duration_ms: number;
  readonly outcome: 'ok' | 'failed' | 'denied' | 'cancelled' | 'ambiguous';
  readonly failure_code: AgentFailureCode | null;
  readonly approval_reference: string | null;
};

export type PersistedAgentRoundLineageV2 = {
  readonly schema_version: typeof AGENT_ROUND_LINEAGE_SCHEMA_VERSION;
  readonly round_id: string;
  readonly round_index: number;
  readonly launch_attempt: number;
  readonly status:
    | 'ready'
    | 'active'
    | 'failed_retryable'
    | 'completed'
    | 'cancel_requested'
    | 'cancelled'
    | 'unknown'
    | 'ambiguous';
  readonly native_row_revision: number | null;
};

export type PersistedAgentCallJournalV2 = {
  readonly schema_version: typeof AGENT_CALL_JOURNAL_SCHEMA_VERSION;
  readonly call_id: string;
  readonly call_index: number;
  readonly name: string;
  readonly arguments_sha256: string;
  readonly safe_summary_key: string;
  readonly access: AgentAccess;
  readonly approval_token: AgentApprovalTokenV1 | null;
  readonly approval_decision: AgentApprovalDecision;
  readonly approval_reference: string | null;
  readonly idempotency_key: string | null;
  readonly native_row_revision: number | null;
  readonly receipt: AgentToolReceiptV1 | null;
};

/** Final schema-9 call projection.  `approval_token` is deliberately opaque. */
export type PersistedAgentCallJournalV3 = {
  readonly schema_version: typeof AGENT_CALL_JOURNAL_SCHEMA_VERSION_V3;
  readonly call_id: string;
  readonly call_index: number;
  readonly name: string;
  readonly arguments_sha256: string;
  readonly safe_summary_key: string;
  readonly access: AgentAccess;
  readonly approval_token: string | null;
  readonly approval_decision: AgentApprovalDecision;
  readonly approval_reference: string | null;
  readonly idempotency_key: string | null;
  readonly native_row_revision: number | null;
  readonly receipt: AgentToolReceiptV1 | null;
};

export type PersistedAgentAttemptJournalV2 = {
  readonly schema_version: typeof AGENT_ATTEMPT_JOURNAL_SCHEMA_VERSION;
  readonly phase:
    | 'ready_for_round'
    | 'round_in_flight'
    | 'batch_frozen'
    | 'approval_pending'
    | 'execution_intent'
    | 'tool_result_pending'
    | 'final_response'
    | 'cancelled'
    | 'failed'
    | 'unknown'
    | 'ambiguous';
  readonly controller_generation: number;
  readonly policy: AgentWritePolicyV1;
  readonly root: FrozenAgentRootV1;
  readonly tool_registry_version: AgentRegistryVersion;
  readonly toolset_sha256: string;
  readonly transcript: AgentTranscriptReferenceV1;
  readonly round_index: number;
  readonly round_lineage: PersistedAgentRoundLineageV2 | null;
  readonly call_index: number | null;
  readonly batch: readonly PersistedAgentCallJournalV2[];
  readonly frozen_grant_ids: readonly string[];
  readonly reserved_write_bytes: number;
  readonly updated_at: string;
};

/** Final schema-9 Agent journal projection. */
export type PersistedAgentAttemptJournalV3 = {
  readonly schema_version: typeof AGENT_ATTEMPT_JOURNAL_SCHEMA_VERSION_V3;
  readonly phase: AgentAttemptPhase;
  readonly controller_generation: number;
  readonly policy: AgentRuntimePolicyV1;
  readonly root: AgentRuntimeRootV1;
  readonly tool_registry_version: AgentRegistryVersion;
  readonly toolset_sha256: string;
  readonly transcript: AgentRuntimeTranscriptHandleV1;
  readonly round_index: number;
  readonly round_lineage: PersistedAgentRoundLineageV2 | null;
  readonly call_index: number | null;
  readonly batch: readonly PersistedAgentCallJournalV3[];
  readonly frozen_grant_ids: readonly string[];
  readonly reserved_write_bytes: number;
  readonly updated_at: string;
};

export type AgentTranscriptCleanupV1 = {
  readonly schema_version: typeof AGENT_CLEANUP_SCHEMA_VERSION;
  readonly cleanup_id: string;
  readonly conversation_id: string;
  readonly task_id: string;
  readonly attempt_id: string;
  readonly transcript_ref: string;
  readonly transcript_sha256: string;
  readonly reason:
    | 'completed'
    | 'cancelled'
    | 'failed'
    | 'conversation_deleted';
  readonly created_at: string;
};

/** Exact schema-9 event projection; no raw provider/tool payload is allowed. */
export type SessionEventV2 = {
  readonly schema_version: typeof SESSION_EVENT_V2_SCHEMA_VERSION;
  readonly event_id: string;
  readonly attempt_id: string;
  readonly seq: number;
  readonly kind:
    | 'round'
    | 'tool_call'
    | 'tool_result'
    | 'approval'
    | 'terminal';
  readonly round_index: number | null;
  readonly call_id: string | null;
  readonly status:
    | 'waiting'
    | 'approval'
    | 'running'
    | 'ok'
    | 'failed'
    | 'denied'
    | 'cancelled'
    | 'unknown'
    | 'ambiguous';
  readonly safe_summary_key: string | null;
  readonly arguments_sha256: string | null;
  readonly result_sha256: string | null;
  readonly approval_reference: string | null;
  readonly failure_code: AgentFailureCode | null;
  readonly created_at: string;
};

/**
 * The cancellation source event is a closed schema-9 union branch.  It uses
 * the existing event envelope and deliberately carries no result/receipt;
 * `approval_reference` is the source event identity itself.
 */
export type AgentCancelEventV2 =
  | {
      readonly schema_version: typeof SESSION_EVENT_V2_SCHEMA_VERSION;
      readonly event_id: string;
      readonly attempt_id: string;
      readonly seq: number;
      readonly kind: 'cancel';
      readonly round_index: null;
      readonly call_id: null;
      readonly status: 'cancelled';
      readonly safe_summary_key: null;
      readonly arguments_sha256: null;
      readonly result_sha256: null;
      readonly approval_reference: string;
      readonly failure_code:
        | 'E_AGENT_CANCELLED'
        | 'E_AGENT_ROOT_STALE'
        | 'E_AGENT_PERSISTENCE';
      readonly created_at: string;
    }
  | {
      readonly schema_version: typeof SESSION_EVENT_V2_SCHEMA_VERSION;
      readonly event_id: string;
      readonly attempt_id: string;
      readonly seq: number;
      readonly kind: 'cancel';
      readonly round_index: number;
      readonly call_id: null;
      readonly status: 'cancelled';
      readonly safe_summary_key: null;
      readonly arguments_sha256: null;
      readonly result_sha256: null;
      readonly approval_reference: string;
      readonly failure_code:
        | 'E_AGENT_CANCELLED'
        | 'E_AGENT_ROOT_STALE'
        | 'E_AGENT_PERSISTENCE';
      readonly created_at: string;
    }
  | {
      readonly schema_version: typeof SESSION_EVENT_V2_SCHEMA_VERSION;
      readonly event_id: string;
      readonly attempt_id: string;
      readonly seq: number;
      readonly kind: 'cancel';
      readonly round_index: number;
      readonly call_id: string;
      readonly status: 'cancelled';
      readonly safe_summary_key: null;
      readonly arguments_sha256: string;
      readonly result_sha256: null;
      readonly approval_reference: string;
      readonly failure_code:
        | 'E_AGENT_CANCELLED'
        | 'E_AGENT_ROOT_STALE'
        | 'E_AGENT_PERSISTENCE';
      readonly created_at: string;
    };

export type PersistedSessionEventV3 = SessionEventV2 | AgentCancelEventV2;

export type ChatAttachment = {
  readonly schema_version: typeof ATTACHMENT_DESCRIPTOR_SCHEMA_VERSION;
  readonly id: string;
  readonly kind: ChatAttachmentKind;
  readonly name: string;
  readonly mime_type: string;
  readonly size: number;
  readonly thumbnail_data_url?: string;
};

export type AttachmentDescriptor = ChatAttachment;

export type ChatMessageMetadata = {
  readonly modelId?: ModelId;
  readonly latencyMs?: number;
  readonly finishReason?: string;
  readonly reasoning?: string;
};

export type ChatMessage = {
  readonly id: string;
  readonly role: ChatRole;
  readonly text: string;
  readonly createdAt: string;
  readonly attachments: readonly ChatAttachment[];
  readonly metadata?: ChatMessageMetadata;
};

/** Immutable schema-3 binding frozen into an attempt before networking. */
export type AttemptProjectContextBindingV1 = {
  readonly schemaVersion: typeof ATTEMPT_PROJECT_CONTEXT_SCHEMA_VERSION;
  readonly runtimeContextId: string;
  readonly projectId: string;
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly sourceFingerprint: string;
  readonly contextBytes: number;
  readonly consentReceiptId: string;
  readonly provider: ProviderId;
  readonly policy: 'chat-read-v1';
  readonly policyVersion: 'chat-read-v1.0.0';
};

export type CompletionProjectContextReceiptV1 = {
  readonly schema_version: 1;
  readonly snapshot_id: string;
  readonly snapshot_sha256: string;
  readonly source_fingerprint: string;
  readonly context_bytes: number;
  readonly verified_at: string;
};

/** Metadata-only receipt: provider text and raw project bytes are absent. */
export type CompletionRoundReceiptV1 = {
  readonly providerConfiguration?: ProviderBinding;
  readonly schemaVersion: typeof COMPLETION_ROUND_RECEIPT_SCHEMA_VERSION;
  readonly transportSchemaVersion: 2 | 3;
  /** Harness that produced this model response; legacy rows hydrate as dsh. */
  readonly harnessId: HarnessId;
  readonly turnId: string;
  readonly attemptId: string;
  readonly roundId: string;
  readonly roundIndex: number;
  readonly providerRequestId: string;
  readonly providerResponseId: string;
  readonly requestedModel: ModelId;
  readonly model: ModelId;
  readonly thinkingMode: ConversationThinkingMode;
  readonly finishReason: CompletionFinishReason;
  readonly latencyMs: number;
  readonly visibleHistorySha256: string;
  readonly modelInputSha256: string;
  readonly requestBodySha256: string;
  readonly projectContextReceipt: CompletionProjectContextReceiptV1 | null;
};

export type ActiveAttemptRoundV1 = {
  readonly roundId: string;
  readonly roundIndex: number;
};

export type ConversationTurnV1 = {
  readonly schemaVersion: typeof CONVERSATION_TURN_SCHEMA_VERSION;
  readonly turnId: string;
  readonly userMessageId: string;
  readonly attemptIds: readonly string[];
  readonly createdAt: string;
};

export type TurnAttemptV1 = {
  readonly schemaVersion: typeof TURN_ATTEMPT_SCHEMA_VERSION;
  readonly attemptId: string;
  readonly turnId: string;
  readonly status: TurnAttemptStatus;
  /** Harness that runs this attempt; legacy rows hydrate as dsh. */
  readonly harnessId: HarnessId;
  readonly visibleMessageIds: readonly string[];
  readonly visibleHistorySha256: string | null;
  readonly attachmentIds: readonly string[];
  readonly modelId: ModelId;
  readonly thinkingMode: ConversationThinkingMode;
  readonly contextDisposition: AttemptContextDisposition;
  readonly contextProjectId: string | null;
  /** Workspace authority frozen before an async completion starts. */
  readonly workspaceId: string | null;
  readonly workspaceBindingRevision: number | null;
  readonly projectContext: AttemptProjectContextBindingV1 | null;
  readonly activeRound: ActiveAttemptRoundV1 | null;
  readonly rounds: readonly CompletionRoundReceiptV1[];
  readonly assistantMessageId: string | null;
  readonly failureCode: AttemptFailureCode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Schema-9 journal.  Optional for callers that still construct schema-8 rows. */
  readonly journalRevision?: number;
  /** Final in-memory schema-9 state is V3-only. V2 is bootstrap input only. */
  readonly agent?: PersistedAgentAttemptJournalV3 | null;
};

export type Conversation = {
  readonly id: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
  readonly workspaceBinding?: ConversationWorkspaceBindingV1 | null;
  readonly workspaceBootstrapState?: ConversationWorkspaceBootstrapState;
  readonly runtimeContextId: string | null;
  readonly projectContext: ProjectContextState | null;
  readonly title: string;
  readonly titleSource: ConversationTitleSource;
  readonly modelId: ModelId;
  readonly thinkingMode: ConversationThinkingMode;
  readonly messages: readonly ChatMessage[];
  readonly turns: readonly ConversationTurnV1[];
  readonly attempts: readonly TurnAttemptV1[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Schema-9 conversation-owned grants; absent means the legacy empty set. */
  readonly agentGrants?: readonly AgentConversationGrantV2[];
  /** Wire-key alias accepted only for compatibility with early schema-9 drafts. */
  readonly agent_grants?: readonly AgentConversationGrantV2[];
};

export type ConversationWorkspaceBindingV1 = {
  readonly schemaVersion: typeof CONVERSATION_WORKSPACE_BINDING_SCHEMA_VERSION;
  readonly workspaceId: string;
  readonly bindingRevision: number;
  readonly projectId: string | null;
};

export type WorkspaceAuthorityOutboxV1 = {
  readonly schemaVersion: typeof WORKSPACE_AUTHORITY_OUTBOX_SCHEMA_VERSION;
  readonly operationId: string;
  readonly action: 'forget' | 'delete_owned';
  readonly workspaceId: string;
  readonly bindingRevision: number;
  readonly clearanceReceiptId: string;
  readonly createdAt: string;
};

export type WorkspaceBindingOwnerV1 = {
  readonly conversationId: string;
  readonly expectedConversation: Conversation;
  readonly expectedProjectContext: ProjectContextState | null;
  readonly expectedDestructiveEpoch: number;
};

export type ApplyWorkspaceBindingInputCamelV1 = {
  readonly schemaVersion: typeof CONVERSATION_WORKSPACE_BINDING_SCHEMA_VERSION;
  readonly owner: WorkspaceBindingOwnerV1;
  readonly binding: ConversationWorkspaceBindingV1 | null;
};

/** Exact snake-case request shape used at the persistence/bridge boundary. */
export type WorkspaceBindingOwnerWireV1 = {
  readonly conversation_id: string;
  readonly expected_conversation: Conversation;
  readonly expected_project_context: ProjectContextState | null;
  readonly expected_destructive_epoch: number;
};

export type ConversationWorkspaceBindingWireV1 = {
  readonly schema_version: typeof CONVERSATION_WORKSPACE_BINDING_SCHEMA_VERSION;
  readonly workspace_id: string;
  readonly binding_revision: number;
  readonly project_id: string | null;
};

export type ApplyWorkspaceBindingInputWireV1 = {
  readonly schema_version: typeof CONVERSATION_WORKSPACE_BINDING_SCHEMA_VERSION;
  readonly owner: WorkspaceBindingOwnerWireV1;
  readonly binding: ConversationWorkspaceBindingWireV1 | null;
};

export type ApplyWorkspaceBindingInputV1 =
  | ApplyWorkspaceBindingInputCamelV1
  | ApplyWorkspaceBindingInputWireV1;

export type WorkspaceAuthorityMutationInputV1 = {
  readonly schemaVersion: typeof WORKSPACE_AUTHORITY_OUTBOX_SCHEMA_VERSION;
  readonly operationId: string;
  readonly action: 'forget' | 'delete_owned';
  readonly workspaceId: string;
  readonly bindingRevision: number;
  readonly clearanceReceiptId: string;
  readonly expectedState: ChatState;
};

/**
 * Immutable ownership captured before an async native context operation.
 * expectedContext is intentionally an exact in-memory CAS reference.
 */
export type ProjectContextMutationScope = {
  readonly conversationId: string;
  readonly projectId: string;
  readonly runtimeContextId: string;
  readonly modelId: ModelId;
  readonly expectedContext: ProjectContextState;
};

export type ProjectContextDestructiveTransitionV1 = {
  readonly schemaVersion: typeof PROJECT_CONTEXT_DESTRUCTIVE_TRANSITION_SCHEMA_VERSION;
  readonly lifecycleId: string;
  readonly epoch: number;
  readonly action: ProjectContextDestructiveAction;
  readonly phase: ProjectContextDestructivePhase;
  readonly conversationId: string;
  readonly sourceProjectId: string;
  readonly sourceRuntimeContextId: string | null;
  readonly sourceModelId: ModelId;
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly consentReceiptId: string | null;
  readonly targetProjectId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ProjectContextDestructiveOwner = {
  readonly conversationId: string;
  readonly projectId: string;
  readonly runtimeContextId: string | null;
  readonly modelId: ModelId;
  readonly expectedUpdatedAt: string;
  readonly expectedContext: ProjectContextState;
};

export type ProjectContextDestructiveAdvanceScope = {
  readonly lifecycleId: string;
  readonly epoch: number;
  readonly action: ProjectContextDestructiveAction;
  readonly targetProjectId: string | null;
  /** Exact reference captured from the checkpoint the caller is advancing. */
  readonly expectedTransition: ProjectContextDestructiveTransitionV1;
};

export type ChatState = {
  readonly schemaVersion: typeof CHAT_STATE_SCHEMA_VERSION;
  readonly workspaceAuthorityOutbox?: readonly WorkspaceAuthorityOutboxV1[];
  readonly projectContextDestructiveEpoch: number;
  readonly projectContextDestructiveTransition: ProjectContextDestructiveTransitionV1 | null;
  readonly conversations: Readonly<Record<string, Conversation>>;
  readonly conversationOrder: readonly string[];
  readonly selectedConversationId: string | null;
  /** Session schema-9 fields are optional in the in-memory chat projection. */
  readonly agentTranscriptCleanupOutbox?: readonly AgentTranscriptCleanupV1[];
  readonly sessionEvents?: readonly PersistedSessionEventV3[];
  readonly preferences?: PersistedAppPreferencesV1;
  /** Migration facts are in-memory diagnostics and are never serialized. */
  readonly migrationDiagnostics?: ChatStateMigrationDiagnostics;
};

export type ChatStateMigrationDiagnostics = {
  readonly defaulted_legacy_preferences?: true;
  readonly dropped_legacy_session_events?: true;
};

export type AgentConversationDeleteWithCleanupInput = {
  readonly conversationId: string;
  readonly expectedConversation: Conversation;
  readonly cleanup: readonly AgentTranscriptCleanupV1[];
};

export type ChatAction =
  | {
      readonly type: 'conversation/create';
      readonly payload: {
        readonly id: string;
        readonly at: string;
        readonly modelId?: ModelId;
        readonly thinkingMode?: ConversationThinkingMode;
        readonly projectId?: string | null;
        readonly workspaceId?: string | null;
        readonly title?: string;
        readonly select?: boolean;
      };
    }
  | {
      readonly type: 'conversation/rename';
      readonly payload: {
        readonly id: string;
        readonly title: string;
        readonly at: string;
      };
    }
  | {
      readonly type: 'conversation/auto-title';
      readonly payload: {
        readonly id: string;
        readonly text: string;
        readonly at: string;
      };
    }
  | {
      readonly type: 'conversation/select';
      readonly payload: { readonly id: string | null };
    }
  | {
      readonly type: 'conversation/delete';
      readonly payload: { readonly id: string };
    }
  | {
      /** Atomically retain terminal transcript owners while deleting a chat. */
      readonly type: 'conversation/delete-with-agent-cleanup';
      readonly payload: {
        readonly conversationId: string;
        readonly expectedConversation: Conversation;
        readonly cleanup: readonly AgentTranscriptCleanupV1[];
      };
    }
  | {
      readonly type: 'conversation/set-model';
      readonly payload: {
        readonly id: string;
        readonly modelId: ModelId;
        readonly at: string;
      };
    }
  | {
      readonly type: 'conversation/set-thinking';
      readonly payload: {
        readonly id: string;
        readonly thinkingMode: ConversationThinkingMode;
        readonly at: string;
      };
    }
  | {
      readonly type: 'conversation/bind-project';
      readonly payload: {
        readonly id: string;
        readonly projectId: string;
        readonly at: string;
      };
    }
  | {
      readonly type: 'conversation/unbind-project';
      readonly payload: {
        readonly id: string;
        readonly at: string;
      };
    }
  | {
      readonly type: 'conversation/bind-workspace';
      readonly payload: {
        readonly id: string;
        readonly workspaceId: string;
        readonly at: string;
      };
    }
  | {
      readonly type: 'conversation/unbind-workspace';
      readonly payload: {
        readonly id: string;
        readonly at: string;
      };
    }
  | {
      readonly type: 'conversation/apply-workspace-binding';
      readonly payload: {
        readonly owner: WorkspaceBindingOwnerV1;
        readonly binding: ConversationWorkspaceBindingV1 | null;
        readonly at: string;
      };
    }
  | {
      readonly type: 'conversation/ensure-runtime-context';
      readonly payload: {
        readonly id: string;
        readonly runtimeContextId: string;
        readonly at: string;
      };
    }
  | {
      readonly type: 'project-context/apply';
      readonly payload: {
        readonly conversationId: string;
        readonly action: ProjectContextAction;
        readonly at: string;
      };
    }
  | {
      readonly type: 'project-context/replace-prepared';
      readonly payload: {
        readonly scope: ProjectContextMutationScope;
        readonly preparationId: string;
        readonly selectedPaths: readonly string[];
        readonly manifest: ProjectContextManifestV1;
        readonly at: string;
      };
    }
  | {
      readonly type: 'project-context/replace-confirmed';
      readonly payload: {
        readonly scope: ProjectContextMutationScope;
        readonly preparationId: string;
        readonly selectedPaths: readonly string[];
        readonly manifest: ProjectContextManifestV1;
        readonly consent: ProjectContextConsentV1;
        readonly at: string;
      };
    }
  | {
      readonly type: 'project-context/disable';
      readonly payload: {
        readonly scope: ProjectContextMutationScope;
        readonly at: string;
      };
    }
  | {
      readonly type: 'project-context-destructive/begin';
      readonly payload: {
        readonly lifecycleId: string;
        readonly action: ProjectContextDestructiveAction;
        readonly targetProjectId: string | null;
        readonly owner: ProjectContextDestructiveOwner;
        readonly at: string;
      };
    }
  | {
      readonly type: 'project-context-destructive/tombstone';
      readonly payload: {
        readonly scope: ProjectContextDestructiveAdvanceScope;
        readonly at: string;
      };
    }
  | {
      readonly type: 'project-context-destructive/cleanup-complete';
      readonly payload: {
        readonly scope: ProjectContextDestructiveAdvanceScope;
        readonly at: string;
      };
    }
  | {
      readonly type: 'project-context-destructive/finalize';
      readonly payload: {
        readonly scope: ProjectContextDestructiveAdvanceScope;
        readonly at: string;
      };
    }
  | {
      readonly type: 'message/append';
      readonly payload: {
        readonly conversationId: string;
        readonly message: ChatMessage;
      };
    }
  | {
      readonly type: 'turn/prepare';
      readonly payload: {
        readonly conversationId: string;
        readonly message: ChatMessage;
        readonly turn: ConversationTurnV1;
        readonly attempt: TurnAttemptV1;
      };
    }
  | {
      readonly type: 'attempt/start-round';
      readonly payload: {
        readonly conversationId: string;
        readonly attemptId: string;
        readonly round: ActiveAttemptRoundV1;
        readonly at: string;
      };
    }
  | {
      readonly type: 'attempt/record-round';
      readonly payload: {
        readonly conversationId: string;
        readonly attemptId: string;
        readonly receipt: CompletionRoundReceiptV1;
        readonly at: string;
      };
    }
  | {
      readonly type: 'attempt/complete';
      readonly payload: {
        readonly conversationId: string;
        readonly attemptId: string;
        readonly message: ChatMessage;
      };
    }
  | {
      readonly type: 'attempt/fail';
      readonly payload: {
        readonly conversationId: string;
        readonly attemptId: string;
        readonly failureCode: string;
        readonly at: string;
      };
    }
  | {
      readonly type: 'attempt/cancel';
      readonly payload: {
        readonly conversationId: string;
        readonly attemptId: string;
        readonly at: string;
      };
    }
  | {
      readonly type: 'attempt/retry';
      readonly payload: {
        readonly conversationId: string;
        readonly sourceAttemptId: string;
        readonly attempt: TurnAttemptV1;
      };
    }
  | {
      /** Replace one immutable Agent journal checkpoint under an exact CAS. */
      readonly type: 'attempt/agent-checkpoint';
      readonly payload: {
        readonly cas: AgentControllerCASV1;
        readonly conversationId: string;
        readonly attemptId: string;
        readonly expectedAttempt: TurnAttemptV1;
        readonly journal: PersistedAgentAttemptJournalV3 | null;
        readonly journalRevision?: number;
        readonly events: readonly PersistedSessionEventV3[];
        readonly evidence: AgentCheckpointEvidence;
        /** Terminal cleanup ownership is part of this same session candidate. */
        readonly cleanup?: AgentTranscriptCleanupV1;
        readonly at: string;
      };
    }
  | {
      /**
       * Advances only the cursor within an already-frozen native tool batch.
       * This local session checkpoint deliberately carries no native evidence
       * and cannot create approval or execution events.
       */
      readonly type: 'attempt/agent-advance-call';
      readonly payload: {
        readonly cas: AgentControllerCASV1;
        readonly conversationId: string;
        readonly attemptId: string;
        readonly expectedAttempt: TurnAttemptV1;
        readonly journal: PersistedAgentAttemptJournalV3;
        readonly journalRevision?: number;
        readonly at: string;
      };
    }
  | {
      /**
       * Atomically installs the first terminal Agent checkpoint together with
       * its user-visible response (when any), terminal event, and transcript
       * cleanup ownership.
       */
      readonly type: 'attempt/agent-final-checkpoint';
      readonly payload: {
        readonly cas: AgentControllerCASV1;
        readonly conversationId: string;
        readonly attemptId: string;
        readonly expectedAttempt: TurnAttemptV1;
        readonly journal: PersistedAgentAttemptJournalV3;
        readonly journalRevision?: number;
        readonly events: readonly PersistedSessionEventV3[];
        readonly evidence: AgentStoreTransitionEvidence;
        readonly assistantMessage: ChatMessage | null;
        readonly cleanup: AgentTranscriptCleanupV1;
        readonly at: string;
      };
    }
  | {
      /** Atomically replace conversation-owned grants under an exact CAS. */
      readonly type: 'conversation/agent-grants';
      readonly payload: {
        readonly conversationId: string;
        readonly expectedConversation: Conversation;
        readonly grants: readonly AgentConversationGrantV2[];
        readonly at: string;
      };
    }
  | {
      /** One candidate updates the decision and its conversation grant. */
      readonly type: 'agent/approval-checkpoint';
      readonly payload: {
        readonly cas: AgentControllerCASV1;
        readonly conversationId: string;
        readonly attemptId: string;
        readonly expectedAttempt: TurnAttemptV1;
        readonly expectedConversation: Conversation;
        readonly journal: PersistedAgentAttemptJournalV3;
        readonly grants: readonly AgentConversationGrantV2[];
        readonly events: readonly PersistedSessionEventV3[];
        readonly evidence: AgentCheckpointEvidence;
        readonly journalRevision?: number;
        readonly cleanup?: AgentTranscriptCleanupV1;
        readonly at: string;
      };
    }
  | {
      readonly type: 'agent/cleanup-enqueue';
      readonly payload: {
        readonly conversationId: string;
        readonly attemptId: string;
        readonly cleanup: AgentTranscriptCleanupV1;
        readonly expectedAttempt: TurnAttemptV1;
        readonly at: string;
      };
    }
  | {
      readonly type: 'agent/cleanup-ack';
      readonly payload: {
        readonly cleanupId: string;
        readonly expectedCleanup: AgentTranscriptCleanupV1;
      };
    }
  | {
      /**
       * Give up on an attempt whose round the device can never resolve.
       *
       * A round that reached the provider and was never answered settles
       * `ambiguous`, and recovery answers that with manual reconciliation
       * forever: the model may have done the work, so nothing may replay it.
       * This is the person saying so. It records the attempt exactly as a
       * dead writer's is recorded at hydration -- failed with
       * E_ATTEMPT_INTERRUPTED, journal kept as evidence -- and enqueues the
       * cleanup that lets the native interrupt settle the residue an
       * ambiguous round leaves behind.
       */
      readonly type: 'agent/abandon-unresolved';
      readonly payload: {
        readonly conversationId: string;
        readonly attemptId: string;
        readonly expectedAttempt: TurnAttemptV1;
        readonly cleanup: AgentTranscriptCleanupV1;
        readonly at: string;
      };
    };

export type PersistedChatMessageV2 = {
  readonly id: string;
  readonly role: ChatRole;
  readonly text: string;
  readonly created_at: string;
  readonly metadata?: {
    readonly model_id?: ModelId;
    readonly latency_ms?: number;
    readonly finish_reason?: string;
    readonly reasoning?: string;
  };
};

export type PersistedConversationV2 = {
  readonly id: string;
  readonly title: string;
  readonly title_source: ConversationTitleSource;
  readonly model_id: ModelId;
  readonly thinking_mode?: ConversationThinkingMode;
  readonly messages: readonly PersistedChatMessageV2[];
  readonly created_at: string;
  readonly updated_at: string;
};

/**
 * `messages` intentionally mirrors the active conversation. The native runtime
 * reads this projection when producing its local-persistence proof.
 */
export type PersistedChatStateV2 = {
  readonly schema_version: typeof LEGACY_CHAT_STATE_SCHEMA_VERSION;
  readonly active_conversation_id: string | null;
  readonly conversations: readonly PersistedConversationV2[];
  readonly messages: readonly PersistedChatMessageV2[];
};

export type PersistedChatMessageV3 = PersistedChatMessageV2;

export type PersistedConversationV3 = {
  readonly id: string;
  readonly project_id: string | null;
  readonly title: string;
  readonly title_source: ConversationTitleSource;
  readonly model_id: ModelId;
  readonly thinking_mode: ConversationThinkingMode;
  readonly messages: readonly PersistedChatMessageV3[];
  readonly created_at: string;
  readonly updated_at: string;
};

export type PersistedChatStateV3 = {
  readonly schema_version: typeof OLDER_CHAT_STATE_SCHEMA_VERSION;
  readonly active_conversation_id: string | null;
  readonly conversations: readonly PersistedConversationV3[];
  readonly messages: readonly PersistedChatMessageV3[];
};

export type PersistedChatAttachmentV1 = {
  readonly schema_version: typeof ATTACHMENT_DESCRIPTOR_SCHEMA_VERSION;
  readonly id: string;
  readonly kind: ChatAttachmentKind;
  readonly name: string;
  readonly mime_type: string;
  readonly size: number;
};

export type PersistedChatMessageV4 = {
  readonly id: string;
  readonly role: ChatRole;
  readonly text: string;
  readonly created_at: string;
  readonly attachments: readonly PersistedChatAttachmentV1[];
  readonly metadata?: PersistedChatMessageV2['metadata'];
};

export type PersistedConversationV4 = {
  readonly id: string;
  readonly project_id: string | null;
  readonly title: string;
  readonly title_source: ConversationTitleSource;
  readonly model_id: ModelId;
  readonly thinking_mode: ConversationThinkingMode;
  readonly messages: readonly PersistedChatMessageV4[];
  readonly created_at: string;
  readonly updated_at: string;
};

export type PersistedChatStateV4 = {
  readonly schema_version: typeof ATTACHMENT_CHAT_STATE_SCHEMA_VERSION;
  readonly active_conversation_id: string | null;
  readonly conversations: readonly PersistedConversationV4[];
  readonly messages: readonly PersistedChatMessageV4[];
};

export type PersistedConversationV5 = {
  readonly id: string;
  readonly project_id: string | null;
  readonly workspace_id: string | null;
  readonly title: string;
  readonly title_source: ConversationTitleSource;
  readonly model_id: ModelId;
  readonly thinking_mode: ConversationThinkingMode;
  readonly messages: readonly PersistedChatMessageV4[];
  readonly created_at: string;
  readonly updated_at: string;
};

export type PersistedChatStateV5 = {
  readonly schema_version: typeof WORKSPACE_CHAT_STATE_SCHEMA_VERSION;
  readonly active_conversation_id: string | null;
  readonly conversations: readonly PersistedConversationV5[];
  readonly messages: readonly PersistedChatMessageV4[];
};

export type PersistedConversationTurnV1 = {
  readonly schema_version: 1;
  readonly turn_id: string;
  readonly user_message_id: string;
  readonly attempt_ids: readonly string[];
  readonly created_at: string;
};

export type PersistedAttemptProjectContextV1 = {
  readonly schema_version: 1;
  readonly runtime_context_id: string;
  readonly project_id: string;
  readonly snapshot_id: string;
  readonly snapshot_sha256: string;
  readonly source_fingerprint: string;
  readonly context_bytes: number;
  readonly consent_receipt_id: string;
  readonly provider: ProviderId;
  readonly policy: 'chat-read-v1';
  readonly policy_version: 'chat-read-v1.0.0';
};

export type PersistedCompletionRoundReceiptV1 = {
  readonly provider_configuration?: ProviderBinding;
  readonly schema_version: 1;
  readonly transport_schema_version: 2 | 3;
  /** Omitted by legacy snapshots; hydration defaults to dsh. */
  readonly harness_id?: string;
  readonly turn_id: string;
  readonly attempt_id: string;
  readonly round_id: string;
  readonly round_index: number;
  readonly provider_request_id: string;
  readonly provider_response_id: string;
  readonly requested_model: ModelId;
  readonly model: ModelId;
  readonly thinking_mode: ConversationThinkingMode;
  readonly finish_reason: CompletionFinishReason;
  readonly latency_ms: number;
  readonly visible_history_sha256: string;
  readonly model_input_sha256: string;
  readonly request_body_sha256: string;
  readonly project_context_receipt: CompletionProjectContextReceiptV1 | null;
};

export type PersistedTurnAttemptV1 = {
  readonly schema_version: 1;
  readonly attempt_id: string;
  readonly turn_id: string;
  readonly status: TurnAttemptStatus;
  /** Omitted by legacy snapshots; hydration defaults to dsh. */
  readonly harness_id?: string;
  readonly visible_message_ids: readonly string[];
  readonly visible_history_sha256: string | null;
  readonly attachment_ids: readonly string[];
  readonly model_id: ModelId;
  readonly thinking_mode: ConversationThinkingMode;
  readonly context_disposition: AttemptContextDisposition;
  readonly context_project_id: string | null;
  /** Required by schema 8; omitted by schema 7 persistence. */
  readonly workspace_id?: string | null;
  /** Required by schema 8; omitted by schema 7 persistence. */
  readonly workspace_binding_revision?: number | null;
  readonly project_context: PersistedAttemptProjectContextV1 | null;
  readonly active_round: {
    readonly round_id: string;
    readonly round_index: number;
  } | null;
  readonly rounds: readonly PersistedCompletionRoundReceiptV1[];
  readonly assistant_message_id: string | null;
  readonly failure_code: AttemptFailureCode | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type PersistedConversationV6 = PersistedConversationV5 & {
  readonly runtime_context_id: string | null;
  readonly project_context: PersistedProjectContextStateV1 | null;
  readonly turns: readonly PersistedConversationTurnV1[];
  readonly attempts: readonly PersistedTurnAttemptV1[];
};

export type PersistedChatStateV6 = {
  readonly schema_version: typeof PROJECT_CONTEXT_CHAT_STATE_SCHEMA_VERSION;
  readonly active_conversation_id: string | null;
  readonly conversations: readonly PersistedConversationV6[];
  readonly messages: readonly PersistedChatMessageV4[];
};

/** Schema-7 persisted shape, before workspace authority binding existed. */
export type PersistedConversationV7 = PersistedConversationV6;

export type PersistedChatStateV7 = {
  readonly schema_version: typeof PREVIOUS_CHAT_STATE_SCHEMA_VERSION;
  readonly project_context_destructive_epoch: number;
  readonly project_context_destructive_transition: PersistedProjectContextDestructiveTransitionV1 | null;
  readonly active_conversation_id: string | null;
  readonly conversations: readonly PersistedConversationV7[];
  readonly messages: readonly PersistedChatMessageV4[];
};

export type PersistedProjectContextDestructiveTransitionV1 = {
  readonly schema_version: typeof PROJECT_CONTEXT_DESTRUCTIVE_TRANSITION_SCHEMA_VERSION;
  readonly lifecycle_id: string;
  readonly epoch: number;
  readonly action: ProjectContextDestructiveAction;
  readonly phase: ProjectContextDestructivePhase;
  readonly conversation_id: string;
  readonly source_project_id: string;
  readonly source_runtime_context_id: string | null;
  readonly source_model_id: ModelId;
  readonly snapshot_id: string;
  readonly snapshot_sha256: string;
  readonly consent_receipt_id: string | null;
  readonly target_project_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type PersistedConversationWorkspaceBindingV1 = {
  readonly schema_version: typeof CONVERSATION_WORKSPACE_BINDING_SCHEMA_VERSION;
  readonly workspace_id: string;
  readonly binding_revision: number;
  readonly project_id: string | null;
};

export type PersistedWorkspaceAuthorityOutboxV1 = {
  readonly schema_version: typeof WORKSPACE_AUTHORITY_OUTBOX_SCHEMA_VERSION;
  readonly operation_id: string;
  readonly action: 'forget' | 'delete_owned';
  readonly workspace_id: string;
  readonly binding_revision: number;
  readonly clearance_receipt_id: string;
  readonly created_at: string;
};

export type PersistedConversationV8 = PersistedConversationV6 & {
  readonly workspace_binding: PersistedConversationWorkspaceBindingV1 | null;
  readonly workspace_bootstrap_state: ConversationWorkspaceBootstrapState;
};

export type PersistedChatStateV8 = {
  readonly schema_version: typeof CHAT_STATE_SCHEMA_VERSION_V8;
  readonly workspace_authority_outbox: readonly PersistedWorkspaceAuthorityOutboxV1[];
  readonly project_context_destructive_epoch: number;
  readonly project_context_destructive_transition: PersistedProjectContextDestructiveTransitionV1 | null;
  readonly active_conversation_id: string | null;
  readonly conversations: readonly PersistedConversationV8[];
  readonly messages: readonly PersistedChatMessageV4[];
};

/**
 * The exact schema-9 session root.  Preferences are deliberately typed as an
 * opaque value here: the preferences package owns its parser and schema; the
 * chat parser only preserves the value and rejects malformed/non-record roots.
 */
export type PersistedSessionSnapshotV9 = {
  readonly schema_version: typeof CHAT_STATE_SCHEMA_VERSION;
  readonly workspace_authority_outbox: readonly PersistedWorkspaceAuthorityOutboxV1[];
  readonly agent_transcript_cleanup_outbox: readonly AgentTranscriptCleanupV1[];
  readonly project_context_destructive_epoch: number;
  readonly project_context_destructive_transition: PersistedProjectContextDestructiveTransitionV1 | null;
  readonly active_conversation_id: string | null;
  readonly conversations: readonly PersistedConversationV9Final[];
  readonly messages: readonly PersistedChatMessageV4[];
  readonly session_events: readonly PersistedSessionEventV3[];
  readonly preferences: PersistedAppPreferencesV1;
};

export type PersistedChatStateV9 = PersistedSessionSnapshotV9;

export type PersistedConversationV9 = {
  readonly id: string;
  readonly project_id: string | null;
  readonly workspace_id: string | null;
  readonly title: string;
  readonly title_source: ConversationTitleSource;
  readonly model_id: ModelId;
  readonly thinking_mode: ConversationThinkingMode;
  readonly messages: readonly PersistedChatMessageV4[];
  readonly created_at: string;
  readonly updated_at: string;
  readonly runtime_context_id: string | null;
  readonly project_context: PersistedProjectContextStateV1 | null;
  readonly turns: readonly PersistedConversationTurnV1[];
  readonly attempts: readonly PersistedTurnAttemptV3[];
  readonly workspace_binding: PersistedConversationWorkspaceBindingV1 | null;
  readonly workspace_bootstrap_state: ConversationWorkspaceBootstrapState;
  readonly agent_grants: readonly AgentConversationGrantV2[];
};

export type PersistedTurnAttemptV2 = {
  readonly schema_version: typeof PERSISTED_TURN_ATTEMPT_SCHEMA_VERSION;
  readonly attempt_id: string;
  readonly turn_id: string;
  readonly status: TurnAttemptStatus;
  /** Omitted by legacy snapshots; hydration defaults to dsh. */
  readonly harness_id?: string;
  readonly visible_message_ids: readonly string[];
  readonly visible_history_sha256: string | null;
  readonly attachment_ids: readonly string[];
  readonly model_id: ModelId;
  readonly thinking_mode: ConversationThinkingMode;
  readonly context_disposition: AttemptContextDisposition;
  readonly context_project_id: string | null;
  readonly workspace_id: string | null;
  readonly workspace_binding_revision: number | null;
  readonly project_context: PersistedAttemptProjectContextV1 | null;
  readonly active_round: {
    readonly round_id: string;
    readonly round_index: number;
  } | null;
  readonly rounds: readonly PersistedCompletionRoundReceiptV1[];
  readonly assistant_message_id: string | null;
  readonly failure_code: AttemptFailureCode | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly journal_revision: number;
  readonly agent: PersistedAgentAttemptJournalV2 | null;
};

/** Final schema-9 conversation and attempt shapes. */
export type PersistedConversationV9Final = Omit<
  PersistedConversationV9,
  'attempts'
> & {
  readonly attempts: readonly PersistedTurnAttemptV3[];
};

export type PersistedTurnAttemptV3 = Omit<
  PersistedTurnAttemptV2,
  'schema_version' | 'agent'
> & {
  readonly schema_version: typeof PERSISTED_TURN_ATTEMPT_SCHEMA_VERSION_V3;
  readonly agent: PersistedAgentAttemptJournalV3 | null;
};

/** Public aliases used by reducer/store consumers; wire keys stay snake-case. */
export type AgentAttemptJournalV2 = PersistedAgentAttemptJournalV2;
export type AgentCallJournalV2 = PersistedAgentCallJournalV2;
export type AgentAttemptJournalV3 = PersistedAgentAttemptJournalV3;
export type AgentCallJournalV3 = PersistedAgentCallJournalV3;
export type AgentConversationGrant = AgentConversationGrantV2;
/** Compatibility names from the original schema-9 draft; wire shape is V2. */
export type AgentAttemptJournalV1 = PersistedAgentAttemptJournalV2;
export type AgentCallJournalV1 = PersistedAgentCallJournalV2;
export type AgentConversationGrantV1 = AgentConversationGrantV2;
export type ChatStateV9 = ChatState;
export type ConversationV9 = Conversation;

export type HydrationResult =
  | { readonly ok: true; readonly state: ChatState }
  | { readonly ok: false; readonly error: ChatStateValidationError };

export class ChatStateValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ChatStateValidationError';
    this.path = path;
  }
}

import type {
  PersistedProjectContextStateV1,
  ProjectContextAction,
  ProjectContextConsentV1,
  ProjectContextManifestV1,
  ProjectContextState,
} from '../project-context/types';

export const CHAT_STATE_SCHEMA_VERSION = 6 as const;
export const PREVIOUS_CHAT_STATE_SCHEMA_VERSION = 5 as const;
export const ATTACHMENT_CHAT_STATE_SCHEMA_VERSION = 4 as const;
export const LEGACY_CHAT_STATE_SCHEMA_VERSION = 2 as const;
export const OLDER_CHAT_STATE_SCHEMA_VERSION = 3 as const;
export const ATTACHMENT_DESCRIPTOR_SCHEMA_VERSION = 1 as const;
export const CONVERSATION_TURN_SCHEMA_VERSION = 1 as const;
export const TURN_ATTEMPT_SCHEMA_VERSION = 1 as const;
export const ATTEMPT_PROJECT_CONTEXT_SCHEMA_VERSION = 1 as const;
export const COMPLETION_ROUND_RECEIPT_SCHEMA_VERSION = 1 as const;

export const ATTACHMENT_KINDS = ['image', 'text', 'pdf'] as const;

export const SUPPORTED_MODEL_IDS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash-vision-exp',
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
  'E_COMPLETION_TRANSPORT',
  'E_COMPLETION_HTTP_STATUS',
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
] as const;

export type ModelId = (typeof SUPPORTED_MODEL_IDS)[number];
export type ConversationThinkingMode =
  (typeof CONVERSATION_THINKING_MODES)[number];
export type ChatRole = 'user' | 'assistant';
export type ConversationTitleSource = 'auto' | 'manual';
export type ChatAttachmentKind = (typeof ATTACHMENT_KINDS)[number];
export type TurnAttemptStatus = (typeof TURN_ATTEMPT_STATUSES)[number];
export type CompletionFinishReason =
  (typeof COMPLETION_FINISH_REASONS)[number];
export type AttemptContextDisposition =
  (typeof ATTEMPT_CONTEXT_DISPOSITIONS)[number];
export type AttemptFailureCode = (typeof ATTEMPT_FAILURE_CODES)[number];

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
  readonly provider: 'deepseek';
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
  readonly schemaVersion: typeof COMPLETION_ROUND_RECEIPT_SCHEMA_VERSION;
  readonly transportSchemaVersion: 2 | 3;
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
  readonly visibleMessageIds: readonly string[];
  readonly visibleHistorySha256: string | null;
  readonly attachmentIds: readonly string[];
  readonly modelId: ModelId;
  readonly thinkingMode: ConversationThinkingMode;
  readonly contextDisposition: AttemptContextDisposition;
  readonly contextProjectId: string | null;
  readonly projectContext: AttemptProjectContextBindingV1 | null;
  readonly activeRound: ActiveAttemptRoundV1 | null;
  readonly rounds: readonly CompletionRoundReceiptV1[];
  readonly assistantMessageId: string | null;
  readonly failureCode: AttemptFailureCode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type Conversation = {
  readonly id: string;
  readonly projectId: string | null;
  readonly workspaceId: string | null;
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

export type ChatState = {
  readonly schemaVersion: typeof CHAT_STATE_SCHEMA_VERSION;
  readonly conversations: Readonly<Record<string, Conversation>>;
  readonly conversationOrder: readonly string[];
  readonly selectedConversationId: string | null;
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
  readonly schema_version: typeof PREVIOUS_CHAT_STATE_SCHEMA_VERSION;
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
  readonly provider: 'deepseek';
  readonly policy: 'chat-read-v1';
  readonly policy_version: 'chat-read-v1.0.0';
};

export type PersistedCompletionRoundReceiptV1 = {
  readonly schema_version: 1;
  readonly transport_schema_version: 2 | 3;
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
  readonly visible_message_ids: readonly string[];
  readonly visible_history_sha256: string | null;
  readonly attachment_ids: readonly string[];
  readonly model_id: ModelId;
  readonly thinking_mode: ConversationThinkingMode;
  readonly context_disposition: AttemptContextDisposition;
  readonly context_project_id: string | null;
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
  readonly schema_version: typeof CHAT_STATE_SCHEMA_VERSION;
  readonly active_conversation_id: string | null;
  readonly conversations: readonly PersistedConversationV6[];
  readonly messages: readonly PersistedChatMessageV4[];
};

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

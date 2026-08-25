export const CHAT_STATE_SCHEMA_VERSION = 4 as const;
export const PREVIOUS_CHAT_STATE_SCHEMA_VERSION = 3 as const;
export const LEGACY_CHAT_STATE_SCHEMA_VERSION = 2 as const;
export const ATTACHMENT_DESCRIPTOR_SCHEMA_VERSION = 1 as const;

export const ATTACHMENT_KINDS = ['image', 'text', 'pdf'] as const;

export const SUPPORTED_MODEL_IDS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash-vision-exp',
] as const;

export const CONVERSATION_THINKING_MODES = ['off', 'high', 'max'] as const;

export type ModelId = (typeof SUPPORTED_MODEL_IDS)[number];
export type ConversationThinkingMode =
  (typeof CONVERSATION_THINKING_MODES)[number];
export type ChatRole = 'user' | 'assistant';
export type ConversationTitleSource = 'auto' | 'manual';
export type ChatAttachmentKind = (typeof ATTACHMENT_KINDS)[number];

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

export type Conversation = {
  readonly id: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly titleSource: ConversationTitleSource;
  readonly modelId: ModelId;
  readonly thinkingMode: ConversationThinkingMode;
  readonly messages: readonly ChatMessage[];
  readonly createdAt: string;
  readonly updatedAt: string;
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
      readonly type: 'message/append';
      readonly payload: {
        readonly conversationId: string;
        readonly message: ChatMessage;
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
  readonly schema_version: typeof PREVIOUS_CHAT_STATE_SCHEMA_VERSION;
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
  readonly schema_version: typeof CHAT_STATE_SCHEMA_VERSION;
  readonly active_conversation_id: string | null;
  readonly conversations: readonly PersistedConversationV4[];
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

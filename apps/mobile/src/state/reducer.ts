import {
  ATTACHMENT_DESCRIPTOR_SCHEMA_VERSION,
  ATTACHMENT_KINDS,
  CHAT_STATE_SCHEMA_VERSION,
  CONVERSATION_THINKING_MODES,
  SUPPORTED_MODEL_IDS,
  type ChatAction,
  type ChatAttachment,
  type ChatAttachmentKind,
  type ChatMessage,
  type ChatState,
  type Conversation,
  type ConversationThinkingMode,
  type ModelId,
} from './types';

export const DEFAULT_CONVERSATION_TITLE = 'New chat';
export const DEFAULT_MODEL_ID: ModelId = 'deepseek-v4-flash';
export const DEFAULT_THINKING_MODE: ConversationThinkingMode = 'high';
export const AUTO_TITLE_MAX_LENGTH = 48;
export const MANUAL_TITLE_MAX_LENGTH = 120;
export const PROJECT_ID_MAX_LENGTH = 256;
export const MAX_ATTACHMENTS_PER_MESSAGE = 6;
export const MAX_ATTACHMENT_ID_LENGTH = 256;
export const MAX_ATTACHMENT_NAME_LENGTH = 256;
export const MAX_ATTACHMENT_MIME_TYPE_LENGTH = 256;
export const MAX_TEXT_ATTACHMENT_SIZE = 1024 * 1024;
export const MAX_BINARY_ATTACHMENT_SIZE = 8 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_SIZE = 24 * 1024 * 1024;

const supportedModels: ReadonlySet<string> = new Set(SUPPORTED_MODEL_IDS);
const thinkingModes: ReadonlySet<string> = new Set(CONVERSATION_THINKING_MODES);
const attachmentKinds: ReadonlySet<string> = new Set(ATTACHMENT_KINDS);
const mimeTypePattern = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;

export function createEmptyChatState(): ChatState {
  return {
    schemaVersion: CHAT_STATE_SCHEMA_VERSION,
    conversations: {},
    conversationOrder: [],
    selectedConversationId: null,
  };
}

export function isModelId(value: unknown): value is ModelId {
  return typeof value === 'string' && supportedModels.has(value);
}

export function isConversationThinkingMode(
  value: unknown,
): value is ConversationThinkingMode {
  return typeof value === 'string' && thinkingModes.has(value);
}

export function isChatAttachmentKind(
  value: unknown,
): value is ChatAttachmentKind {
  return typeof value === 'string' && attachmentKinds.has(value);
}

export function isAttachmentMimeType(
  value: unknown,
  kind: ChatAttachmentKind,
): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ATTACHMENT_MIME_TYPE_LENGTH ||
    !mimeTypePattern.test(value)
  ) {
    return false;
  }

  const normalized = value.toLowerCase();
  switch (kind) {
    case 'image':
      return normalized.startsWith('image/');
    case 'text':
      return normalized.startsWith('text/');
    case 'pdf':
      return normalized === 'application/pdf';
  }
}

export function isAttachmentSize(
  value: unknown,
  kind: ChatAttachmentKind,
): value is number {
  const maximum =
    kind === 'text' ? MAX_TEXT_ATTACHMENT_SIZE : MAX_BINARY_ATTACHMENT_SIZE;
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
  );
}

export function isChatAttachment(value: unknown): value is ChatAttachment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const attachment = value as Partial<ChatAttachment>;
  return (
    attachment.schema_version === ATTACHMENT_DESCRIPTOR_SCHEMA_VERSION &&
    typeof attachment.id === 'string' &&
    validIdentifier(attachment.id) &&
    attachment.id.length <= MAX_ATTACHMENT_ID_LENGTH &&
    isChatAttachmentKind(attachment.kind) &&
    typeof attachment.name === 'string' &&
    attachment.name.trim().length > 0 &&
    attachment.name.length <= MAX_ATTACHMENT_NAME_LENGTH &&
    !attachment.name.includes('\0') &&
    isAttachmentMimeType(attachment.mime_type, attachment.kind) &&
    isAttachmentSize(attachment.size, attachment.kind) &&
    (attachment.thumbnail_data_url === undefined ||
      typeof attachment.thumbnail_data_url === 'string')
  );
}

export function areValidChatAttachments(
  value: unknown,
): value is readonly ChatAttachment[] {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return false;
  }

  const ids = new Set<string>();
  let totalSize = 0;
  for (const attachment of value) {
    if (!isChatAttachment(attachment) || ids.has(attachment.id)) {
      return false;
    }
    ids.add(attachment.id);
    totalSize += attachment.size;
    if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE) {
      return false;
    }
  }
  return true;
}

export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

export function deriveAutoTitle(
  text: string,
  maxLength = AUTO_TITLE_MAX_LENGTH,
): string {
  const normalized = text
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (normalized.length === 0) {
    return DEFAULT_CONVERSATION_TITLE;
  }

  const characters = Array.from(normalized);
  if (characters.length <= maxLength) {
    return normalized;
  }

  const visibleLength = Math.max(1, maxLength - 1);
  return `${characters.slice(0, visibleLength).join('').trimEnd()}…`;
}

export function orderConversationIds(
  conversations: Readonly<Record<string, Conversation>>,
): string[] {
  return Object.values(conversations)
    .sort((left, right) => {
      const updatedDifference =
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      if (updatedDifference !== 0) {
        return updatedDifference;
      }

      const createdDifference =
        Date.parse(right.createdAt) - Date.parse(left.createdAt);
      if (createdDifference !== 0) {
        return createdDifference;
      }

      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    })
    .map(conversation => conversation.id);
}

export function selectConversationById(
  state: ChatState,
  id: string,
): Conversation | null {
  return state.conversations[id] ?? null;
}

export function selectOrderedConversations(state: ChatState): Conversation[] {
  return state.conversationOrder.flatMap(id => {
    const conversation = state.conversations[id];
    return conversation === undefined ? [] : [conversation];
  });
}

export function selectActiveConversation(
  state: ChatState,
): Conversation | null {
  return state.selectedConversationId === null
    ? null
    : selectConversationById(state, state.selectedConversationId);
}

export function selectActiveMessages(state: ChatState): readonly ChatMessage[] {
  return selectActiveConversation(state)?.messages ?? [];
}

function validIdentifier(value: string): boolean {
  return value.trim().length > 0 && value.length <= 256;
}

export function isProjectId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= PROJECT_ID_MAX_LENGTH
  );
}

export const WORKSPACE_ID_MAX_LENGTH = 256;

export function isWorkspaceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= WORKSPACE_ID_MAX_LENGTH
  );
}

function normalizeManualTitle(value: string): string | null {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0) {
    return null;
  }
  return Array.from(normalized).slice(0, MANUAL_TITLE_MAX_LENGTH).join('');
}

function laterTimestamp(left: string, right: string): string {
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function withConversation(
  state: ChatState,
  conversation: Conversation,
): ChatState {
  const conversations = {
    ...state.conversations,
    [conversation.id]: conversation,
  };
  return {
    ...state,
    conversations,
    conversationOrder: orderConversationIds(conversations),
  };
}

function hasMessageId(conversation: Conversation, messageId: string): boolean {
  return conversation.messages.some(message => message.id === messageId);
}

function shouldAutoTitle(conversation: Conversation): boolean {
  return (
    conversation.titleSource === 'auto' &&
    !conversation.messages.some(message => message.role === 'user')
  );
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'conversation/create': {
      const {
        id,
        at,
        modelId = DEFAULT_MODEL_ID,
        thinkingMode = DEFAULT_THINKING_MODE,
        projectId = null,
        workspaceId = null,
        select = true,
      } = action.payload;
      if (
        !validIdentifier(id) ||
        !isCanonicalTimestamp(at) ||
        !isModelId(modelId) ||
        !isConversationThinkingMode(thinkingMode) ||
        (projectId !== null && !isProjectId(projectId)) ||
        (workspaceId !== null && !isWorkspaceId(workspaceId)) ||
        state.conversations[id] !== undefined
      ) {
        return state;
      }

      const suppliedTitle =
        action.payload.title === undefined
          ? null
          : normalizeManualTitle(action.payload.title);
      const conversation: Conversation = {
        id,
        projectId,
        workspaceId,
        title: suppliedTitle ?? DEFAULT_CONVERSATION_TITLE,
        titleSource: suppliedTitle === null ? 'auto' : 'manual',
        modelId,
        thinkingMode,
        messages: [],
        createdAt: at,
        updatedAt: at,
      };
      const next = withConversation(state, conversation);
      return select ? { ...next, selectedConversationId: id } : next;
    }

    case 'conversation/rename': {
      const conversation = state.conversations[action.payload.id];
      const title = normalizeManualTitle(action.payload.title);
      if (
        conversation === undefined ||
        title === null ||
        !isCanonicalTimestamp(action.payload.at)
      ) {
        return state;
      }
      if (
        conversation.title === title &&
        conversation.titleSource === 'manual'
      ) {
        return state;
      }
      return withConversation(state, {
        ...conversation,
        title,
        titleSource: 'manual',
        updatedAt: laterTimestamp(conversation.updatedAt, action.payload.at),
      });
    }

    case 'conversation/auto-title': {
      const conversation = state.conversations[action.payload.id];
      if (
        conversation === undefined ||
        conversation.titleSource === 'manual' ||
        !isCanonicalTimestamp(action.payload.at)
      ) {
        return state;
      }
      const title = deriveAutoTitle(action.payload.text);
      if (title === conversation.title) {
        return state;
      }
      return withConversation(state, {
        ...conversation,
        title,
        updatedAt: laterTimestamp(conversation.updatedAt, action.payload.at),
      });
    }

    case 'conversation/select': {
      const { id } = action.payload;
      if (
        state.selectedConversationId === id ||
        (id !== null && state.conversations[id] === undefined)
      ) {
        return state;
      }
      return { ...state, selectedConversationId: id };
    }

    case 'conversation/delete': {
      const { id } = action.payload;
      if (state.conversations[id] === undefined) {
        return state;
      }
      const conversations = { ...state.conversations };
      delete conversations[id];
      const conversationOrder = orderConversationIds(conversations);
      return {
        ...state,
        conversations,
        conversationOrder,
        selectedConversationId:
          state.selectedConversationId === id
            ? conversationOrder[0] ?? null
            : state.selectedConversationId,
      };
    }

    case 'conversation/set-model': {
      const conversation = state.conversations[action.payload.id];
      if (
        conversation === undefined ||
        !isModelId(action.payload.modelId) ||
        !isCanonicalTimestamp(action.payload.at) ||
        conversation.modelId === action.payload.modelId
      ) {
        return state;
      }
      return withConversation(state, {
        ...conversation,
        modelId: action.payload.modelId,
        updatedAt: laterTimestamp(conversation.updatedAt, action.payload.at),
      });
    }

    case 'conversation/set-thinking': {
      const conversation = state.conversations[action.payload.id];
      if (
        conversation === undefined ||
        !isConversationThinkingMode(action.payload.thinkingMode) ||
        !isCanonicalTimestamp(action.payload.at) ||
        conversation.thinkingMode === action.payload.thinkingMode
      ) {
        return state;
      }
      return withConversation(state, {
        ...conversation,
        thinkingMode: action.payload.thinkingMode,
        updatedAt: laterTimestamp(conversation.updatedAt, action.payload.at),
      });
    }

    case 'conversation/bind-project': {
      const conversation = state.conversations[action.payload.id];
      if (
        conversation === undefined ||
        !isProjectId(action.payload.projectId) ||
        !isCanonicalTimestamp(action.payload.at) ||
        conversation.projectId === action.payload.projectId
      ) {
        return state;
      }
      return withConversation(state, {
        ...conversation,
        projectId: action.payload.projectId,
        updatedAt: laterTimestamp(conversation.updatedAt, action.payload.at),
      });
    }

    case 'conversation/unbind-project': {
      const conversation = state.conversations[action.payload.id];
      if (
        conversation === undefined ||
        conversation.projectId === null ||
        !isCanonicalTimestamp(action.payload.at)
      ) {
        return state;
      }
      return withConversation(state, {
        ...conversation,
        projectId: null,
        updatedAt: laterTimestamp(conversation.updatedAt, action.payload.at),
      });
    }

    case 'conversation/bind-workspace': {
      const conversation = state.conversations[action.payload.id];
      if (
        conversation === undefined ||
        !isWorkspaceId(action.payload.workspaceId) ||
        !isCanonicalTimestamp(action.payload.at) ||
        conversation.workspaceId === action.payload.workspaceId
      ) {
        return state;
      }
      return withConversation(state, {
        ...conversation,
        workspaceId: action.payload.workspaceId,
        updatedAt: laterTimestamp(conversation.updatedAt, action.payload.at),
      });
    }

    case 'conversation/unbind-workspace': {
      const conversation = state.conversations[action.payload.id];
      if (
        conversation === undefined ||
        conversation.workspaceId === null ||
        !isCanonicalTimestamp(action.payload.at)
      ) {
        return state;
      }
      return withConversation(state, {
        ...conversation,
        workspaceId: null,
        updatedAt: laterTimestamp(conversation.updatedAt, action.payload.at),
      });
    }

    case 'message/append': {
      const { conversationId, message } = action.payload;
      const conversation = state.conversations[conversationId];
      const text = message.text.trim();
      if (
        conversation === undefined ||
        !validIdentifier(message.id) ||
        !isCanonicalTimestamp(message.createdAt) ||
        (message.role !== 'user' && message.role !== 'assistant') ||
        !areValidChatAttachments(message.attachments) ||
        (text.length === 0 &&
          (message.role === 'assistant' || message.attachments.length === 0)) ||
        hasMessageId(conversation, message.id)
      ) {
        return state;
      }

      const normalizedMessage: ChatMessage = {
        ...message,
        text,
        attachments: message.attachments.map(attachment => ({ ...attachment })),
      };
      const autoTitleSource =
        text.length > 0 ? text : message.attachments[0]?.name ?? '';
      const autoTitle =
        message.role === 'user' && shouldAutoTitle(conversation)
          ? deriveAutoTitle(autoTitleSource)
          : conversation.title;
      return withConversation(state, {
        ...conversation,
        title: autoTitle,
        messages: [...conversation.messages, normalizedMessage],
        updatedAt: laterTimestamp(conversation.updatedAt, message.createdAt),
      });
    }
  }
}

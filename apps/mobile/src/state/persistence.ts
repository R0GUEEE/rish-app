import {
  ATTACHMENT_DESCRIPTOR_SCHEMA_VERSION,
  CHAT_STATE_SCHEMA_VERSION,
  LEGACY_CHAT_STATE_SCHEMA_VERSION,
  OLDER_CHAT_STATE_SCHEMA_VERSION,
  PREVIOUS_CHAT_STATE_SCHEMA_VERSION,
  ChatStateValidationError,
  type ChatAttachment,
  type ChatMessage,
  type ChatMessageMetadata,
  type ChatState,
  type Conversation,
  type HydrationResult,
  type PersistedChatAttachmentV1,
  type PersistedChatMessageV4,
  type PersistedChatStateV5,
} from './types';
import {
  DEFAULT_THINKING_MODE,
  MAX_ATTACHMENT_ID_LENGTH,
  MAX_ATTACHMENT_NAME_LENGTH,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TOTAL_ATTACHMENT_SIZE,
  isCanonicalTimestamp,
  isAttachmentMimeType,
  isAttachmentSize,
  isChatAttachmentKind,
  isConversationThinkingMode,
  isModelId,
  isProjectId,
  isWorkspaceId,
  orderConversationIds,
  selectActiveMessages,
} from './reducer';

const MAX_CONVERSATIONS = 10_000;
const MAX_MESSAGES_PER_CONVERSATION = 100_000;
const MAX_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 1_000_000;

type PersistedSchemaVersion =
  | typeof LEGACY_CHAT_STATE_SCHEMA_VERSION
  | typeof OLDER_CHAT_STATE_SCHEMA_VERSION
  | typeof PREVIOUS_CHAT_STATE_SCHEMA_VERSION
  | typeof CHAT_STATE_SCHEMA_VERSION;

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

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    return invalid(path, 'must be an array');
  }
  return value;
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

function parseMetadata(value: unknown, path: string): ChatMessageMetadata {
  const raw = record(value, path);
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

function parseAttachment(value: unknown, path: string): ChatAttachment {
  const raw = record(value, path);
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

function parseAttachments(value: unknown, path: string): ChatAttachment[] {
  const raw = array(value, path);
  if (raw.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return invalid(
      path,
      `must contain no more than ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`,
    );
  }

  const ids = new Set<string>();
  let totalSize = 0;
  return raw.map((entry, index) => {
    const attachment = parseAttachment(entry, `${path}[${index}]`);
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
  const raw = record(value, path);
  const role = raw.role;
  if (role !== 'user' && role !== 'assistant') {
    return invalid(`${path}.role`, 'must be user or assistant');
  }

  const metadata =
    raw.metadata === undefined
      ? undefined
      : parseMetadata(raw.metadata, `${path}.metadata`);
  const attachments =
    schemaVersion === LEGACY_CHAT_STATE_SCHEMA_VERSION ||
    schemaVersion === OLDER_CHAT_STATE_SCHEMA_VERSION
      ? []
      : parseAttachments(raw.attachments, `${path}.attachments`);
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
  const raw = array(value, path);
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

function parseConversation(
  value: unknown,
  path: string,
  schemaVersion: PersistedSchemaVersion,
): Conversation {
  const raw = record(value, path);
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
    schemaVersion === CHAT_STATE_SCHEMA_VERSION ? raw.workspace_id : null;
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

  return {
    id: boundedString(raw.id, `${path}.id`, MAX_ID_LENGTH),
    projectId,
    workspaceId,
    title: boundedString(raw.title, `${path}.title`, MAX_TITLE_LENGTH),
    titleSource: raw.title_source,
    modelId: raw.model_id,
    thinkingMode,
    messages,
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

function toPersistedState(state: ChatState): PersistedChatStateV5 {
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
      title: conversation.title,
      title_source: conversation.titleSource,
      model_id: conversation.modelId,
      thinking_mode: conversation.thinkingMode,
      messages: conversation.messages.map(toPersistedMessage),
      created_at: conversation.createdAt,
      updated_at: conversation.updatedAt,
    };
  });
  return {
    schema_version: CHAT_STATE_SCHEMA_VERSION,
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

  const raw = record(decoded, '$');
  if (
    raw.schema_version !== LEGACY_CHAT_STATE_SCHEMA_VERSION &&
    raw.schema_version !== OLDER_CHAT_STATE_SCHEMA_VERSION &&
    raw.schema_version !== PREVIOUS_CHAT_STATE_SCHEMA_VERSION &&
    raw.schema_version !== CHAT_STATE_SCHEMA_VERSION
  ) {
    return invalid(
      '$.schema_version',
      `must equal ${LEGACY_CHAT_STATE_SCHEMA_VERSION}, ${OLDER_CHAT_STATE_SCHEMA_VERSION}, ${PREVIOUS_CHAT_STATE_SCHEMA_VERSION}, or ${CHAT_STATE_SCHEMA_VERSION}`,
    );
  }
  const schemaVersion = raw.schema_version;
  if (
    raw.active_conversation_id !== null &&
    typeof raw.active_conversation_id !== 'string'
  ) {
    return invalid('$.active_conversation_id', 'must be a string or null');
  }

  const rawConversations = array(raw.conversations, '$.conversations');
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

  const activeConversationId = raw.active_conversation_id;
  if (
    activeConversationId !== null &&
    conversations[activeConversationId] === undefined
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
      : conversations[activeConversationId]?.messages ?? [];
  if (!messagesEqual(projectedMessages, activeMessages)) {
    return invalid(
      '$.messages',
      'must exactly mirror the active conversation messages',
    );
  }

  return {
    schemaVersion: CHAT_STATE_SCHEMA_VERSION,
    conversations,
    conversationOrder: orderConversationIds(conversations),
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
  const persisted = toPersistedState(state);
  hydrateChatState(persisted);
  return JSON.stringify(persisted);
}

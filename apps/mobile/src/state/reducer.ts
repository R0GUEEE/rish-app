import {
  ATTEMPT_PROJECT_CONTEXT_SCHEMA_VERSION,
  ATTEMPT_FAILURE_CODES,
  ATTACHMENT_DESCRIPTOR_SCHEMA_VERSION,
  ATTACHMENT_KINDS,
  CHAT_STATE_SCHEMA_VERSION,
  COMPLETION_FINISH_REASONS,
  COMPLETION_ROUND_RECEIPT_SCHEMA_VERSION,
  CONVERSATION_THINKING_MODES,
  CONVERSATION_TURN_SCHEMA_VERSION,
  SUPPORTED_MODEL_IDS,
  TURN_ATTEMPT_SCHEMA_VERSION,
  type ChatAction,
  type ChatAttachment,
  type ChatAttachmentKind,
  type ChatMessage,
  type ChatState,
  type AttemptFailureCode,
  type Conversation,
  type ConversationThinkingMode,
  type CompletionRoundReceiptV1,
  type ModelId,
  type TurnAttemptV1,
} from './types';
import {
  createProjectContextState,
  isProjectContextSendable,
  projectContextReducer,
} from '../project-context/reducer';

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
export const MAX_COMPLETION_ROUNDS = 8;
export const MAX_ATTEMPT_VISIBLE_MESSAGES = 200;
export const MAX_ATTEMPT_ATTACHMENT_IDS = 24;
export const MAX_PROJECT_CONTEXT_RECEIPT_BYTES = 256 * 1024;

const supportedModels: ReadonlySet<string> = new Set(SUPPORTED_MODEL_IDS);
const thinkingModes: ReadonlySet<string> = new Set(CONVERSATION_THINKING_MODES);
const attachmentKinds: ReadonlySet<string> = new Set(ATTACHMENT_KINDS);
const finishReasons: ReadonlySet<string> = new Set(COMPLETION_FINISH_REASONS);
const attemptFailureCodes: ReadonlySet<string> = new Set(
  ATTEMPT_FAILURE_CODES,
);
const mimeTypePattern = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const opaqueIdPattern = /^[A-Za-z0-9._:-]+$/u;
const attemptBindingKeys = [
  'schemaVersion',
  'runtimeContextId',
  'projectId',
  'snapshotId',
  'snapshotSha256',
  'sourceFingerprint',
  'contextBytes',
  'consentReceiptId',
  'provider',
  'policy',
  'policyVersion',
] as const;
const roundReceiptKeys = [
  'schemaVersion',
  'transportSchemaVersion',
  'turnId',
  'attemptId',
  'roundId',
  'roundIndex',
  'providerRequestId',
  'providerResponseId',
  'requestedModel',
  'model',
  'thinkingMode',
  'finishReason',
  'latencyMs',
  'visibleHistorySha256',
  'modelInputSha256',
  'requestBodySha256',
  'projectContextReceipt',
] as const;
const projectReceiptKeys = [
  'schema_version',
  'snapshot_id',
  'snapshot_sha256',
  'source_fingerprint',
  'context_bytes',
  'verified_at',
] as const;
const activeRoundKeys = ['roundId', 'roundIndex'] as const;

function isExactDataRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== keys.length ||
    names.some(name => !keys.includes(name))
  ) {
    return false;
  }
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined &&
      Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
      descriptor.enumerable === true
    );
  });
}

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

export function isCanonicalLifecycleId(value: unknown): value is string {
  return typeof value === 'string' && canonicalUuidPattern.test(value);
}

export function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && sha256Pattern.test(value);
}

export function isAttemptFailureCode(
  value: unknown,
): value is AttemptFailureCode {
  return typeof value === 'string' && attemptFailureCodes.has(value);
}

function isOpaqueProviderId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    opaqueIdPattern.test(value)
  );
}

function hasSameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function hasLiveAttempt(conversation: Conversation): boolean {
  return conversation.attempts.some(
    attempt => attempt.status === 'prepared' || attempt.status === 'sending',
  );
}

function attemptBindingIsValid(
  conversation: Conversation,
  attempt: TurnAttemptV1,
): boolean {
  const binding = attempt.projectContext;
  if (binding !== null && !isExactDataRecord(binding, attemptBindingKeys)) {
    return false;
  }
  if (attempt.contextDisposition === 'unbound') {
    return (
      conversation.projectId === null &&
      attempt.contextProjectId === null &&
      binding === null
    );
  }
  if (attempt.contextDisposition === 'explicit_without_context') {
    return (
      conversation.projectId !== null &&
      attempt.contextProjectId === conversation.projectId &&
      binding === null
    );
  }
  if (attempt.contextDisposition !== 'verified') {
    return false;
  }
  const context = conversation.projectContext;
  return (
    conversation.projectId !== null &&
    attempt.contextProjectId === conversation.projectId &&
    binding !== null &&
    context !== null &&
    isProjectContextSendable(context) &&
    conversation.runtimeContextId !== null &&
    binding.schemaVersion === ATTEMPT_PROJECT_CONTEXT_SCHEMA_VERSION &&
    binding.runtimeContextId === conversation.runtimeContextId &&
    binding.projectId === conversation.projectId &&
    binding.snapshotId === context.snapshot?.snapshot_id &&
    binding.snapshotSha256 === context.snapshot?.snapshot_sha256 &&
    binding.sourceFingerprint === context.snapshot?.source_fingerprint &&
    binding.contextBytes === context.snapshot?.context_bytes &&
    binding.consentReceiptId === context.consent?.consent_receipt_id &&
    binding.provider === 'deepseek' &&
    binding.policy === 'chat-read-v1' &&
    binding.policyVersion === 'chat-read-v1.0.0' &&
    binding.policyVersion === context.snapshot?.policy_version &&
    isCanonicalLifecycleId(binding.runtimeContextId) &&
    isCanonicalLifecycleId(binding.snapshotId) &&
    isCanonicalLifecycleId(binding.consentReceiptId) &&
    isSha256Digest(binding.snapshotSha256) &&
    isSha256Digest(binding.sourceFingerprint) &&
    Number.isSafeInteger(binding.contextBytes) &&
    binding.contextBytes > 0 &&
    binding.contextBytes <= MAX_PROJECT_CONTEXT_RECEIPT_BYTES
  );
}

function sameAttemptBinding(
  left: TurnAttemptV1['projectContext'],
  right: TurnAttemptV1['projectContext'],
): boolean {
  if (
    (left !== null && !isExactDataRecord(left, attemptBindingKeys)) ||
    (right !== null && !isExactDataRecord(right, attemptBindingKeys))
  ) {
    return false;
  }
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

function copyAttemptBinding(
  binding: TurnAttemptV1['projectContext'],
): TurnAttemptV1['projectContext'] {
  return binding === null
    ? null
    : {
        schemaVersion: binding.schemaVersion,
        runtimeContextId: binding.runtimeContextId,
        projectId: binding.projectId,
        snapshotId: binding.snapshotId,
        snapshotSha256: binding.snapshotSha256,
        sourceFingerprint: binding.sourceFingerprint,
        contextBytes: binding.contextBytes,
        consentReceiptId: binding.consentReceiptId,
        provider: binding.provider,
        policy: binding.policy,
        policyVersion: binding.policyVersion,
      };
}

function copyRoundReceipt(
  receipt: CompletionRoundReceiptV1,
): CompletionRoundReceiptV1 {
  const projectContextReceipt =
    receipt.projectContextReceipt === null
      ? null
      : {
          schema_version: receipt.projectContextReceipt.schema_version,
          snapshot_id: receipt.projectContextReceipt.snapshot_id,
          snapshot_sha256: receipt.projectContextReceipt.snapshot_sha256,
          source_fingerprint:
            receipt.projectContextReceipt.source_fingerprint,
          context_bytes: receipt.projectContextReceipt.context_bytes,
          verified_at: receipt.projectContextReceipt.verified_at,
        };
  return {
    schemaVersion: receipt.schemaVersion,
    transportSchemaVersion: receipt.transportSchemaVersion,
    turnId: receipt.turnId,
    attemptId: receipt.attemptId,
    roundId: receipt.roundId,
    roundIndex: receipt.roundIndex,
    providerRequestId: receipt.providerRequestId,
    providerResponseId: receipt.providerResponseId,
    requestedModel: receipt.requestedModel,
    model: receipt.model,
    thinkingMode: receipt.thinkingMode,
    finishReason: receipt.finishReason,
    latencyMs: receipt.latencyMs,
    visibleHistorySha256: receipt.visibleHistorySha256,
    modelInputSha256: receipt.modelInputSha256,
    requestBodySha256: receipt.requestBodySha256,
    projectContextReceipt,
  };
}

function copyAttempt(attempt: TurnAttemptV1): TurnAttemptV1 {
  return {
    schemaVersion: attempt.schemaVersion,
    attemptId: attempt.attemptId,
    turnId: attempt.turnId,
    status: attempt.status,
    visibleMessageIds: [...attempt.visibleMessageIds],
    visibleHistorySha256: attempt.visibleHistorySha256,
    attachmentIds: [...attempt.attachmentIds],
    modelId: attempt.modelId,
    thinkingMode: attempt.thinkingMode,
    contextDisposition: attempt.contextDisposition,
    contextProjectId: attempt.contextProjectId,
    projectContext: copyAttemptBinding(attempt.projectContext),
    activeRound:
      attempt.activeRound === null
        ? null
        : {
            roundId: attempt.activeRound.roundId,
            roundIndex: attempt.activeRound.roundIndex,
          },
    rounds: attempt.rounds.map(copyRoundReceipt),
    assistantMessageId: attempt.assistantMessageId,
    failureCode: attempt.failureCode,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
  };
}

function retryBindingIsApplicable(
  conversation: Conversation,
  source: TurnAttemptV1,
): boolean {
  const binding = source.projectContext;
  if (source.contextDisposition === 'unbound') {
    return (
      conversation.projectId === null &&
      source.contextProjectId === null &&
      binding === null
    );
  }
  if (source.contextDisposition === 'explicit_without_context') {
    return (
      conversation.projectId === source.contextProjectId &&
      source.contextProjectId !== null &&
      binding === null
    );
  }
  return (
    source.contextDisposition === 'verified' &&
    binding !== null &&
    source.contextProjectId === binding.projectId &&
    conversation.projectId === binding.projectId &&
    conversation.runtimeContextId === binding.runtimeContextId &&
    conversation.projectContext !== null &&
    isProjectContextSendable(conversation.projectContext) &&
    conversation.projectContext.snapshot?.snapshot_id === binding.snapshotId &&
    conversation.projectContext.snapshot?.snapshot_sha256 ===
      binding.snapshotSha256 &&
    conversation.projectContext.snapshot?.source_fingerprint ===
      binding.sourceFingerprint &&
    conversation.projectContext.snapshot?.context_bytes ===
      binding.contextBytes &&
    conversation.projectContext.snapshot?.policy_version ===
      binding.policyVersion &&
    conversation.projectContext.consent?.consent_receipt_id ===
      binding.consentReceiptId
  );
}

function receiptIsValid(
  attempt: TurnAttemptV1,
  receipt: CompletionRoundReceiptV1,
): boolean {
  if (!isExactDataRecord(receipt, roundReceiptKeys)) return false;
  const binding = attempt.projectContext;
  const projectReceipt = receipt.projectContextReceipt;
  if (
    projectReceipt !== null &&
    !isExactDataRecord(projectReceipt, projectReceiptKeys)
  ) {
    return false;
  }
  const contextMatches =
    attempt.contextDisposition !== 'verified'
      ? receipt.transportSchemaVersion === 2 && projectReceipt === null
      : binding !== null &&
        receipt.transportSchemaVersion === 3 &&
        projectReceipt !== null &&
        projectReceipt.schema_version === 1 &&
        projectReceipt.snapshot_id === binding.snapshotId &&
        projectReceipt.snapshot_sha256 === binding.snapshotSha256 &&
        projectReceipt.source_fingerprint === binding.sourceFingerprint &&
        Number.isSafeInteger(projectReceipt.context_bytes) &&
        projectReceipt.context_bytes > 0 &&
        projectReceipt.context_bytes <= MAX_PROJECT_CONTEXT_RECEIPT_BYTES &&
        projectReceipt.context_bytes === binding.contextBytes &&
        isCanonicalTimestamp(projectReceipt.verified_at);
  return (
    receipt.schemaVersion === COMPLETION_ROUND_RECEIPT_SCHEMA_VERSION &&
    receipt.turnId === attempt.turnId &&
    receipt.attemptId === attempt.attemptId &&
    isCanonicalLifecycleId(receipt.roundId) &&
    Number.isSafeInteger(receipt.roundIndex) &&
    receipt.roundIndex >= 0 &&
    receipt.roundIndex < MAX_COMPLETION_ROUNDS &&
    isCanonicalLifecycleId(receipt.providerRequestId) &&
    isOpaqueProviderId(receipt.providerResponseId) &&
    receipt.requestedModel === attempt.modelId &&
    receipt.model === attempt.modelId &&
    receipt.thinkingMode === attempt.thinkingMode &&
    finishReasons.has(receipt.finishReason) &&
    Number.isSafeInteger(receipt.latencyMs) &&
    receipt.latencyMs >= 0 &&
    isSha256Digest(receipt.visibleHistorySha256) &&
    isSha256Digest(receipt.modelInputSha256) &&
    isSha256Digest(receipt.requestBodySha256) &&
    (attempt.visibleHistorySha256 === null ||
      attempt.visibleHistorySha256 === receipt.visibleHistorySha256) &&
    contextMatches
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

function normalizedMessage(
  conversation: Conversation,
  message: ChatMessage,
): ChatMessage | null {
  const text = message.text.trim();
  if (
    !validIdentifier(message.id) ||
    !isCanonicalTimestamp(message.createdAt) ||
    (message.role !== 'user' && message.role !== 'assistant') ||
    !areValidChatAttachments(message.attachments) ||
    (text.length === 0 &&
      (message.role === 'assistant' || message.attachments.length === 0)) ||
    hasMessageId(conversation, message.id)
  ) {
    return null;
  }
  return {
    ...message,
    text,
    attachments: message.attachments.map(attachment => ({ ...attachment })),
  };
}

function hasLifecycleId(state: ChatState, id: string): boolean {
  return Object.values(state.conversations).some(
    conversation =>
      conversation.runtimeContextId === id ||
      conversation.turns.some(turn => turn.turnId === id) ||
      conversation.attempts.some(
        attempt =>
          attempt.attemptId === id ||
          attempt.activeRound?.roundId === id ||
          attempt.rounds.some(round => round.roundId === id),
      ),
  );
}

function hasProviderReceiptId(
  state: ChatState,
  receipt: CompletionRoundReceiptV1,
): boolean {
  return Object.values(state.conversations).some(conversation =>
    conversation.attempts.some(attempt =>
      attempt.rounds.some(
        round =>
          round.providerRequestId === receipt.providerRequestId ||
          round.providerResponseId === receipt.providerResponseId,
      ),
    ),
  );
}

function attemptIndex(
  conversation: Conversation,
  attemptId: string,
): number {
  return conversation.attempts.findIndex(
    attempt => attempt.attemptId === attemptId,
  );
}

function replaceAttempt(
  conversation: Conversation,
  index: number,
  attempt: TurnAttemptV1,
): Conversation {
  const attempts = [...conversation.attempts];
  attempts[index] = attempt;
  return { ...conversation, attempts };
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
        runtimeContextId: null,
        projectContext:
          projectId === null ? null : createProjectContextState(projectId),
        title: suppliedTitle ?? DEFAULT_CONVERSATION_TITLE,
        titleSource: suppliedTitle === null ? 'auto' : 'manual',
        modelId,
        thinkingMode,
        messages: [],
        turns: [],
        attempts: [],
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
      const projectContext =
        conversation.projectContext === null
          ? null
          : projectContextReducer(conversation.projectContext, {
              type: 'model_changed',
              model: action.payload.modelId,
            });
      return withConversation(state, {
        ...conversation,
        modelId: action.payload.modelId,
        projectContext,
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
        hasLiveAttempt(conversation) ||
        conversation.projectId === action.payload.projectId
      ) {
        return state;
      }
      return withConversation(state, {
        ...conversation,
        projectId: action.payload.projectId,
        projectContext: createProjectContextState(action.payload.projectId),
        updatedAt: laterTimestamp(conversation.updatedAt, action.payload.at),
      });
    }

    case 'conversation/unbind-project': {
      const conversation = state.conversations[action.payload.id];
      if (
        conversation === undefined ||
        conversation.projectId === null ||
        hasLiveAttempt(conversation) ||
        !isCanonicalTimestamp(action.payload.at)
      ) {
        return state;
      }
      return withConversation(state, {
        ...conversation,
        projectId: null,
        projectContext: null,
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

    case 'conversation/ensure-runtime-context': {
      const conversation = state.conversations[action.payload.id];
      if (
        conversation === undefined ||
        conversation.projectId === null ||
        conversation.projectContext === null ||
        conversation.runtimeContextId !== null ||
        !isCanonicalLifecycleId(action.payload.runtimeContextId) ||
        !isCanonicalTimestamp(action.payload.at) ||
        hasLifecycleId(state, action.payload.runtimeContextId)
      ) {
        return state;
      }
      return withConversation(state, {
        ...conversation,
        runtimeContextId: action.payload.runtimeContextId,
        updatedAt: laterTimestamp(conversation.updatedAt, action.payload.at),
      });
    }

    case 'project-context/apply': {
      const conversation =
        state.conversations[action.payload.conversationId];
      if (
        conversation === undefined ||
        conversation.projectContext === null ||
        (action.payload.action.type === 'checking' &&
          conversation.runtimeContextId === null) ||
        !isCanonicalTimestamp(action.payload.at)
      ) {
        return state;
      }
      const projectContext = projectContextReducer(
        conversation.projectContext,
        action.payload.action,
      );
      if (projectContext === conversation.projectContext) {
        return state;
      }
      return withConversation(state, {
        ...conversation,
        projectContext,
        updatedAt: laterTimestamp(conversation.updatedAt, action.payload.at),
      });
    }

    case 'message/append': {
      const { conversationId, message } = action.payload;
      const conversation = state.conversations[conversationId];
      if (conversation === undefined) {
        return state;
      }
      const normalized = normalizedMessage(conversation, message);
      if (normalized === null) return state;
      const text = normalized.text;
      const autoTitleSource =
        text.length > 0 ? text : normalized.attachments[0]?.name ?? '';
      const autoTitle =
        normalized.role === 'user' && shouldAutoTitle(conversation)
          ? deriveAutoTitle(autoTitleSource)
          : conversation.title;
      return withConversation(state, {
        ...conversation,
        title: autoTitle,
        messages: [...conversation.messages, normalized],
        updatedAt: laterTimestamp(conversation.updatedAt, normalized.createdAt),
      });
    }

    case 'turn/prepare': {
      const { conversationId, message, turn, attempt } = action.payload;
      const conversation = state.conversations[conversationId];
      if (conversation === undefined) return state;
      const normalized = normalizedMessage(conversation, message);
      if (normalized === null || normalized.role !== 'user') return state;
      const visibleMessageRows = [...conversation.messages, normalized].slice(
        -MAX_ATTEMPT_VISIBLE_MESSAGES,
      );
      const visibleMessages = visibleMessageRows.map(item => item.id);
      const attachmentIds: string[] = [];
      const seenAttachmentIds = new Set<string>();
      let visibleAttachmentCount = 0;
      let visibleAttachmentBytes = 0;
      visibleMessageRows.forEach(visibleMessage => {
        visibleMessage.attachments.forEach(attachment => {
          visibleAttachmentCount += 1;
          visibleAttachmentBytes += attachment.size;
          if (seenAttachmentIds.has(attachment.id)) return;
          seenAttachmentIds.add(attachment.id);
          attachmentIds.push(attachment.id);
        });
      });
      const hasPendingAttempt = conversation.attempts.some(
        item => item.status === 'prepared' || item.status === 'sending',
      );
      if (
        hasPendingAttempt ||
        turn.schemaVersion !== CONVERSATION_TURN_SCHEMA_VERSION ||
        !isCanonicalLifecycleId(turn.turnId) ||
        hasLifecycleId(state, turn.turnId) ||
        turn.userMessageId !== normalized.id ||
        !hasSameStrings(turn.attemptIds, [attempt.attemptId]) ||
        turn.createdAt !== normalized.createdAt ||
        turn.turnId === attempt.attemptId ||
        attempt.schemaVersion !== TURN_ATTEMPT_SCHEMA_VERSION ||
        !isCanonicalLifecycleId(attempt.attemptId) ||
        hasLifecycleId(state, attempt.attemptId) ||
        attempt.turnId !== turn.turnId ||
        attempt.status !== 'prepared' ||
        !hasSameStrings(attempt.visibleMessageIds, visibleMessages) ||
        attempt.visibleHistorySha256 !== null ||
        !hasSameStrings(attempt.attachmentIds, attachmentIds) ||
        visibleAttachmentCount > MAX_ATTEMPT_ATTACHMENT_IDS ||
        visibleAttachmentBytes > MAX_TOTAL_ATTACHMENT_SIZE ||
        attempt.modelId !== conversation.modelId ||
        attempt.thinkingMode !== conversation.thinkingMode ||
        !attemptBindingIsValid(conversation, attempt) ||
        attempt.activeRound !== null ||
        attempt.rounds.length !== 0 ||
        attempt.assistantMessageId !== null ||
        attempt.failureCode !== null ||
        attempt.createdAt !== normalized.createdAt ||
        attempt.updatedAt !== normalized.createdAt
      ) {
        return state;
      }
      const autoTitleSource =
        normalized.text.length > 0
          ? normalized.text
          : normalized.attachments[0]?.name ?? '';
      return withConversation(state, {
        ...conversation,
        title: shouldAutoTitle(conversation)
          ? deriveAutoTitle(autoTitleSource)
          : conversation.title,
        messages: [...conversation.messages, normalized],
        turns: [
          ...conversation.turns,
          {
            schemaVersion: turn.schemaVersion,
            turnId: turn.turnId,
            userMessageId: turn.userMessageId,
            attemptIds: [...turn.attemptIds],
            createdAt: turn.createdAt,
          },
        ],
        attempts: [...conversation.attempts, copyAttempt(attempt)],
        updatedAt: laterTimestamp(conversation.updatedAt, normalized.createdAt),
      });
    }

    case 'attempt/start-round': {
      const conversation =
        state.conversations[action.payload.conversationId];
      if (
        conversation === undefined ||
        !isCanonicalTimestamp(action.payload.at) ||
        !isExactDataRecord(action.payload.round, activeRoundKeys) ||
        !isCanonicalLifecycleId(action.payload.round.roundId) ||
        hasLifecycleId(state, action.payload.round.roundId)
      ) {
        return state;
      }
      const index = attemptIndex(conversation, action.payload.attemptId);
      const attempt = conversation.attempts[index];
      if (
        attempt === undefined ||
        attempt.status !== 'prepared' ||
        attempt.activeRound !== null ||
        attempt.rounds.length >= MAX_COMPLETION_ROUNDS ||
        (attempt.rounds.length > 0 &&
          attempt.rounds[attempt.rounds.length - 1]?.finishReason !==
            'tool_calls') ||
        action.payload.round.roundIndex !== attempt.rounds.length
      ) {
        return state;
      }
      return withConversation(
        state,
        replaceAttempt(conversation, index, {
          ...attempt,
          status: 'sending',
          activeRound: {
            roundId: action.payload.round.roundId,
            roundIndex: action.payload.round.roundIndex,
          },
          updatedAt: laterTimestamp(attempt.updatedAt, action.payload.at),
        }),
      );
    }

    case 'attempt/record-round': {
      const conversation =
        state.conversations[action.payload.conversationId];
      if (
        conversation === undefined ||
        !isCanonicalTimestamp(action.payload.at)
      ) {
        return state;
      }
      const index = attemptIndex(conversation, action.payload.attemptId);
      const attempt = conversation.attempts[index];
      const receipt = action.payload.receipt;
      if (
        attempt === undefined ||
        attempt.status !== 'sending' ||
        attempt.activeRound === null ||
        !receiptIsValid(attempt, receipt) ||
        attempt.activeRound.roundId !== receipt.roundId ||
        attempt.activeRound.roundIndex !== receipt.roundIndex ||
        receipt.roundIndex !== attempt.rounds.length ||
        hasProviderReceiptId(state, receipt)
      ) {
        return state;
      }
      return withConversation(
        state,
        replaceAttempt(conversation, index, {
          ...attempt,
          status: 'prepared',
          visibleHistorySha256: receipt.visibleHistorySha256,
          activeRound: null,
          rounds: [...attempt.rounds, copyRoundReceipt(receipt)],
          updatedAt: laterTimestamp(attempt.updatedAt, action.payload.at),
        }),
      );
    }

    case 'attempt/complete': {
      const conversation =
        state.conversations[action.payload.conversationId];
      if (conversation === undefined) return state;
      const index = attemptIndex(conversation, action.payload.attemptId);
      const attempt = conversation.attempts[index];
      const lastReceipt = attempt?.rounds[attempt.rounds.length - 1];
      const normalized = normalizedMessage(conversation, action.payload.message);
      if (
        attempt === undefined ||
        attempt.status !== 'prepared' ||
        attempt.activeRound !== null ||
        lastReceipt === undefined ||
        lastReceipt.finishReason === 'tool_calls' ||
        normalized === null ||
        normalized.role !== 'assistant' ||
        normalized.metadata?.modelId !== lastReceipt.model ||
        normalized.metadata.latencyMs !== lastReceipt.latencyMs ||
        normalized.metadata.finishReason !== lastReceipt.finishReason
      ) {
        return state;
      }
      const nextConversation = replaceAttempt(conversation, index, {
        ...attempt,
        status: 'completed',
        assistantMessageId: normalized.id,
        failureCode: null,
        updatedAt: laterTimestamp(attempt.updatedAt, normalized.createdAt),
      });
      return withConversation(state, {
        ...nextConversation,
        messages: [...conversation.messages, normalized],
        updatedAt: laterTimestamp(conversation.updatedAt, normalized.createdAt),
      });
    }

    case 'attempt/fail': {
      const conversation =
        state.conversations[action.payload.conversationId];
      if (
        conversation === undefined ||
        !isCanonicalTimestamp(action.payload.at) ||
        !isAttemptFailureCode(action.payload.failureCode)
      ) {
        return state;
      }
      const index = attemptIndex(conversation, action.payload.attemptId);
      const attempt = conversation.attempts[index];
      if (
        attempt === undefined ||
        (attempt.status !== 'prepared' && attempt.status !== 'sending')
      ) {
        return state;
      }
      return withConversation(
        state,
        replaceAttempt(conversation, index, {
          ...attempt,
          status: 'failed',
          activeRound: null,
          failureCode: action.payload.failureCode,
          updatedAt: laterTimestamp(attempt.updatedAt, action.payload.at),
        }),
      );
    }

    case 'attempt/cancel': {
      const conversation =
        state.conversations[action.payload.conversationId];
      if (
        conversation === undefined ||
        !isCanonicalTimestamp(action.payload.at)
      ) {
        return state;
      }
      const index = attemptIndex(conversation, action.payload.attemptId);
      const attempt = conversation.attempts[index];
      if (
        attempt === undefined ||
        (attempt.status !== 'prepared' && attempt.status !== 'sending')
      ) {
        return state;
      }
      return withConversation(
        state,
        replaceAttempt(conversation, index, {
          ...attempt,
          status: 'cancelled',
          activeRound: null,
          failureCode: null,
          updatedAt: laterTimestamp(attempt.updatedAt, action.payload.at),
        }),
      );
    }

    case 'attempt/retry': {
      const conversation =
        state.conversations[action.payload.conversationId];
      if (conversation === undefined) return state;
      const source = conversation.attempts.find(
        item => item.attemptId === action.payload.sourceAttemptId,
      );
      const attempt = action.payload.attempt;
      const turnIndex = conversation.turns.findIndex(
        turn => turn.turnId === source?.turnId,
      );
      const turn = conversation.turns[turnIndex];
      const hasPendingAttempt = conversation.attempts.some(
        item => item.status === 'prepared' || item.status === 'sending',
      );
      const sourceIsCurrentVisibleHistory =
        source !== undefined &&
        hasSameStrings(
          source.visibleMessageIds,
          conversation.messages
            .slice(-MAX_ATTEMPT_VISIBLE_MESSAGES)
            .map(message => message.id),
        );
      if (
        source === undefined ||
        (source.status !== 'failed' && source.status !== 'cancelled') ||
        turn === undefined ||
        hasPendingAttempt ||
        !sourceIsCurrentVisibleHistory ||
        (source !== undefined &&
          !retryBindingIsApplicable(conversation, source)) ||
        attempt.schemaVersion !== TURN_ATTEMPT_SCHEMA_VERSION ||
        !isCanonicalLifecycleId(attempt.attemptId) ||
        hasLifecycleId(state, attempt.attemptId) ||
        attempt.turnId !== source.turnId ||
        attempt.status !== 'prepared' ||
        !hasSameStrings(attempt.visibleMessageIds, source.visibleMessageIds) ||
        attempt.visibleHistorySha256 !== source.visibleHistorySha256 ||
        !hasSameStrings(attempt.attachmentIds, source.attachmentIds) ||
        attempt.modelId !== source.modelId ||
        attempt.thinkingMode !== source.thinkingMode ||
        attempt.contextDisposition !== source.contextDisposition ||
        attempt.contextProjectId !== source.contextProjectId ||
        !sameAttemptBinding(attempt.projectContext, source.projectContext) ||
        attempt.activeRound !== null ||
        attempt.rounds.length !== 0 ||
        attempt.assistantMessageId !== null ||
        attempt.failureCode !== null ||
        !isCanonicalTimestamp(attempt.createdAt) ||
        attempt.updatedAt !== attempt.createdAt
      ) {
        return state;
      }
      const attempts = [...conversation.attempts, copyAttempt(attempt)];
      const turns = [...conversation.turns];
      turns[turnIndex] = {
        ...turn,
        attemptIds: [...turn.attemptIds, attempt.attemptId],
      };
      return withConversation(state, {
        ...conversation,
        turns,
        attempts,
        updatedAt: laterTimestamp(conversation.updatedAt, attempt.createdAt),
      });
    }
  }
}

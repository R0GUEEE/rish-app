import { chatReducer, createEmptyChatState } from './reducer';
import { hydrateChatState, serializeChatState } from './persistence';
import type {
  ChatAction,
  ChatAttachment,
  ChatMessageMetadata,
  ChatState,
  ConversationThinkingMode,
  ModelId,
} from './types';

export type ChatStoreIdKind = 'conversation' | 'message';
export type ChatStoreListener = (state: ChatState) => void;

export type ChatStoreOptions = {
  readonly initialState?: ChatState;
  readonly now?: () => Date | number | string;
  readonly createId?: (kind: ChatStoreIdKind) => string;
};

export type CreateConversationOptions = {
  readonly modelId?: ModelId;
  readonly thinkingMode?: ConversationThinkingMode;
  readonly projectId?: string | null;
  readonly title?: string;
  readonly select?: boolean;
};

export type AppendMessageOptions = {
  readonly metadata?: ChatMessageMetadata;
  readonly attachments?: readonly ChatAttachment[];
};

export type ChatStore = {
  getState(): ChatState;
  dispatch(action: ChatAction): ChatState;
  subscribe(listener: ChatStoreListener): () => void;
  createConversation(options?: CreateConversationOptions): string;
  renameConversation(id: string, title: string): void;
  autoTitleConversation(id: string, sourceText: string): void;
  selectConversation(id: string | null): void;
  appendUserMessage(
    conversationId: string,
    text: string,
    options?: AppendMessageOptions,
  ): string;
  appendAssistantMessage(
    conversationId: string,
    text: string,
    options?: AppendMessageOptions,
  ): string;
  deleteConversation(id: string): void;
  setModel(id: string, modelId: ModelId): void;
  setThinkingMode(id: string, thinkingMode: ConversationThinkingMode): void;
  bindConversationToProject(id: string, projectId: string): void;
  unbindConversationFromProject(id: string): void;
  serialize(): string;
  hydrate(input: unknown): ChatState;
};

let defaultIdCounter = 0;

function defaultCreateId(kind: ChatStoreIdKind): string {
  defaultIdCounter += 1;
  const entropy = Math.floor(Math.random() * 0x1_0000_0000)
    .toString(36)
    .padStart(7, '0');
  return `${kind}-${Date.now().toString(36)}-${defaultIdCounter.toString(
    36,
  )}-${entropy}`;
}

function canonicalNow(now: () => Date | number | string): string {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('ChatStore now() returned an invalid timestamp');
  }
  return date.toISOString();
}

export function createChatStore(options: ChatStoreOptions = {}): ChatStore {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? defaultCreateId;
  let state = options.initialState ?? createEmptyChatState();
  const listeners = new Set<ChatStoreListener>();

  const dispatch = (action: ChatAction): ChatState => {
    const next = chatReducer(state, action);
    if (next !== state) {
      state = next;
      listeners.forEach(listener => listener(state));
    }
    return state;
  };

  const appendMessage = (
    role: 'user' | 'assistant',
    conversationId: string,
    text: string,
    appendOptions: AppendMessageOptions = {},
  ): string => {
    const id = createId('message');
    dispatch({
      type: 'message/append',
      payload: {
        conversationId,
        message: {
          id,
          role,
          text,
          createdAt: canonicalNow(now),
          attachments: appendOptions.attachments ?? [],
          ...(appendOptions.metadata === undefined
            ? {}
            : { metadata: appendOptions.metadata }),
        },
      },
    });
    return id;
  };

  return {
    getState: () => state,
    dispatch,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    createConversation: (createOptions = {}) => {
      const id = createId('conversation');
      dispatch({
        type: 'conversation/create',
        payload: {
          id,
          at: canonicalNow(now),
          ...createOptions,
        },
      });
      return id;
    },
    renameConversation: (id, title) => {
      dispatch({
        type: 'conversation/rename',
        payload: { id, title, at: canonicalNow(now) },
      });
    },
    autoTitleConversation: (id, sourceText) => {
      dispatch({
        type: 'conversation/auto-title',
        payload: { id, text: sourceText, at: canonicalNow(now) },
      });
    },
    selectConversation: id => {
      dispatch({ type: 'conversation/select', payload: { id } });
    },
    appendUserMessage: (conversationId, text, appendOptions) =>
      appendMessage('user', conversationId, text, appendOptions),
    appendAssistantMessage: (conversationId, text, appendOptions) =>
      appendMessage('assistant', conversationId, text, appendOptions),
    deleteConversation: id => {
      dispatch({ type: 'conversation/delete', payload: { id } });
    },
    setModel: (id, modelId) => {
      dispatch({
        type: 'conversation/set-model',
        payload: { id, modelId, at: canonicalNow(now) },
      });
    },
    setThinkingMode: (id, thinkingMode) => {
      dispatch({
        type: 'conversation/set-thinking',
        payload: { id, thinkingMode, at: canonicalNow(now) },
      });
    },
    bindConversationToProject: (id, projectId) => {
      dispatch({
        type: 'conversation/bind-project',
        payload: { id, projectId, at: canonicalNow(now) },
      });
    },
    unbindConversationFromProject: id => {
      dispatch({
        type: 'conversation/unbind-project',
        payload: { id, at: canonicalNow(now) },
      });
    },
    serialize: () => serializeChatState(state),
    hydrate: input => {
      const next = hydrateChatState(input);
      if (next !== state) {
        state = next;
        listeners.forEach(listener => listener(state));
      }
      return state;
    },
  };
}

import {
  CHAT_STATE_SCHEMA_VERSION,
  ChatStateValidationError,
  chatReducer,
  createChatStore,
  createEmptyChatState,
  deriveAutoTitle,
  hydrateChatState,
  safeHydrateChatState,
  selectActiveConversation,
  selectActiveMessages,
  selectProjectContextSnapshotReferences,
  selectOrderedConversations,
  serializeChatState,
  MAX_PROJECT_CONTEXT_SNAPSHOT_REFERENCE_ROWS,
  MAX_CHAT_MESSAGE_LENGTH,
  type ChatAttachment,
  type ChatStore,
  type CompletionRoundReceiptV1,
  type ChatState,
  type PersistedChatStateV7,
  type ProjectContextMutationScope,
  type ScopedProjectContextTransaction,
} from '../src/state';
import type {
  ProjectContextConsentV1,
  ProjectContextManifestV1,
} from '../src/project-context';

const T0 = '2026-08-24T01:00:00.000Z';
const T1 = '2026-08-24T01:01:00.000Z';
const T2 = '2026-08-24T01:02:00.000Z';
const T3 = '2026-08-24T01:03:00.000Z';

const IMAGE_ATTACHMENT: ChatAttachment = {
  schema_version: 1,
  id: 'attachment-image-1',
  kind: 'image',
  name: 'receipt.png',
  mime_type: 'image/png',
  size: 2048,
  thumbnail_data_url: 'data:image/png;base64,cHJldmlldw==',
};

function projectContextScope(
  store: ChatStore,
  conversationId: string,
): ProjectContextMutationScope {
  const conversation = store.getState().conversations[conversationId];
  if (
    conversation === undefined ||
    conversation.projectId === null ||
    conversation.runtimeContextId === null ||
    conversation.projectContext === null
  ) {
    throw new Error('test fixture requires a bound runtime project context');
  }
  return {
    conversationId,
    projectId: conversation.projectId,
    runtimeContextId: conversation.runtimeContextId,
    modelId: conversation.modelId,
    expectedContext: conversation.projectContext,
  };
}

function createConversation(
  state: ChatState,
  id: string,
  at: string,
  select = true,
): ChatState {
  return chatReducer(state, {
    type: 'conversation/create',
    payload: { id, at, select },
  });
}

function appendUser(
  state: ChatState,
  conversationId: string,
  id: string,
  text: string,
  createdAt: string,
  attachments: readonly ChatAttachment[] = [],
): ChatState {
  return chatReducer(state, {
    type: 'message/append',
    payload: {
      conversationId,
      message: { id, role: 'user', text, createdAt, attachments },
    },
  });
}

describe('chat reducer', () => {
  test('creates, selects, and deterministically orders conversations', () => {
    let state = createEmptyChatState();
    state = createConversation(state, 'zeta', T0, false);
    state = createConversation(state, 'alpha', T0, false);
    state = createConversation(state, 'recent', T1);

    expect(state.schemaVersion).toBe(CHAT_STATE_SCHEMA_VERSION);
    expect(state.conversationOrder).toEqual(['recent', 'alpha', 'zeta']);
    expect(state.selectedConversationId).toBe('recent');
    expect(selectOrderedConversations(state).map(item => item.id)).toEqual([
      'recent',
      'alpha',
      'zeta',
    ]);

    const selected = chatReducer(state, {
      type: 'conversation/select',
      payload: { id: 'alpha' },
    });
    expect(selected.selectedConversationId).toBe('alpha');
    expect(selected.conversationOrder).toEqual(state.conversationOrder);
    expect(
      chatReducer(selected, {
        type: 'conversation/select',
        payload: { id: 'missing' },
      }),
    ).toBe(selected);
  });

  test('auto-titles from the first user message and keeps manual titles', () => {
    let state = createConversation(createEmptyChatState(), 'chat', T0);
    state = appendUser(
      state,
      'chat',
      'u1',
      '  #   Plan   a local mobile DSH   ',
      T1,
    );
    expect(state.conversations.chat?.title).toBe('Plan a local mobile DSH');
    expect(state.conversations.chat?.titleSource).toBe('auto');

    state = chatReducer(state, {
      type: 'conversation/rename',
      payload: { id: 'chat', title: '  Mobile   proof  ', at: T2 },
    });
    state = appendUser(
      state,
      'chat',
      'u2',
      'This must not replace the title',
      T3,
    );
    expect(state.conversations.chat?.title).toBe('Mobile proof');
    expect(state.conversations.chat?.titleSource).toBe('manual');
  });

  test('derives Unicode-safe bounded automatic titles', () => {
    const source = Array.from({ length: 60 }, () => '深').join('');
    const title = deriveAutoTitle(source);
    expect(Array.from(title)).toHaveLength(48);
    expect(title.endsWith('…')).toBe(true);
    expect(deriveAutoTitle('  \n\t ')).toBe('New chat');
  });

  test('appends both roles, preserves metadata, and ignores duplicate ids', () => {
    let state = createConversation(createEmptyChatState(), 'chat', T0);
    state = appendUser(state, 'chat', 'm1', 'Hello', T1);
    const withAssistant = chatReducer(state, {
      type: 'message/append',
      payload: {
        conversationId: 'chat',
        message: {
          id: 'm2',
          role: 'assistant',
          text: 'Hi from the device',
          createdAt: T2,
          attachments: [],
          metadata: {
            modelId: 'deepseek-v4-pro',
            latencyMs: 412,
            finishReason: 'stop',
          },
        },
      },
    });
    expect(selectActiveMessages(withAssistant)).toHaveLength(2);
    expect(selectActiveMessages(withAssistant)[1]?.metadata).toEqual({
      modelId: 'deepseek-v4-pro',
      latencyMs: 412,
      finishReason: 'stop',
    });

    const duplicate = chatReducer(withAssistant, {
      type: 'message/append',
      payload: {
        conversationId: 'chat',
        message: {
          id: 'm2',
          role: 'assistant',
          text: 'duplicate',
          createdAt: T3,
          attachments: [],
        },
      },
    });
    expect(duplicate).toBe(withAssistant);
  });

  test('preserves legal message whitespace through serialization without accepting blanks', () => {
    let state = createConversation(createEmptyChatState(), 'chat', T0);
    state = appendUser(state, 'chat', 'm1', '  raw user text  ', T1);
    state = chatReducer(state, {
      type: 'message/append',
      payload: {
        conversationId: 'chat',
        message: {
          id: 'm2',
          role: 'assistant',
          text: '\nraw assistant text\t',
          createdAt: T2,
          attachments: [],
        },
      },
    });

    expect(state.conversations.chat?.messages.map(message => message.text)).toEqual([
      '  raw user text  ',
      '\nraw assistant text\t',
    ]);
    expect(state.conversations.chat?.title).toBe('raw user text');
    expect(
      hydrateChatState(serializeChatState(state)).conversations.chat?.messages.map(
        message => message.text,
      ),
    ).toEqual(['  raw user text  ', '\nraw assistant text\t']);

    const blankUser = appendUser(state, 'chat', 'm3', ' \n\t ', T3);
    const blankAssistant = chatReducer(state, {
      type: 'message/append',
      payload: {
        conversationId: 'chat',
        message: {
          id: 'm4',
          role: 'assistant',
          text: '\t  ',
          createdAt: T3,
          attachments: [],
        },
      },
    });
    expect(blankUser).toBe(state);
    expect(blankAssistant).toBe(state);
  });

  test('accepts an attachment-only user message and titles it from the file', () => {
    const state = createConversation(createEmptyChatState(), 'chat', T0);
    const next = appendUser(state, 'chat', 'm1', '', T1, [IMAGE_ATTACHMENT]);
    expect(next.conversations.chat?.messages[0]).toMatchObject({
      text: '',
      attachments: [IMAGE_ATTACHMENT],
    });
    expect(next.conversations.chat?.title).toBe('receipt.png');

    const blankAssistant = chatReducer(next, {
      type: 'message/append',
      payload: {
        conversationId: 'chat',
        message: {
          id: 'm2',
          role: 'assistant',
          text: '',
          createdAt: T2,
          attachments: [IMAGE_ATTACHMENT],
        },
      },
    });
    expect(blankAssistant).toBe(next);
  });

  test('titles a whitespace-only attachment message from the attachment name', () => {
    const state = createConversation(createEmptyChatState(), 'chat', T0);
    const next = appendUser(
      state,
      'chat',
      'm1',
      ' \n\t ',
      T1,
      [IMAGE_ATTACHMENT],
    );

    expect(next.conversations.chat?.messages[0]?.text).toBe(' \n\t ');
    expect(next.conversations.chat?.title).toBe('receipt.png');
  });

  test('bounds the preserved raw message length before serialization', () => {
    const state = createConversation(createEmptyChatState(), 'chat', T0);
    const boundary = `x${' '.repeat(MAX_CHAT_MESSAGE_LENGTH - 1)}`;
    const accepted = appendUser(state, 'chat', 'm1', boundary, T1);
    expect(accepted).not.toBe(state);
    expect(
      hydrateChatState(serializeChatState(accepted)).conversations.chat
        ?.messages[0]?.text,
    ).toBe(boundary);

    const overLimit = `${boundary} `;
    expect(appendUser(state, 'chat', 'm2', overLimit, T1)).toBe(state);
  });

  test('updates model and thinking per chat without moving on selection', () => {
    let state = createConversation(createEmptyChatState(), 'first', T0);
    state = createConversation(state, 'second', T1);
    state = chatReducer(state, {
      type: 'conversation/set-model',
      payload: { id: 'first', modelId: 'deepseek-v4-pro', at: T2 },
    });
    expect(state.conversations.first?.modelId).toBe('deepseek-v4-pro');
    expect(state.conversationOrder).toEqual(['first', 'second']);

    state = chatReducer(state, {
      type: 'conversation/set-thinking',
      payload: { id: 'first', thinkingMode: 'max', at: T3 },
    });
    expect(state.conversations.first?.thinkingMode).toBe('max');

    state = chatReducer(state, {
      type: 'conversation/select',
      payload: { id: 'second' },
    });
    expect(state.conversationOrder).toEqual(['first', 'second']);
    expect(selectActiveConversation(state)?.id).toBe('second');
  });

  test('creates, binds, and unbinds a conversation project', () => {
    let state = chatReducer(createEmptyChatState(), {
      type: 'conversation/create',
      payload: { id: 'chat', at: T0, projectId: 'project-a' },
    });
    expect(state.conversations.chat?.projectId).toBe('project-a');

    state = chatReducer(state, {
      type: 'conversation/bind-project',
      payload: { id: 'chat', projectId: 'project-b', at: T1 },
    });
    expect(state.conversations.chat?.projectId).toBe('project-b');
    expect(state.conversations.chat?.updatedAt).toBe(T1);

    state = chatReducer(state, {
      type: 'conversation/unbind-project',
      payload: { id: 'chat', at: T2 },
    });
    expect(state.conversations.chat?.projectId).toBeNull();
    expect(state.conversations.chat?.updatedAt).toBe(T2);

    const invalid = chatReducer(state, {
      type: 'conversation/bind-project',
      payload: { id: 'chat', projectId: '   ', at: T3 },
    });
    expect(invalid).toBe(state);
  });

  test('deletes conversations and selects the next most recent one', () => {
    let state = createConversation(createEmptyChatState(), 'oldest', T0);
    state = createConversation(state, 'middle', T1);
    state = createConversation(state, 'newest', T2);
    state = chatReducer(state, {
      type: 'conversation/delete',
      payload: { id: 'newest' },
    });
    expect(state.selectedConversationId).toBe('middle');
    expect(state.conversationOrder).toEqual(['middle', 'oldest']);

    state = chatReducer(state, {
      type: 'conversation/delete',
      payload: { id: 'oldest' },
    });
    expect(state.selectedConversationId).toBe('middle');
  });

  test('rejects malformed reducer inputs without changing state', () => {
    const state = createConversation(createEmptyChatState(), 'chat', T0);
    const invalidTimestamp = chatReducer(state, {
      type: 'conversation/rename',
      payload: { id: 'chat', title: 'Name', at: 'yesterday' },
    });
    const blankMessage = appendUser(state, 'chat', 'm1', '   ', T1);
    const duplicateConversation = createConversation(state, 'chat', T2);
    expect(invalidTimestamp).toBe(state);
    expect(blankMessage).toBe(state);
    expect(duplicateConversation).toBe(state);
  });
});

describe('schema v4 persistence', () => {
  function populatedState(): ChatState {
    let state = createConversation(createEmptyChatState(), 'chat-a', T0);
    state = chatReducer(state, {
      type: 'conversation/bind-project',
      payload: { id: 'chat-a', projectId: 'project-a', at: T0 },
    });
    state = appendUser(state, 'chat-a', 'u1', 'Local?', T1);
    state = chatReducer(state, {
      type: 'message/append',
      payload: {
        conversationId: 'chat-a',
        message: {
          id: 'a1',
          role: 'assistant',
          text: 'Local.',
          createdAt: T2,
          attachments: [],
          metadata: { modelId: 'deepseek-v4-flash', latencyMs: 585 },
        },
      },
    });
    state = createConversation(state, 'chat-b', T3);
    state = chatReducer(state, {
      type: 'conversation/select',
      payload: { id: 'chat-a' },
    });
    return state;
  }

  test('serializes deterministically with an active-message proof projection', () => {
    const state = populatedState();
    const first = serializeChatState(state);
    const second = serializeChatState(state);
    const decoded = JSON.parse(first) as PersistedChatStateV7;

    expect(first).toBe(second);
    expect(Object.keys(decoded).sort()).toEqual(
      [
        'schema_version',
        'project_context_destructive_epoch',
        'project_context_destructive_transition',
        'active_conversation_id',
        'conversations',
        'messages',
      ].sort(),
    );
    expect(decoded.project_context_destructive_epoch).toBe(0);
    expect(decoded.project_context_destructive_transition).toBeNull();
    expect(decoded.schema_version).toBe(CHAT_STATE_SCHEMA_VERSION);
    expect(decoded.active_conversation_id).toBe('chat-a');
    expect(decoded.conversations.map(item => item.id)).toEqual([
      'chat-b',
      'chat-a',
    ]);
    expect(decoded.messages).toEqual(decoded.conversations[1]?.messages);
    expect(decoded.messages).toHaveLength(2);
    expect(decoded.conversations[1]?.project_id).toBe('project-a');
    expect(decoded.conversations[0]?.project_id).toBeNull();
  });

  test('round-trips every supported field', () => {
    const state = populatedState();
    const hydrated = hydrateChatState(serializeChatState(state));
    expect(hydrated).toEqual(state);
    expect(serializeChatState(hydrated)).toBe(serializeChatState(state));
  });

  test('round-trips attachment descriptors without persisting thumbnails', () => {
    let state = createConversation(createEmptyChatState(), 'chat', T0);
    state = appendUser(state, 'chat', 'u1', '', T1, [IMAGE_ATTACHMENT]);
    const serialized = serializeChatState(state);
    expect(serialized).not.toContain('thumbnail_data_url');
    expect(serialized).not.toContain('cHJldmlldw');

    const hydrated = hydrateChatState(serialized);
    expect(hydrated.conversations.chat?.messages[0]?.attachments).toEqual([
      {
        schema_version: 1,
        id: 'attachment-image-1',
        kind: 'image',
        name: 'receipt.png',
        mime_type: 'image/png',
        size: 2048,
      },
    ]);
    expect(serializeChatState(hydrated)).toBe(serialized);
  });

  test('deterministically migrates schema v2 conversations as unbound', () => {
    const legacy = JSON.parse(serializeChatState(populatedState())) as {
      schema_version: number;
      conversations: Array<Record<string, unknown>>;
    };
    legacy.schema_version = 2;
    legacy.conversations.forEach(conversation => {
      delete conversation.project_id;
      delete conversation.thinking_mode;
    });

    const first = hydrateChatState(legacy);
    const second = hydrateChatState(JSON.stringify(legacy));
    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(CHAT_STATE_SCHEMA_VERSION);
    expect(first).toMatchObject({
      projectContextDestructiveEpoch: 0,
      projectContextDestructiveTransition: null,
    });
    expect(
      Object.values(first.conversations).every(
        conversation =>
          conversation.projectId === null &&
          conversation.thinkingMode === 'high',
      ),
    ).toBe(true);

    const migrated = JSON.parse(serializeChatState(first)) as {
      schema_version: number;
      conversations: Array<{ project_id?: unknown }>;
    };
    expect(migrated.schema_version).toBe(CHAT_STATE_SCHEMA_VERSION);
    expect(
      migrated.conversations.every(
        conversation => conversation.project_id === null,
      ),
    ).toBe(true);
  });

  test('deterministically migrates schema v3 messages with empty attachments', () => {
    const legacy = JSON.parse(serializeChatState(populatedState())) as {
      schema_version: number;
      messages: Array<Record<string, unknown>>;
      conversations: Array<{ messages: Array<Record<string, unknown>> }>;
    };
    legacy.schema_version = 3;
    legacy.messages.forEach(message => delete message.attachments);
    legacy.conversations.forEach(conversation =>
      conversation.messages.forEach(message => delete message.attachments),
    );

    const hydrated = hydrateChatState(legacy);
    expect(hydrated.schemaVersion).toBe(CHAT_STATE_SCHEMA_VERSION);
    expect(hydrated).toMatchObject({
      projectContextDestructiveEpoch: 0,
      projectContextDestructiveTransition: null,
    });
    expect(
      Object.values(hydrated.conversations).every(conversation =>
        conversation.messages.every(
          message => message.attachments.length === 0,
        ),
      ),
    ).toBe(true);
  });

  test('strictly validates the required v3 project_id field', () => {
    const missing = JSON.parse(serializeChatState(populatedState())) as {
      conversations: Array<Record<string, unknown>>;
    };
    delete missing.conversations[0]?.project_id;
    expect(() => hydrateChatState(missing)).toThrow(/project_id/);

    for (const invalidProjectId of ['', '   ', 'x'.repeat(257), 42]) {
      const invalid = JSON.parse(serializeChatState(populatedState())) as {
        conversations: Array<Record<string, unknown>>;
      };
      invalid.conversations[0]!.project_id = invalidProjectId;
      expect(() => hydrateChatState(invalid)).toThrow(/project_id/);
    }
  });

  test('hydrates old conversations without thinking_mode as high', () => {
    const decoded = JSON.parse(serializeChatState(populatedState())) as {
      schema_version: number;
      conversations: Array<{ thinking_mode?: string }>;
    };
    decoded.schema_version = 5;
    delete decoded.conversations[0]?.thinking_mode;
    delete decoded.conversations[1]?.thinking_mode;

    const hydrated = hydrateChatState(decoded);
    expect(
      Object.values(hydrated.conversations).every(
        conversation => conversation.thinkingMode === 'high',
      ),
    ).toBe(true);
  });

  test('persists Flash Vision Exp and rejects invalid thinking modes', () => {
    let state = createEmptyChatState();
    state = chatReducer(state, {
      type: 'conversation/create',
      payload: {
        id: 'vision',
        at: T0,
        modelId: 'deepseek-v4-flash-vision-exp',
        thinkingMode: 'off',
      },
    });
    const decoded = JSON.parse(serializeChatState(state)) as {
      conversations: Array<Record<string, unknown>>;
    };
    expect(decoded.conversations[0]?.model_id).toBe(
      'deepseek-v4-flash-vision-exp',
    );
    expect(decoded.conversations[0]?.thinking_mode).toBe('off');

    decoded.conversations[0]!.thinking_mode = 'medium';
    expect(() => hydrateChatState(decoded)).toThrow(/supported thinking mode/);
  });

  test('normalizes persisted conversation order using timestamps and ids', () => {
    const decoded = JSON.parse(
      serializeChatState(populatedState()),
    ) as unknown as {
      conversations: unknown[];
    };
    decoded.conversations.reverse();
    const hydrated = hydrateChatState(decoded);
    expect(hydrated.conversationOrder).toEqual(['chat-b', 'chat-a']);
  });

  test.each([
    ['invalid JSON', '{'],
    [
      'wrong schema',
      {
        schema_version: 1,
        active_conversation_id: null,
        conversations: [],
        messages: [],
      },
    ],
    [
      'missing projection',
      { schema_version: 4, active_conversation_id: null, conversations: [] },
    ],
    [
      'orphaned active id',
      {
        schema_version: 4,
        active_conversation_id: 'missing',
        conversations: [],
        messages: [],
      },
    ],
  ])('rejects %s', (_label, payload) => {
    expect(() => hydrateChatState(payload)).toThrow(ChatStateValidationError);
  });

  test('rejects duplicate conversations and unsupported models', () => {
    const valid = JSON.parse(serializeChatState(populatedState())) as {
      conversations: Record<string, unknown>[];
    };
    valid.conversations.push({ ...valid.conversations[0] });
    expect(() => hydrateChatState(valid)).toThrow(/must be unique/);

    const unsupported = JSON.parse(serializeChatState(populatedState())) as {
      conversations: Record<string, unknown>[];
    };
    unsupported.conversations[0]!.model_id = 'unknown-model';
    expect(() => hydrateChatState(unsupported)).toThrow(/supported model/);
  });

  test('rejects a stale or tampered active-message projection', () => {
    const decoded = JSON.parse(serializeChatState(populatedState())) as {
      messages: Array<{ text: string }>;
    };
    decoded.messages[0]!.text = 'tampered';
    expect(() => hydrateChatState(decoded)).toThrow(
      /must exactly mirror the active conversation/,
    );
  });

  test('rejects tampered attachment projections and invalid descriptors', () => {
    let state = createConversation(createEmptyChatState(), 'chat', T0);
    state = appendUser(state, 'chat', 'u1', '', T1, [IMAGE_ATTACHMENT]);

    const tampered = JSON.parse(serializeChatState(state)) as {
      messages: Array<{ attachments: Array<{ name: string }> }>;
    };
    tampered.messages[0]!.attachments[0]!.name = 'tampered.png';
    expect(() => hydrateChatState(tampered)).toThrow(
      /must exactly mirror the active conversation/,
    );

    for (const [field, value] of [
      ['id', ''],
      ['name', '   '],
      ['mime_type', 'not-a-mime'],
      ['size', -1],
      ['kind', 'audio'],
    ] as const) {
      const invalid = JSON.parse(serializeChatState(state)) as {
        conversations: Array<{
          messages: Array<{ attachments: Array<Record<string, unknown>> }>;
        }>;
      };
      invalid.conversations[0]!.messages[0]!.attachments[0]![field] = value;
      expect(() => hydrateChatState(invalid)).toThrow(
        new RegExp(String(field)),
      );
    }

    const duplicate = JSON.parse(serializeChatState(state)) as {
      conversations: Array<{
        messages: Array<{ attachments: Array<Record<string, unknown>> }>;
      }>;
    };
    const attachments = duplicate.conversations[0]!.messages[0]!.attachments;
    attachments.push({ ...attachments[0]! });
    expect(() => hydrateChatState(duplicate)).toThrow(
      /unique within the message/,
    );
  });

  test('returns typed validation failures without throwing', () => {
    const result = safeHydrateChatState('{bad json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ChatStateValidationError);
      expect(result.error.path).toBe('$');
    }
  });
});

describe('framework-neutral chat store', () => {
  test('provides deterministic high-level operations and subscriptions', () => {
    const times = [T0, T1, T2, T3];
    const ids = ['conversation-1', 'message-1', 'message-2'];
    const listener = jest.fn();
    const store = createChatStore({
      now: () => times.shift() ?? T3,
      createId: () => ids.shift() ?? 'fallback',
    });
    const unsubscribe = store.subscribe(listener);

    const conversationId = store.createConversation();
    expect(conversationId).toBe('conversation-1');
    expect(
      store.appendUserMessage(conversationId, '', {
        attachments: [IMAGE_ATTACHMENT],
      }),
    ).toBe('message-1');
    expect(
      store.appendAssistantMessage(conversationId, 'Running locally', {
        metadata: { modelId: 'deepseek-v4-flash', latencyMs: 120 },
      }),
    ).toBe('message-2');
    store.setModel(conversationId, 'deepseek-v4-pro');
    store.setThinkingMode(conversationId, 'max');

    expect(listener).toHaveBeenCalledTimes(5);
    expect(selectActiveConversation(store.getState())?.modelId).toBe(
      'deepseek-v4-pro',
    );
    expect(selectActiveConversation(store.getState())?.thinkingMode).toBe(
      'max',
    );
    expect(selectActiveMessages(store.getState())).toHaveLength(2);

    const serialized = store.serialize();
    unsubscribe();
    store.deleteConversation(conversationId);
    expect(listener).toHaveBeenCalledTimes(5);
    store.hydrate(serialized);
    expect(selectActiveMessages(store.getState())).toHaveLength(2);
  });

  test('exposes project binding operations', () => {
    const times = [T0, T1, T2];
    const store = createChatStore({
      now: () => times.shift() ?? T2,
      createId: () => 'conversation-project',
    });

    const conversationId = store.createConversation({
      projectId: 'project-a',
    });
    expect(selectActiveConversation(store.getState())?.projectId).toBe(
      'project-a',
    );

    store.bindConversationToProject(conversationId, 'project-b');
    expect(selectActiveConversation(store.getState())?.projectId).toBe(
      'project-b',
    );

    store.unbindConversationFromProject(conversationId);
    expect(selectActiveConversation(store.getState())?.projectId).toBeNull();
  });

  test('exposes workspace binding operations', () => {
    const times = [T0, T1, T2];
    const store = createChatStore({
      now: () => times.shift() ?? T2,
      createId: () => 'conversation-workspace',
    });

    const conversationId = store.createConversation({
      workspaceId: 'ws-alpha',
    });
    expect(selectActiveConversation(store.getState())?.workspaceId).toBe(
      'ws-alpha',
    );

    store.bindConversationToWorkspace(conversationId, 'ws-beta');
    expect(selectActiveConversation(store.getState())?.workspaceId).toBe(
      'ws-beta',
    );

    store.unbindConversationFromWorkspace(conversationId);
    expect(
      selectActiveConversation(store.getState())?.workspaceId,
    ).toBeNull();
  });
});

describe('workspace binding persistence', () => {
  function workspaceBoundState(): ChatState {
    let state = createConversation(createEmptyChatState(), 'chat-a', T0, false);
    state = chatReducer(state, {
      type: 'conversation/create',
      payload: { id: 'chat-b', at: T1, select: false, workspaceId: 'ws-beta' },
    });
    state = chatReducer(state, {
      type: 'conversation/bind-workspace',
      payload: { id: 'chat-a', workspaceId: 'ws-alpha', at: T0 },
    });
    state = appendUser(state, 'chat-a', 'u1', 'Work in this folder?', T2);
    state = chatReducer(state, {
      type: 'conversation/select',
      payload: { id: 'chat-a' },
    });
    return state;
  }

  test('binds workspaces per conversation and rejects invalid ids', () => {
    const state = workspaceBoundState();
    expect(state.conversations['chat-a']?.workspaceId).toBe('ws-alpha');
    expect(state.conversations['chat-b']?.workspaceId).toBe('ws-beta');

    for (const invalidWorkspaceId of ['', '   ', 'x'.repeat(257), 42]) {
      const rejected = chatReducer(state, {
        type: 'conversation/bind-workspace',
        payload: {
          id: 'chat-a',
          // Intentionally invalid input; the reducer must not adopt it.
          workspaceId: invalidWorkspaceId as unknown as string,
          at: T3,
        },
      });
      expect(rejected).toBe(state);
    }

    const rebound = chatReducer(state, {
      type: 'conversation/unbind-workspace',
      payload: { id: 'chat-a', at: T3 },
    });
    expect(rebound.conversations['chat-a']?.workspaceId).toBeNull();
    expect(rebound.conversations['chat-b']?.workspaceId).toBe('ws-beta');

    const alreadyUnbound = chatReducer(rebound, {
      type: 'conversation/unbind-workspace',
      payload: { id: 'chat-a', at: T3 },
    });
    expect(alreadyUnbound).toBe(rebound);
  });

  test('persists current-schema workspace ids deterministically', () => {
    const state = workspaceBoundState();
    const first = serializeChatState(state);
    const second = serializeChatState(state);
    const decoded = JSON.parse(first) as {
      schema_version: number;
      conversations: Array<{ id: string; workspace_id: string | null }>;
    };

    expect(first).toBe(second);
    expect(decoded.schema_version).toBe(CHAT_STATE_SCHEMA_VERSION);
    expect(decoded.conversations[0]).toMatchObject({
      id: 'chat-a',
      workspace_id: 'ws-alpha',
    });
    expect(decoded.conversations[1]).toMatchObject({
      id: 'chat-b',
      workspace_id: 'ws-beta',
    });
  });

  test('round-trips bound workspaces through hydration', () => {
    const state = workspaceBoundState();
    const hydrated = hydrateChatState(serializeChatState(state));
    expect(hydrated).toEqual(state);
    expect(serializeChatState(hydrated)).toBe(serializeChatState(state));
  });

  test('deterministically migrates schema v4 conversations as unbound', () => {
    const legacy = JSON.parse(serializeChatState(workspaceBoundState())) as {
      schema_version: number;
      conversations: Array<Record<string, unknown>>;
    };
    legacy.schema_version = 4;
    legacy.conversations.forEach(conversation => {
      delete conversation.workspace_id;
    });

    const first = hydrateChatState(legacy);
    const second = hydrateChatState(JSON.stringify(legacy));
    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(CHAT_STATE_SCHEMA_VERSION);
    expect(first).toMatchObject({
      projectContextDestructiveEpoch: 0,
      projectContextDestructiveTransition: null,
    });
    expect(
      Object.values(first.conversations).every(
        conversation => conversation.workspaceId === null,
      ),
    ).toBe(true);

    const migrated = JSON.parse(serializeChatState(first)) as {
      schema_version: number;
      conversations: Array<{ workspace_id: string | null }>;
    };
    expect(migrated.schema_version).toBe(CHAT_STATE_SCHEMA_VERSION);
    expect(
      migrated.conversations.every(conversation =>
        conversation.workspace_id === null,
      ),
    ).toBe(true);
  });

  test('strictly validates the required v6 workspace_id field', () => {
    const missing = JSON.parse(
      serializeChatState(workspaceBoundState()),
    ) as { conversations: Array<Record<string, unknown>> };
    delete missing.conversations[0]?.workspace_id;
    expect(() => hydrateChatState(missing)).toThrow(/workspace_id/);

    for (const invalidWorkspaceId of ['', '   ', 'x'.repeat(257), 42]) {
      const invalid = JSON.parse(
        serializeChatState(workspaceBoundState()),
      ) as { conversations: Array<Record<string, unknown>> };
      invalid.conversations[0]!.workspace_id = invalidWorkspaceId;
      expect(() => hydrateChatState(invalid)).toThrow(/workspace_id/);
    }
  });
});

describe('schema v6 attempts and project context', () => {
  const RUNTIME_ID = '11111111-1111-4111-8111-111111111111';
  const TURN_ID = '22222222-2222-4222-8222-222222222222';
  const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
  const RETRY_ID = '44444444-4444-4444-8444-444444444444';
  const ROUND_ID = '55555555-5555-4555-8555-555555555555';
  const PROJECT_ID = '99999999-9999-4999-8999-999999999999';
  const OTHER_PROJECT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const SNAPSHOT_ID = '77777777-7777-4777-8777-777777777777';
  const CONSENT_ID = '88888888-8888-4888-8888-888888888888';
  const REPLACEMENT_SNAPSHOT_ID =
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const REPLACEMENT_CONSENT_ID =
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const REPLACEMENT_PREPARATION_ID =
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const LIFECYCLE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  const contextManifest: ProjectContextManifestV1 = {
    schema_version: 1,
    snapshot_id: SNAPSHOT_ID,
    project_id: PROJECT_ID,
    project_name: 'demo',
    branch: 'main',
    head_oid: '0123456789abcdef0123456789abcdef01234567',
    clean: true,
    conflicted: false,
    captured_at: T1,
    policy_version: 'chat-read-v1.0.0',
    provider_host: 'api.deepseek.com',
    model: 'deepseek-v4-flash',
    included: [
      {
        path: 'README.md',
        source: 'tracked_file',
        bytes: 10,
        sha256: '9'.repeat(64),
      },
    ],
    omitted: [],
    context_bytes: 10,
    estimated_tokens: 3,
    snapshot_sha256: 'd'.repeat(64),
    source_fingerprint: 'e'.repeat(64),
  };
  const contextConsent: ProjectContextConsentV1 = {
    schema_version: 1,
    consent_receipt_id: CONSENT_ID,
    snapshot_id: SNAPSHOT_ID,
    snapshot_sha256: 'd'.repeat(64),
    confirmed_at: T2,
  };
  const replacementManifest: ProjectContextManifestV1 = {
    ...contextManifest,
    snapshot_id: REPLACEMENT_SNAPSHOT_ID,
    captured_at: T3,
    included: [
      {
        path: 'src/index.ts',
        source: 'tracked_file',
        bytes: 12,
        sha256: '7'.repeat(64),
      },
    ],
    context_bytes: 12,
    estimated_tokens: 3,
    snapshot_sha256: 'a'.repeat(64),
    source_fingerprint: 'b'.repeat(64),
  };
  const replacementConsent: ProjectContextConsentV1 = {
    schema_version: 1,
    consent_receipt_id: REPLACEMENT_CONSENT_ID,
    snapshot_id: REPLACEMENT_SNAPSHOT_ID,
    snapshot_sha256: 'a'.repeat(64),
    confirmed_at: T3,
  };

  function v6Store() {
    const runtimeIds = [RUNTIME_ID, TURN_ID, ATTEMPT_ID, RETRY_ID];
    let ordinary = 0;
    return createChatStore({
      now: () => T1,
      createId: kind => `${kind}-${++ordinary}`,
      createLifecycleId: () => runtimeIds.shift() ?? ROUND_ID,
    });
  }

  function readyProjectStore(contextBytes = 10) {
    const store = v6Store();
    const conversationId = store.createConversation({ projectId: PROJECT_ID });
    const manifest = {
      ...contextManifest,
      context_bytes: contextBytes,
      estimated_tokens: Math.floor((contextBytes + 3) / 4),
    };
    expect(store.ensureRuntimeContextId(conversationId)).toBe(RUNTIME_ID);
    const prepared = store.replaceProjectContextPrepared(
      projectContextScope(store, conversationId),
      {
        preparationId: REPLACEMENT_PREPARATION_ID,
        selectedPaths: [],
        manifest,
      },
    );
    expect(prepared?.commit()).toBe(true);
    const confirmed = store.replaceProjectContextConfirmed(
      projectContextScope(store, conversationId),
      {
        preparationId: REPLACEMENT_PREPARATION_ID,
        selectedPaths: [],
        manifest,
        consent: contextConsent,
      },
    );
    expect(confirmed?.commit()).toBe(true);
    return { store, conversationId };
  }

  function setupProjectStore() {
    const store = v6Store();
    const conversationId = store.createConversation({ projectId: PROJECT_ID });
    expect(store.ensureRuntimeContextId(conversationId)).toBe(RUNTIME_ID);
    return { store, conversationId };
  }

  function scopedReadyProjectStore(contextBytes = 10) {
    const fixture = readyProjectStore(contextBytes);
    return fixture;
  }

  function schema2Receipt(
    prepared: { turnId: string; attemptId: string },
    overrides: Partial<CompletionRoundReceiptV1> = {},
  ): CompletionRoundReceiptV1 {
    return {
      schemaVersion: 1,
      transportSchemaVersion: 2,
      turnId: prepared.turnId,
      attemptId: prepared.attemptId,
      roundId: ROUND_ID,
      roundIndex: 0,
      providerRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      providerResponseId: 'resp_1',
      requestedModel: 'deepseek-v4-flash',
      model: 'deepseek-v4-flash',
      thinkingMode: 'high',
      finishReason: 'stop',
      latencyMs: 1,
      visibleHistorySha256: 'a'.repeat(64),
      modelInputSha256: 'b'.repeat(64),
      requestBodySha256: 'c'.repeat(64),
      projectContextReceipt: null,
      ...overrides,
    };
  }

  function schema6Payload(store: ChatStore) {
    const payload = JSON.parse(store.serialize()) as Record<string, unknown>;
    payload.schema_version = 6;
    delete payload.project_context_destructive_epoch;
    delete payload.project_context_destructive_transition;
    return payload;
  }

  function schema7IntentPayload(
    store: ChatStore,
    conversationId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const payload = schema6Payload(store);
    const conversation = store.getState().conversations[conversationId]!;
    const snapshot = conversation.projectContext!.snapshot!;
    const consent = conversation.projectContext!.consent;
    payload.schema_version = 7;
    payload.project_context_destructive_epoch = 1;
    payload.project_context_destructive_transition = {
      schema_version: 1,
      lifecycle_id: LIFECYCLE_ID,
      epoch: 1,
      action: 'unbind',
      phase: 'intent',
      conversation_id: conversationId,
      source_project_id: conversation.projectId,
      source_runtime_context_id: conversation.runtimeContextId,
      source_model_id: conversation.modelId,
      snapshot_id: snapshot.snapshot_id,
      snapshot_sha256: snapshot.snapshot_sha256,
      consent_receipt_id: consent?.consent_receipt_id ?? null,
      target_project_id: null,
      created_at: T3,
      updated_at: T3,
      ...overrides,
    };
    return payload;
  }

  test('migrates schema v6 to v7 without changing conversations, attempts, or messages', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const prepared = store.prepareTurnAttempt(conversationId, 'preserve me');
    expect(prepared?.commit()).toBe(true);
    const v6 = schema6Payload(store) as {
      conversations: unknown;
      messages: unknown;
    };

    const hydrated = hydrateChatState(v6) as ChatState & {
      projectContextDestructiveEpoch?: number;
      projectContextDestructiveTransition?: unknown;
    };
    expect(hydrated.schemaVersion).toBe(7);
    expect(hydrated.projectContextDestructiveEpoch).toBe(0);
    expect(hydrated.projectContextDestructiveTransition).toBeNull();
    const serialized = JSON.parse(serializeChatState(hydrated)) as {
      schema_version: number;
      project_context_destructive_epoch: number;
      project_context_destructive_transition: unknown;
      conversations: unknown;
      messages: unknown;
    };
    expect(serialized).toMatchObject({
      schema_version: 7,
      project_context_destructive_epoch: 0,
      project_context_destructive_transition: null,
    });
    expect(serialized.conversations).toEqual(v6.conversations);
    expect(serialized.messages).toEqual(v6.messages);
  });

  test('strictly round-trips one metadata-only schema v7 intent journal', () => {
    const { store, conversationId } = readyProjectStore();
    const payload = schema7IntentPayload(store, conversationId);
    const hydrated = hydrateChatState(payload) as ChatState & {
      projectContextDestructiveEpoch: number;
      projectContextDestructiveTransition: {
        lifecycleId: string;
        action: string;
        phase: string;
        snapshotId: string;
        consentReceiptId: string | null;
      } | null;
    };
    expect(hydrated.projectContextDestructiveEpoch).toBe(1);
    expect(hydrated.projectContextDestructiveTransition).toMatchObject({
      lifecycleId: LIFECYCLE_ID,
      action: 'unbind',
      phase: 'intent',
      snapshotId: SNAPSHOT_ID,
      consentReceiptId: CONSENT_ID,
    });
    const serialized = JSON.parse(serializeChatState(hydrated)) as {
      project_context_destructive_transition: Record<string, unknown>;
    };
    expect(Object.keys(serialized.project_context_destructive_transition).sort())
      .toEqual(
        [
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
        ].sort(),
      );
    expect(serializeChatState(hydrateChatState(serialized))).toBe(
      JSON.stringify(serialized),
    );
    expect(JSON.stringify(serialized.project_context_destructive_transition))
      .not.toMatch(/selected_paths|manifest|content|attachment|native|error/);
  });

  test('accepts exact nullable runtime and consent from a stale source snapshot', () => {
    const { store, conversationId } = readyProjectStore();
    expect(
      store.applyProjectContextAction(conversationId, {
        type: 'project_changed',
      }),
    ).toBe(true);
    const payload = schema7IntentPayload(store, conversationId, {
      source_runtime_context_id: null,
      consent_receipt_id: null,
    });
    const conversations = payload.conversations as Array<
      Record<string, unknown>
    >;
    conversations[0]!.runtime_context_id = null;

    const hydrated = hydrateChatState(payload) as ChatState & {
      projectContextDestructiveTransition: {
        sourceRuntimeContextId: string | null;
        consentReceiptId: string | null;
      } | null;
    };
    expect(hydrated.projectContextDestructiveTransition).toMatchObject({
      sourceRuntimeContextId: null,
      consentReceiptId: null,
    });
  });

  test('rejects hostile and non-exact schema v7 root and journal records', () => {
    const { store, conversationId } = readyProjectStore();
    const cases: unknown[] = [];
    const missingRoot = schema7IntentPayload(store, conversationId);
    delete missingRoot.project_context_destructive_epoch;
    cases.push(missingRoot);
    const extraRoot = schema7IntentPayload(store, conversationId);
    extraRoot.raw_context = 'RAW_CONTEXT_SENTINEL';
    cases.push(extraRoot);
    const extraJournal = schema7IntentPayload(store, conversationId);
    (extraJournal.project_context_destructive_transition as Record<string, unknown>)
      .path = '/private/raw-path-sentinel';
    cases.push(extraJournal);
    const symbolJournal = schema7IntentPayload(store, conversationId);
    Object.defineProperty(
      symbolJournal.project_context_destructive_transition as object,
      Symbol('raw'),
      { value: 'RAW_SYMBOL_SENTINEL', enumerable: true },
    );
    cases.push(symbolJournal);
    const exoticJournal = schema7IntentPayload(store, conversationId);
    Object.setPrototypeOf(
      exoticJournal.project_context_destructive_transition as object,
      { raw: true },
    );
    cases.push(exoticJournal);
    const hiddenJournal = schema7IntentPayload(store, conversationId);
    Object.defineProperty(
      hiddenJournal.project_context_destructive_transition as object,
      'action',
      { value: 'unbind', enumerable: false },
    );
    cases.push(hiddenJournal);
    let getterCalls = 0;
    const getterRoot = schema7IntentPayload(store, conversationId);
    Object.defineProperty(getterRoot, 'project_context_destructive_transition', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error('RAW_GETTER_SENTINEL');
      },
    });
    cases.push(getterRoot);

    cases.forEach(candidate =>
      expect(() => hydrateChatState(candidate)).toThrow(
        ChatStateValidationError,
      ),
    );
    expect(getterCalls).toBe(0);
  });

  test('rejects invalid schema v7 journal bounds, identities, and relations', () => {
    const { store, conversationId } = readyProjectStore();
    const invalidOverrides: Array<Record<string, unknown>> = [
      { lifecycle_id: 'not-a-uuid' },
      { epoch: 0 },
      { action: 'destroy' },
      { phase: 'done' },
      { source_project_id: '' },
      { source_runtime_context_id: 'not-a-uuid' },
      { source_model_id: 'secret-model' },
      { snapshot_id: OTHER_PROJECT_ID },
      { snapshot_sha256: 'A'.repeat(64) },
      { consent_receipt_id: OTHER_PROJECT_ID },
      { target_project_id: PROJECT_ID },
      { created_at: 'not-a-time' },
      { updated_at: T0 },
      { conversation_id: 'missing-conversation' },
    ];
    invalidOverrides.forEach(overrides =>
      expect(() =>
        hydrateChatState(
          schema7IntentPayload(store, conversationId, overrides),
        ),
      ).toThrow(ChatStateValidationError),
    );

    expect(() =>
      hydrateChatState(
        schema7IntentPayload(store, conversationId, {
          action: 'rebind',
          target_project_id: null,
        }),
      ),
    ).toThrow(ChatStateValidationError);
    expect(() =>
      hydrateChatState(
        schema7IntentPayload(store, conversationId, {
          action: 'rebind',
          target_project_id: PROJECT_ID,
        }),
      ),
    ).toThrow(ChatStateValidationError);
  });

  test('rejects lifecycle checkpoints with impossible phase timestamp relationships', () => {
    const fixture = readyProjectStore();
    expect(() =>
      hydrateChatState(
        schema7IntentPayload(fixture.store, fixture.conversationId, {
          updated_at: '9999-12-31T23:59:59.999Z',
        }),
      ),
    ).toThrow(ChatStateValidationError);
    expect(() =>
      hydrateChatState(
        schema7IntentPayload(fixture.store, fixture.conversationId, {
          created_at: T0,
          updated_at: T0,
        }),
      ),
    ).toThrow(ChatStateValidationError);

    const begun = beginLifecycle(fixture.store, fixture.conversationId)!;
    expect(begun.commit()).toBe(true);
    const tombstone = tombstoneLifecycle(
      fixture.store,
      begun.lifecycleId,
      begun.epoch,
    )!;
    expect(tombstone.commit()).toBe(true);
    const cleanupPending = JSON.parse(fixture.store.serialize()) as {
      conversations: Array<Record<string, unknown>>;
      project_context_destructive_transition: Record<string, unknown>;
    };
    cleanupPending.project_context_destructive_transition.updated_at = T2;
    expect(() => hydrateChatState(cleanupPending)).toThrow(
      ChatStateValidationError,
    );

    const ready = cleanupLifecycle(
      fixture.store,
      begun.lifecycleId,
      begun.epoch,
    )!;
    expect(ready.commit()).toBe(true);
    const readyPayload = JSON.parse(fixture.store.serialize()) as {
      conversations: Array<Record<string, unknown>>;
    };
    readyPayload.conversations[0]!.updated_at = T2;
    expect(() => hydrateChatState(readyPayload)).toThrow(
      ChatStateValidationError,
    );
  });

  test('rejects root epoch edge cases, owner drift, lifecycle collisions, and journal accessors', () => {
    const { store, conversationId } = readyProjectStore();
    for (const epoch of [-1, -0, Number.MAX_SAFE_INTEGER + 1]) {
      const payload = schema7IntentPayload(store, conversationId);
      payload.project_context_destructive_epoch = epoch;
      expect(() => hydrateChatState(payload)).toThrow(ChatStateValidationError);
    }
    const mismatch = schema7IntentPayload(store, conversationId);
    mismatch.project_context_destructive_epoch = 2;
    expect(() => hydrateChatState(mismatch)).toThrow(ChatStateValidationError);
    for (const overrides of [
      { source_project_id: OTHER_PROJECT_ID },
      { source_runtime_context_id: OTHER_PROJECT_ID },
      { source_model_id: 'deepseek-v4-pro' },
      { lifecycle_id: RUNTIME_ID },
    ]) {
      expect(() =>
        hydrateChatState(
          schema7IntentPayload(store, conversationId, overrides),
        ),
      ).toThrow(ChatStateValidationError);
    }

    let getterCalls = 0;
    const nestedGetter = schema7IntentPayload(store, conversationId);
    Object.defineProperty(
      nestedGetter.project_context_destructive_transition as object,
      'snapshot_id',
      {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          throw new Error('RAW_NESTED_GETTER');
        },
      },
    );
    expect(() => hydrateChatState(nestedGetter)).toThrow(
      ChatStateValidationError,
    );
    const epochGetter = schema7IntentPayload(store, conversationId);
    Object.defineProperty(epochGetter, 'project_context_destructive_epoch', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error('RAW_EPOCH_GETTER');
      },
    });
    expect(() => hydrateChatState(epochGetter)).toThrow(
      ChatStateValidationError,
    );
    expect(getterCalls).toBe(0);
  });

  test('round-trips cleanup, ready, and finalized lifecycle checkpoints', () => {
    const { store, conversationId } = readyProjectStore();
    const begun = beginLifecycle(store, conversationId)!;
    expect(begun.commit()).toBe(true);
    const tombstone = tombstoneLifecycle(
      store,
      begun.lifecycleId,
      begun.epoch,
    )!;
    expect(tombstone.commit()).toBe(true);
    expect(hydrateChatState(store.serialize())).toEqual(store.getState());
    const ready = cleanupLifecycle(
      store,
      begun.lifecycleId,
      begun.epoch,
    )!;
    expect(ready.commit()).toBe(true);
    expect(hydrateChatState(store.serialize())).toEqual(store.getState());
    const finalize = finalizeLifecycle(
      store,
      begun.lifecycleId,
      begun.epoch,
    )!;
    expect(finalize.commit()).toBe(true);
    const finalized = hydrateChatState(store.serialize());
    expect(finalized).toMatchObject({
      projectContextDestructiveEpoch: 1,
      projectContextDestructiveTransition: null,
    });
  });

  test('rejects hydrated lifecycle journals whose snapshot gains an attempt reference', () => {
    const { store, conversationId } = readyProjectStore();
    const prepared = store.prepareTurnAttempt(
      conversationId,
      'persisted lifecycle reference',
    );
    expect(prepared?.commit()).toBe(true);
    expect(() =>
      hydrateChatState(schema7IntentPayload(store, conversationId)),
    ).toThrow(ChatStateValidationError);
  });

  type LifecycleTransactionHarness = {
    lifecycleId: string;
    epoch: number;
    commit(): boolean;
    rollback(): boolean;
  };

  type LifecycleAdvanceScopeHarness = {
    lifecycleId: string;
    epoch: number;
    action: 'unbind' | 'delete' | 'rebind';
    targetProjectId: string | null;
    expectedTransition: NonNullable<
      ChatState['projectContextDestructiveTransition']
    >;
  };

  type LifecycleStoreHarness = ChatStore & {
    beginProjectContextDestructiveTransition(input: {
      lifecycleId: string;
      action: 'unbind' | 'delete' | 'rebind';
      targetProjectId: string | null;
      owner: {
        conversationId: string;
        projectId: string;
        runtimeContextId: string | null;
        modelId: string;
        expectedUpdatedAt: string;
        expectedContext: NonNullable<
          ChatState['conversations'][string]['projectContext']
        >;
      };
    }): LifecycleTransactionHarness | null;
    tombstoneProjectContextDestructiveTransition(
      scope: LifecycleAdvanceScopeHarness,
    ): LifecycleTransactionHarness | null;
    markProjectContextDestructiveCleanupComplete(
      scope: LifecycleAdvanceScopeHarness,
    ): LifecycleTransactionHarness | null;
    finalizeProjectContextDestructiveTransition(
      scope: LifecycleAdvanceScopeHarness,
    ): LifecycleTransactionHarness | null;
  };

  type SnapshotFreeMutationHarness = ChatStore & {
    applySnapshotFreeProjectMutation(input: {
      action: 'unbind' | 'delete' | 'rebind';
      conversationId: string;
      targetProjectId: string | null;
      expectedConversation: ChatState['conversations'][string];
    }): {
      conversationId: string;
      action: 'unbind' | 'delete' | 'rebind';
      commit(): boolean;
      rollback(): boolean;
    } | null;
  };

  function snapshotFreeStore(store: ChatStore): SnapshotFreeMutationHarness {
    return store as SnapshotFreeMutationHarness;
  }

  function lifecycleStore(store: ChatStore): LifecycleStoreHarness {
    return store as LifecycleStoreHarness;
  }

  function lifecycleAdvanceScope(
    store: ChatStore,
    lifecycleId: string,
    epoch: number,
    expectedTransition = store.getState()
      .projectContextDestructiveTransition!,
  ): LifecycleAdvanceScopeHarness {
    return {
      lifecycleId,
      epoch,
      action: expectedTransition.action,
      targetProjectId: expectedTransition.targetProjectId,
      expectedTransition,
    };
  }

  function tombstoneLifecycle(
    store: ChatStore,
    lifecycleId: string,
    epoch: number,
  ) {
    return lifecycleStore(store).tombstoneProjectContextDestructiveTransition(
      lifecycleAdvanceScope(store, lifecycleId, epoch),
    );
  }

  function cleanupLifecycle(
    store: ChatStore,
    lifecycleId: string,
    epoch: number,
  ) {
    return lifecycleStore(
      store,
    ).markProjectContextDestructiveCleanupComplete(
      lifecycleAdvanceScope(store, lifecycleId, epoch),
    );
  }

  function finalizeLifecycle(
    store: ChatStore,
    lifecycleId: string,
    epoch: number,
    expectedTransition?: NonNullable<
      ChatState['projectContextDestructiveTransition']
    >,
  ) {
    return lifecycleStore(store).finalizeProjectContextDestructiveTransition(
      lifecycleAdvanceScope(store, lifecycleId, epoch, expectedTransition),
    );
  }

  function beginLifecycle(
    store: ChatStore,
    conversationId: string,
    action: 'unbind' | 'delete' | 'rebind' = 'unbind',
    targetProjectId: string | null = null,
    lifecycleId = LIFECYCLE_ID,
  ) {
    const conversation = store.getState().conversations[conversationId]!;
    return lifecycleStore(store).beginProjectContextDestructiveTransition({
      lifecycleId,
      action,
      targetProjectId,
      owner: {
        conversationId,
        projectId: conversation.projectId!,
        runtimeContextId: conversation.runtimeContextId,
        modelId: conversation.modelId,
        expectedUpdatedAt: conversation.updatedAt,
        expectedContext: conversation.projectContext!,
      },
    });
  }

  function advanceLifecycleToReady(
    store: ChatStore,
    conversationId: string,
    action: 'unbind' | 'delete' | 'rebind' = 'unbind',
    targetProjectId: string | null = null,
  ) {
    const begun = beginLifecycle(
      store,
      conversationId,
      action,
      targetProjectId,
    )!;
    expect(begun.commit()).toBe(true);
    const tombstone = tombstoneLifecycle(
      store,
      begun.lifecycleId,
      begun.epoch,
    )!;
    expect(tombstone.commit()).toBe(true);
    const ready = cleanupLifecycle(store, begun.lifecycleId, begun.epoch)!;
    expect(ready.commit()).toBe(true);
    return ready;
  }

  test('creates one global intent journal and preserves unrelated listener changes on rollback', () => {
    const { store, conversationId } = readyProjectStore();
    const unrelated = store.createConversation({
      title: 'Unrelated before',
      select: false,
    });
    const notifications: number[] = [];
    let reentered = false;
    store.subscribe(() => {
      throw new Error('listener sentinel');
    });
    store.subscribe(state => {
      notifications.push(state.conversationOrder.length);
      if (!reentered && state.projectContextDestructiveTransition !== null) {
        reentered = true;
        store.renameConversation(unrelated, 'Unrelated after');
      }
    });

    const transaction = beginLifecycle(store, conversationId);
    expect(transaction).not.toBeNull();
    expect(store.getState()).toMatchObject({
      projectContextDestructiveEpoch: 1,
      projectContextDestructiveTransition: {
        lifecycleId: LIFECYCLE_ID,
        epoch: 1,
        action: 'unbind',
        phase: 'intent',
        conversationId,
      },
    });
    expect(beginLifecycle(store, conversationId)).toBeNull();
    expect(transaction?.rollback()).toBe(true);
    expect(transaction?.rollback()).toBe(false);
    expect(transaction?.commit()).toBe(false);
    expect(store.getState()).toMatchObject({
      projectContextDestructiveEpoch: 0,
      projectContextDestructiveTransition: null,
    });
    expect(store.getState().conversations[unrelated]?.title).toBe(
      'Unrelated after',
    );
    expect(notifications.length).toBeGreaterThanOrEqual(3);
  });

  test('rejects lifecycle advancement reentered from begin notification', () => {
    const { store, conversationId } = readyProjectStore();
    let nested: LifecycleTransactionHarness | null | undefined;
    store.subscribe(state => {
      const transition = state.projectContextDestructiveTransition;
      if (transition?.phase === 'intent' && nested === undefined) {
        nested = tombstoneLifecycle(
          store,
          transition.lifecycleId,
          transition.epoch,
        );
        store.dispatch({
          type: 'project-context-destructive/tombstone',
          payload: {
            scope: lifecycleAdvanceScope(
              store,
              transition.lifecycleId,
              transition.epoch,
              transition,
            ),
            at: T2,
          },
        });
      }
    });

    const begun = beginLifecycle(store, conversationId);
    expect(begun).not.toBeNull();
    expect(nested).toBeNull();
    expect(store.getState()).toMatchObject({
      projectContextDestructiveTransition: { phase: 'intent' },
      conversations: {
        [conversationId]: {
          projectContext: { snapshot: { snapshot_id: SNAPSHOT_ID } },
        },
      },
    });
  });

  test('tombstone and cleanup-complete transactions roll back to their exact prior phases', () => {
    const { store, conversationId } = readyProjectStore();
    const begun = beginLifecycle(store, conversationId)!;
    expect(begun.commit()).toBe(true);
    const sourceContext = store.getState().conversations[conversationId]!
      .projectContext;

    const tombstone = tombstoneLifecycle(
      store,
      begun.lifecycleId,
      begun.epoch,
    )!;
    expect(store.getState()).toMatchObject({
      projectContextDestructiveTransition: { phase: 'cleanup_pending' },
      conversations: {
        [conversationId]: {
          projectId: PROJECT_ID,
          projectContext: { status: 'setup_required', snapshot: null },
        },
      },
    });
    expect(tombstone.rollback()).toBe(true);
    expect(
      store.getState().conversations[conversationId]?.projectContext,
    ).toBe(sourceContext);
    expect(store.getState()).toMatchObject({
      projectContextDestructiveTransition: { phase: 'intent' },
    });

    const tombstoneAgain = tombstoneLifecycle(
      store,
      begun.lifecycleId,
      begun.epoch,
    )!;
    expect(tombstoneAgain.commit()).toBe(true);
    const cleanup = cleanupLifecycle(
      store,
      begun.lifecycleId,
      begun.epoch,
    )!;
    expect(store.getState()).toMatchObject({
      projectContextDestructiveTransition: { phase: 'ready_to_finalize' },
    });
    expect(cleanup.rollback()).toBe(true);
    expect(store.getState()).toMatchObject({
      projectContextDestructiveTransition: { phase: 'cleanup_pending' },
    });
    expect(cleanup.commit()).toBe(false);
  });

  test.each([
    { action: 'unbind' as const, targetProjectId: null },
    { action: 'rebind' as const, targetProjectId: OTHER_PROJECT_ID },
  ])('finalizes $action and clears the journal atomically', fixture => {
    const { store, conversationId } = readyProjectStore();
    const ready = advanceLifecycleToReady(
      store,
      conversationId,
      fixture.action,
      fixture.targetProjectId,
    );
    const finalize = finalizeLifecycle(
      store,
      ready.lifecycleId,
      ready.epoch,
    )!;
    expect(finalize).not.toBeNull();
    expect(store.getState().projectContextDestructiveTransition).toBeNull();
    expect(store.getState().projectContextDestructiveEpoch).toBe(1);
    expect(store.getState().conversations[conversationId]).toMatchObject(
      fixture.action === 'unbind'
        ? { projectId: null, projectContext: null }
        : {
            projectId: OTHER_PROJECT_ID,
            projectContext: {
              projectId: OTHER_PROJECT_ID,
              status: 'setup_required',
              snapshot: null,
            },
          },
    );
    expect(finalize.rollback()).toBe(true);
    expect(store.getState()).toMatchObject({
      projectContextDestructiveTransition: { phase: 'ready_to_finalize' },
      conversations: {
        [conversationId]: { projectId: PROJECT_ID },
      },
    });
  });

  test('finalize delete preserves a nonactive selection and restores it exactly on rollback', () => {
    const { store, conversationId } = readyProjectStore();
    const selected = store.createConversation({ title: 'Keep selected' });
    const ready = advanceLifecycleToReady(store, conversationId, 'delete');
    const finalize = finalizeLifecycle(
      store,
      ready.lifecycleId,
      ready.epoch,
    )!;
    expect(store.getState().conversations[conversationId]).toBeUndefined();
    expect(store.getState().selectedConversationId).toBe(selected);
    expect(finalize.rollback()).toBe(true);
    expect(store.getState().conversations[conversationId]).toBeDefined();
    expect(store.getState().selectedConversationId).toBe(selected);

    const activeFixture = readyProjectStore();
    const fallback = activeFixture.store.createConversation({
      title: 'Fallback',
      select: false,
    });
    activeFixture.store.selectConversation(activeFixture.conversationId);
    const activeReady = advanceLifecycleToReady(
      activeFixture.store,
      activeFixture.conversationId,
      'delete',
    );
    const activeFinalize = finalizeLifecycle(
      activeFixture.store,
      activeReady.lifecycleId,
      activeReady.epoch,
    )!;
    expect(activeFixture.store.getState().selectedConversationId).toBe(fallback);
    expect(activeFinalize.commit()).toBe(true);
  });

  test('rejects begin without a snapshot, with active preparation, or with an exact-retry reference', () => {
    const setup = setupProjectStore();
    expect(beginLifecycle(setup.store, setup.conversationId)).toBeNull();

    const preparedFixture = setupProjectStore();
    const prepared = preparedFixture.store.replaceProjectContextPrepared(
      projectContextScope(preparedFixture.store, preparedFixture.conversationId),
      {
        preparationId: REPLACEMENT_PREPARATION_ID,
        selectedPaths: [],
        manifest: contextManifest,
      },
    );
    expect(prepared?.commit()).toBe(true);
    expect(
      beginLifecycle(preparedFixture.store, preparedFixture.conversationId),
    ).toBeNull();

    const retryFixture = readyProjectStore();
    const attempt = retryFixture.store.prepareTurnAttempt(
      retryFixture.conversationId,
      'frozen retry',
    );
    expect(attempt?.commit()).toBe(true);
    expect(
      retryFixture.store.failAttempt(
        retryFixture.conversationId,
        attempt!.attemptId,
        'E_COMPLETION_NATIVE',
      ),
    ).toBe(true);
    expect(
      beginLifecycle(retryFixture.store, retryFixture.conversationId),
    ).toBeNull();
  });

  test('fails closed for malformed or mismatched-owner bindings that reference the cleanup snapshot', () => {
    const makeCorruptStore = (extra: Record<string, unknown>) => {
      const fixture = readyProjectStore();
      const prepared = fixture.store.prepareTurnAttempt(
        fixture.conversationId,
        'corrupt binding reference',
      );
      expect(prepared?.commit()).toBe(true);
      const state = fixture.store.getState();
      const conversation = state.conversations[fixture.conversationId]!;
      const attempt = conversation.attempts[0]!;
      return {
        conversationId: fixture.conversationId,
        store: createChatStore({
          initialState: {
            ...state,
            conversations: {
              ...state.conversations,
              [fixture.conversationId]: {
                ...conversation,
                attempts: [
                  {
                    ...attempt,
                    projectContext: {
                      ...attempt.projectContext!,
                      ...extra,
                    },
                  },
                ],
              },
            },
          },
        }),
      };
    };

    const mismatched = makeCorruptStore({
      projectId: OTHER_PROJECT_ID,
      runtimeContextId: OTHER_PROJECT_ID,
    });
    expect(beginLifecycle(mismatched.store, mismatched.conversationId)).toBeNull();

    const malformed = makeCorruptStore({ raw_content: 'RAW_BINDING_SENTINEL' });
    expect(beginLifecycle(malformed.store, malformed.conversationId)).toBeNull();

    const wrongDisposition = makeCorruptStore({});
    const wrongDispositionState = wrongDisposition.store.getState();
    const wrongDispositionConversation =
      wrongDispositionState.conversations[wrongDisposition.conversationId]!;
    const wrongDispositionAttempt = wrongDispositionConversation.attempts[0]!;
    const wrongDispositionStore = createChatStore({
      initialState: {
        ...wrongDispositionState,
        conversations: {
          ...wrongDispositionState.conversations,
          [wrongDisposition.conversationId]: {
            ...wrongDispositionConversation,
            attempts: [
              {
                ...wrongDispositionAttempt,
                contextDisposition: 'explicit_without_context',
              },
            ],
          },
        },
      },
    });
    expect(
      beginLifecycle(wrongDispositionStore, wrongDisposition.conversationId),
    ).toBeNull();

    const unknownStatus = makeCorruptStore({});
    const unknownStatusState = unknownStatus.store.getState();
    const unknownStatusConversation =
      unknownStatusState.conversations[unknownStatus.conversationId]!;
    const unknownStatusAttempt = unknownStatusConversation.attempts[0]!;
    const unknownStatusStore = createChatStore({
      initialState: {
        ...unknownStatusState,
        conversations: {
          ...unknownStatusState.conversations,
          [unknownStatus.conversationId]: {
            ...unknownStatusConversation,
            attempts: [
              { ...unknownStatusAttempt, status: 'unknown-status' },
            ],
          },
        },
      } as ChatState,
    });
    expect(beginLifecycle(unknownStatusStore, unknownStatus.conversationId)).toBeNull();
  });

  test('rejects timestamp regression at tombstone, cleanup-complete, and finalize', () => {
    const { store, conversationId } = readyProjectStore();
    const begun = beginLifecycle(store, conversationId)!;
    expect(begun.commit()).toBe(true);
    let before = store.getState();
    store.dispatch({
      type: 'project-context-destructive/tombstone',
      payload: {
        scope: lifecycleAdvanceScope(store, begun.lifecycleId, begun.epoch),
        at: T0,
      },
    });
    expect(store.getState()).toBe(before);

    const tombstone = tombstoneLifecycle(
      store,
      begun.lifecycleId,
      begun.epoch,
    )!;
    expect(tombstone.commit()).toBe(true);
    before = store.getState();
    store.dispatch({
      type: 'project-context-destructive/cleanup-complete',
      payload: {
        scope: lifecycleAdvanceScope(store, begun.lifecycleId, begun.epoch),
        at: T0,
      },
    });
    expect(store.getState()).toBe(before);

    const cleanup = cleanupLifecycle(
      store,
      begun.lifecycleId,
      begun.epoch,
    )!;
    expect(cleanup.commit()).toBe(true);
    before = store.getState();
    store.dispatch({
      type: 'project-context-destructive/finalize',
      payload: {
        scope: lifecycleAdvanceScope(store, begun.lifecycleId, begun.epoch),
        at: T0,
      },
    });
    expect(store.getState()).toBe(before);
  });

  test('blocks direct target mutation and turn preparation while a journal exists', () => {
    const { store, conversationId } = readyProjectStore();
    const begun = beginLifecycle(store, conversationId)!;
    expect(begun.commit()).toBe(true);
    const before = store.getState().conversations[conversationId];

    store.bindConversationToProject(conversationId, OTHER_PROJECT_ID);
    store.unbindConversationFromProject(conversationId);
    store.setModel(conversationId, 'deepseek-v4-pro');
    store.applyProjectContextAction(conversationId, {
      type: 'project_changed',
    });
    expect(store.prepareTurnAttempt(conversationId, 'must be blocked')).toBeNull();
    store.deleteConversation(conversationId);

    expect(store.getState().conversations[conversationId]).toBe(before);
    expect(store.getState()).toMatchObject({
      projectContextDestructiveTransition: {
        lifecycleId: LIFECYCLE_ID,
        phase: 'intent',
      },
    });
  });

  test('rejects epoch overflow and wrong lifecycle CAS without mutation', () => {
    const { store, conversationId } = readyProjectStore();
    const overflow = createChatStore({
      initialState: {
        ...store.getState(),
        projectContextDestructiveEpoch: Number.MAX_SAFE_INTEGER,
        projectContextDestructiveTransition: null,
      } as ChatState,
    });
    expect(beginLifecycle(overflow, conversationId)).toBeNull();

    const begun = beginLifecycle(store, conversationId)!;
    expect(begun).not.toBeNull();
    const before = store.getState();
    expect(
      lifecycleStore(store).tombstoneProjectContextDestructiveTransition({
        ...lifecycleAdvanceScope(store, begun.lifecycleId, begun.epoch),
        lifecycleId: OTHER_PROJECT_ID,
      }),
    ).toBeNull();
    expect(
      lifecycleStore(store).tombstoneProjectContextDestructiveTransition({
        ...lifecycleAdvanceScope(store, begun.lifecycleId, begun.epoch),
        epoch: begun.epoch + 1,
      }),
    ).toBeNull();
    const current = store.getState().projectContextDestructiveTransition!;
    expect(
      lifecycleStore(store).tombstoneProjectContextDestructiveTransition({
        ...lifecycleAdvanceScope(store, begun.lifecycleId, begun.epoch),
        expectedTransition: { ...current },
      }),
    ).toBeNull();
    expect(store.getState()).toBe(before);
  });

  test('allows direct project mutation only when no snapshot or preparation exists', () => {
    const unbindFixture = setupProjectStore();
    unbindFixture.store.unbindConversationFromProject(
      unbindFixture.conversationId,
    );
    expect(
      unbindFixture.store.getState().conversations[
        unbindFixture.conversationId
      ],
    ).toMatchObject({ projectId: null, projectContext: null });

    const rebindFixture = setupProjectStore();
    rebindFixture.store.bindConversationToProject(
      rebindFixture.conversationId,
      OTHER_PROJECT_ID,
    );
    expect(
      rebindFixture.store.getState().conversations[
        rebindFixture.conversationId
      ],
    ).toMatchObject({
      projectId: OTHER_PROJECT_ID,
      projectContext: { projectId: OTHER_PROJECT_ID, snapshot: null },
    });

    const deleteFixture = setupProjectStore();
    deleteFixture.store.deleteConversation(deleteFixture.conversationId);
    expect(
      deleteFixture.store.getState().conversations[deleteFixture.conversationId],
    ).toBeUndefined();
  });

  test.each([
    { action: 'unbind' as const, targetProjectId: null },
    { action: 'rebind' as const, targetProjectId: OTHER_PROJECT_ID },
    { action: 'delete' as const, targetProjectId: null },
  ])(
    'returns an exact one-shot snapshot-free $action transaction',
    fixture => {
      const value = setupProjectStore();
      const beforeState = value.store.getState();
      const beforeConversation =
        beforeState.conversations[value.conversationId]!;
      const transaction = snapshotFreeStore(
        value.store,
      ).applySnapshotFreeProjectMutation({
        action: fixture.action,
        conversationId: value.conversationId,
        targetProjectId: fixture.targetProjectId,
        expectedConversation: beforeConversation,
      });
      expect(transaction).not.toBeNull();
      const applied = value.store.getState();
      if (fixture.action === 'delete') {
        expect(applied.conversations[value.conversationId]).toBeUndefined();
      } else {
        expect(applied.conversations[value.conversationId]?.projectId).toBe(
          fixture.targetProjectId,
        );
      }
      expect(transaction?.rollback()).toBe(true);
      expect(
        value.store.getState().conversations[value.conversationId],
      ).toBe(beforeConversation);
      expect(transaction?.rollback()).toBe(false);
      expect(transaction?.commit()).toBe(false);
    },
  );

  test('commits snapshot-free mutation once and rejects stale, hostile, or unsafe input', () => {
    const ready = readyProjectStore();
    const readyConversation =
      ready.store.getState().conversations[ready.conversationId]!;
    expect(
      snapshotFreeStore(ready.store).applySnapshotFreeProjectMutation({
        action: 'unbind',
        conversationId: ready.conversationId,
        targetProjectId: null,
        expectedConversation: readyConversation,
      }),
    ).toBeNull();

    const setup = setupProjectStore();
    const expected = setup.store.getState().conversations[setup.conversationId]!;
    setup.store.renameConversation(setup.conversationId, 'Drifted');
    expect(
      snapshotFreeStore(setup.store).applySnapshotFreeProjectMutation({
        action: 'unbind',
        conversationId: setup.conversationId,
        targetProjectId: null,
        expectedConversation: expected,
      }),
    ).toBeNull();

    let getterCalls = 0;
    const hostile = {
      action: 'unbind',
      conversationId: setup.conversationId,
      targetProjectId: null,
      get expectedConversation() {
        getterCalls += 1;
        throw new Error('RAW_DIRECT_SENTINEL');
      },
    };
    expect(
      snapshotFreeStore(setup.store).applySnapshotFreeProjectMutation(
        hostile as never,
      ),
    ).toBeNull();
    expect(getterCalls).toBe(0);

    const fresh = setupProjectStore();
    const freshConversation =
      fresh.store.getState().conversations[fresh.conversationId]!;
    const committed = snapshotFreeStore(
      fresh.store,
    ).applySnapshotFreeProjectMutation({
      action: 'rebind',
      conversationId: fresh.conversationId,
      targetProjectId: OTHER_PROJECT_ID,
      expectedConversation: freshConversation,
    });
    expect(committed?.commit()).toBe(true);
    expect(committed?.commit()).toBe(false);
    expect(committed?.rollback()).toBe(false);
  });

  test('snapshot-free delete rollback preserves listener selection and unrelated changes', () => {
    const value = setupProjectStore();
    const fallback = value.store.createConversation({
      title: 'Fallback',
      select: false,
    });
    const listenerSelection = value.store.createConversation({
      title: 'Listener selection',
      select: false,
    });
    value.store.selectConversation(value.conversationId);
    let reentered = false;
    value.store.subscribe(state => {
      if (
        !reentered &&
        state.conversations[value.conversationId] === undefined
      ) {
        reentered = true;
        value.store.selectConversation(listenerSelection);
        value.store.renameConversation(fallback, 'Fallback changed');
      }
    });
    const beforeConversation =
      value.store.getState().conversations[value.conversationId]!;
    const transaction = snapshotFreeStore(
      value.store,
    ).applySnapshotFreeProjectMutation({
      action: 'delete',
      conversationId: value.conversationId,
      targetProjectId: null,
      expectedConversation: beforeConversation,
    });

    expect(transaction).not.toBeNull();
    expect(value.store.getState().selectedConversationId).toBe(
      listenerSelection,
    );
    expect(transaction?.rollback()).toBe(true);
    expect(value.store.getState()).toMatchObject({
      selectedConversationId: listenerSelection,
      conversations: {
        [value.conversationId]: { projectId: PROJECT_ID },
        [fallback]: { title: 'Fallback changed' },
      },
    });
  });

  test('snapshot-free delete rejects a live attempt', () => {
    const value = setupProjectStore();
    const prepared = value.store.prepareTurnAttempt(
      value.conversationId,
      'still active',
      { sendWithoutProjectContext: true },
    );
    expect(prepared?.commit()).toBe(true);
    const conversation =
      value.store.getState().conversations[value.conversationId]!;
    expect(
      snapshotFreeStore(value.store).applySnapshotFreeProjectMutation({
        action: 'delete',
        conversationId: value.conversationId,
        targetProjectId: null,
        expectedConversation: conversation,
      }),
    ).toBeNull();
    expect(value.store.getState().conversations[value.conversationId]).toBe(
      conversation,
    );
  });

  test('snapshot-free rollback preserves a lifecycle journal on an unrelated conversation', () => {
    const value = readyProjectStore();
    const directId = value.store.createConversation({
      projectId: OTHER_PROJECT_ID,
      select: false,
    });
    const beforeDirect = value.store.getState().conversations[directId]!;
    const transaction = snapshotFreeStore(
      value.store,
    ).applySnapshotFreeProjectMutation({
      action: 'delete',
      conversationId: directId,
      targetProjectId: null,
      expectedConversation: beforeDirect,
    });
    const lifecycle = beginLifecycle(value.store, value.conversationId);

    expect(transaction).not.toBeNull();
    expect(lifecycle).not.toBeNull();
    expect(transaction?.rollback()).toBe(true);
    expect(value.store.getState().conversations[directId]).toBe(beforeDirect);
    expect(value.store.getState().projectContextDestructiveTransition).toMatchObject({
      conversationId: value.conversationId,
      phase: 'intent',
    });
  });

  test('snapshot-free mutation rechecks target and journal after the injected clock returns', () => {
    let renameStore!: ChatStore;
    let renameReentry = false;
    let renameTargetId = '';
    renameStore = createChatStore({
      now: () => {
        if (renameReentry) {
          renameReentry = false;
          renameStore.renameConversation(renameTargetId, 'Clock drift');
        }
        return T2;
      },
    });
    const renameId = renameStore.createConversation({
      projectId: PROJECT_ID,
      select: false,
    });
    renameTargetId = renameId;
    const renamedState = renameStore.getState();
    const renamedConversation = renamedState.conversations[renameId]!;
    renameReentry = true;
    expect(
      snapshotFreeStore(renameStore).applySnapshotFreeProjectMutation({
        action: 'unbind',
        conversationId: renameId,
        targetProjectId: null,
        expectedConversation: renamedConversation,
      }),
    ).toBeNull();
    expect(renameStore.getState().conversations[renameId]).toMatchObject({
      projectId: PROJECT_ID,
      title: 'Clock drift',
    });

    const ready = readyProjectStore();
    const directId = ready.store.createConversation({
      projectId: OTHER_PROJECT_ID,
      select: false,
    });
    let journalStore!: ChatStore;
    let journalReentry = true;
    journalStore = createChatStore({
      initialState: ready.store.getState(),
      now: () => {
        if (journalReentry) {
          journalReentry = false;
          expect(beginLifecycle(journalStore, ready.conversationId)).not.toBeNull();
        }
        return T2;
      },
    });
    const directConversation =
      journalStore.getState().conversations[directId]!;
    expect(
      snapshotFreeStore(journalStore).applySnapshotFreeProjectMutation({
        action: 'rebind',
        conversationId: directId,
        targetProjectId: PROJECT_ID,
        expectedConversation: directConversation,
      }),
    ).toBeNull();
    expect(journalStore.getState()).toMatchObject({
      projectContextDestructiveTransition: { phase: 'intent' },
      conversations: {
        [directId]: { projectId: OTHER_PROJECT_ID },
      },
    });
  });

  test('snapshot-free mutation rejects invalid action-target relations atomically', () => {
    const value = setupProjectStore();
    const conversation =
      value.store.getState().conversations[value.conversationId]!;
    const before = value.store.getState();
    for (const input of [
      {
        action: 'unbind',
        conversationId: value.conversationId,
        targetProjectId: OTHER_PROJECT_ID,
        expectedConversation: conversation,
      },
      {
        action: 'delete',
        conversationId: value.conversationId,
        targetProjectId: OTHER_PROJECT_ID,
        expectedConversation: conversation,
      },
      {
        action: 'rebind',
        conversationId: value.conversationId,
        targetProjectId: null,
        expectedConversation: conversation,
      },
      {
        action: 'rebind',
        conversationId: value.conversationId,
        targetProjectId: PROJECT_ID,
        expectedConversation: conversation,
      },
      {
        action: 'rebind',
        conversationId: value.conversationId,
        targetProjectId: '',
        expectedConversation: conversation,
      },
      {
        action: 'raw_action',
        conversationId: value.conversationId,
        targetProjectId: null,
        expectedConversation: conversation,
      },
    ]) {
      expect(
        snapshotFreeStore(value.store).applySnapshotFreeProjectMutation(
          input as never,
        ),
      ).toBeNull();
      expect(value.store.getState()).toBe(before);
    }
  });

  test('begins lifecycle cleanup for a stale snapshot with null runtime and consent', () => {
    const fixture = readyProjectStore();
    expect(
      fixture.store.applyProjectContextAction(fixture.conversationId, {
        type: 'project_changed',
      }),
    ).toBe(true);
    const state = fixture.store.getState();
    const conversation = state.conversations[fixture.conversationId]!;
    const store = createChatStore({
      initialState: {
        ...state,
        conversations: {
          ...state.conversations,
          [fixture.conversationId]: {
            ...conversation,
            runtimeContextId: null,
          },
        },
      },
    });
    const transaction = beginLifecycle(store, fixture.conversationId);
    expect(transaction).not.toBeNull();
    expect(store.getState().projectContextDestructiveTransition).toMatchObject({
      sourceRuntimeContextId: null,
      consentReceiptId: null,
    });
  });

  test('rejects lifecycle ids already used by runtime, turn, attempt, or round', () => {
    const { store, conversationId } = readyProjectStore();
    const other = store.createConversation({ select: false });
    const prepared = store.prepareTurnAttempt(other, 'identity claims')!;
    expect(
      store.startAttemptRound(other, prepared.attemptId, ROUND_ID, 0),
    ).toBe(true);
    for (const claimed of [
      RUNTIME_ID,
      prepared.turnId,
      prepared.attemptId,
      ROUND_ID,
    ]) {
      expect(
        beginLifecycle(
          store,
          conversationId,
          'unbind',
          null,
          claimed,
        ),
      ).toBeNull();
    }
  });

  test('claims the journal lifecycle id against later unrelated runtime, turn, and round generation', () => {
    const fixture = readyProjectStore();
    const preparedConversation = fixture.store.createConversation({
      select: false,
    });
    const prepared = fixture.store.prepareTurnAttempt(
      preparedConversation,
      'prepared before journal',
    )!;
    const boundConversation = fixture.store.createConversation({
      projectId: OTHER_PROJECT_ID,
      select: false,
    });
    const emptyConversation = fixture.store.createConversation({ select: false });
    const begun = beginLifecycle(
      fixture.store,
      fixture.conversationId,
    )!;
    expect(begun.commit()).toBe(true);
    const store = createChatStore({
      initialState: fixture.store.getState(),
      createLifecycleId: () => LIFECYCLE_ID,
    });

    expect(store.ensureRuntimeContextId(boundConversation)).toBeNull();
    expect(
      store.prepareTurnAttempt(emptyConversation, 'must not reuse journal id'),
    ).toBeNull();
    expect(
      store.startAttemptRound(
        preparedConversation,
        prepared.attemptId,
        LIFECYCLE_ID,
        0,
      ),
    ).toBe(false);
    expect(store.getState().projectContextDestructiveTransition).toMatchObject({
      lifecycleId: LIFECYCLE_ID,
      phase: 'intent',
    });
  });

  test('blocks later lifecycle checkpoints when the snapshot gains a reference', () => {
    const { store, conversationId } = readyProjectStore();
    const source = store.getState().conversations[conversationId]!;
    const snapshot = source.projectContext!.snapshot!;
    const consent = source.projectContext!.consent!;
    const begun = beginLifecycle(store, conversationId)!;
    expect(begun.commit()).toBe(true);
    const tombstone = tombstoneLifecycle(
      store,
      begun.lifecycleId,
      begun.epoch,
    )!;
    expect(tombstone.commit()).toBe(true);
    const tombstonedState = store.getState();
    const tombstoned = tombstonedState.conversations[conversationId]!;
    const referencedStore = createChatStore({
      initialState: {
        ...tombstonedState,
        conversations: {
          ...tombstonedState.conversations,
          [conversationId]: {
            ...tombstoned,
            attempts: [
              {
                schemaVersion: 1,
                attemptId: ATTEMPT_ID,
                turnId: TURN_ID,
                status: 'prepared',
                visibleMessageIds: [],
                visibleHistorySha256: null,
                attachmentIds: [],
                modelId: source.modelId,
                thinkingMode: source.thinkingMode,
                contextDisposition: 'verified',
                contextProjectId: source.projectId,
                projectContext: {
                  schemaVersion: 1,
                  runtimeContextId: source.runtimeContextId!,
                  projectId: source.projectId!,
                  snapshotId: snapshot.snapshot_id,
                  snapshotSha256: snapshot.snapshot_sha256,
                  sourceFingerprint: snapshot.source_fingerprint,
                  contextBytes: snapshot.context_bytes,
                  consentReceiptId: consent.consent_receipt_id,
                  provider: 'deepseek',
                  policy: 'chat-read-v1',
                  policyVersion: 'chat-read-v1.0.0',
                },
                activeRound: null,
                rounds: [],
                assistantMessageId: null,
                failureCode: null,
                createdAt: T3,
                updatedAt: T3,
              },
            ],
          },
        },
      },
    });
    const beforeAdvance = referencedStore.getState();
    expect(
      cleanupLifecycle(
        referencedStore,
        begun.lifecycleId,
        begun.epoch,
      ),
    ).toBeNull();
    expect(referencedStore.getState()).toBe(beforeAdvance);
  });

  test('rejects finalize after a new context or owner drift and consumes raced rollback once', () => {
    const { store, conversationId } = readyProjectStore();
    const ready = advanceLifecycleToReady(store, conversationId);
    const readyState = store.getState();
    const tombstoned = readyState.conversations[conversationId]!;
    const sourceContext = readyProjectStore().store.getState().conversations[
      conversationId
    ]!.projectContext!;
    for (const patch of [
      { projectContext: sourceContext },
      { modelId: 'deepseek-v4-pro' as const },
      { runtimeContextId: OTHER_PROJECT_ID },
      { projectId: OTHER_PROJECT_ID },
    ]) {
      const drifted = createChatStore({
        initialState: {
          ...readyState,
          conversations: {
            ...readyState.conversations,
            [conversationId]: { ...tombstoned, ...patch },
          },
        },
      });
      expect(
        finalizeLifecycle(
          drifted,
          ready.lifecycleId,
          ready.epoch,
        ),
      ).toBeNull();
    }

    const beginFixture = readyProjectStore();
    const transaction = beginLifecycle(
      beginFixture.store,
      beginFixture.conversationId,
    )!;
    const serialized = JSON.parse(beginFixture.store.serialize()) as {
      conversations: Array<Record<string, unknown>>;
      project_context_destructive_transition: Record<string, unknown>;
    };
    serialized.conversations[0]!.title = 'Raced title';
    serialized.conversations[0]!.updated_at = T3;
    serialized.project_context_destructive_transition.created_at = T3;
    serialized.project_context_destructive_transition.updated_at = T3;
    beginFixture.store.hydrate(serialized);
    expect(transaction.rollback()).toBe(false);
    expect(transaction.commit()).toBe(false);
  });

  test('active delete rollback restores target and journal while preserving listener selection', () => {
    const fixture = readyProjectStore();
    const fallback = fixture.store.createConversation({
      title: 'Fallback',
      select: false,
    });
    const listenerSelection = fixture.store.createConversation({
      title: 'Listener selection',
      select: false,
    });
    fixture.store.selectConversation(fixture.conversationId);
    const ready = advanceLifecycleToReady(
      fixture.store,
      fixture.conversationId,
      'delete',
    );
    let reentered = false;
    fixture.store.subscribe(state => {
      if (
        !reentered &&
        state.projectContextDestructiveTransition === null &&
        state.conversations[fixture.conversationId] === undefined
      ) {
        reentered = true;
        fixture.store.selectConversation(listenerSelection);
      }
    });

    const finalize = finalizeLifecycle(
      fixture.store,
      ready.lifecycleId,
      ready.epoch,
    )!;
    expect(finalize).not.toBeNull();
    expect(fixture.store.getState().selectedConversationId).toBe(
      listenerSelection,
    );
    expect(fixture.store.getState().selectedConversationId).not.toBe(fallback);
    expect(finalize.rollback()).toBe(true);
    expect(fixture.store.getState()).toMatchObject({
      projectContextDestructiveTransition: { phase: 'ready_to_finalize' },
      selectedConversationId: listenerSelection,
      conversations: {
        [fixture.conversationId]: { projectId: PROJECT_ID },
      },
    });
  });

  test('rejects a semantically valid action or target drift before finalize', () => {
    const fixture = readyProjectStore();
    const ready = advanceLifecycleToReady(
      fixture.store,
      fixture.conversationId,
    );
    const readyState = fixture.store.getState();
    const original = readyState.projectContextDestructiveTransition!;
    const actionDrift = createChatStore({
      initialState: {
        ...readyState,
        projectContextDestructiveTransition: {
          ...original,
          action: 'delete',
        },
      },
    });
    const beforeAction = actionDrift.getState();
    expect(
      finalizeLifecycle(
        actionDrift,
        ready.lifecycleId,
        ready.epoch,
        original,
      ),
    ).toBeNull();
    expect(actionDrift.getState()).toBe(beforeAction);

    const rebindFixture = readyProjectStore();
    const rebindReady = advanceLifecycleToReady(
      rebindFixture.store,
      rebindFixture.conversationId,
      'rebind',
      OTHER_PROJECT_ID,
    );
    const rebindState = rebindFixture.store.getState();
    const rebindOriginal = rebindState.projectContextDestructiveTransition!;
    const targetDrift = createChatStore({
      initialState: {
        ...rebindState,
        projectContextDestructiveTransition: {
          ...rebindOriginal,
          targetProjectId: 'project-three',
        },
      },
    });
    const beforeTarget = targetDrift.getState();
    expect(
      finalizeLifecycle(
        targetDrift,
        rebindReady.lifecycleId,
        rebindReady.epoch,
        rebindOriginal,
      ),
    ).toBeNull();
    expect(targetDrift.getState()).toBe(beforeTarget);
  });

  test('rejects hostile destructive begin input and owner records without evaluating accessors', () => {
    const { store, conversationId } = readyProjectStore();
    const conversation = store.getState().conversations[conversationId]!;
    const validOwner = {
      conversationId,
      projectId: conversation.projectId!,
      runtimeContextId: conversation.runtimeContextId,
      modelId: conversation.modelId,
      expectedUpdatedAt: conversation.updatedAt,
      expectedContext: conversation.projectContext!,
    };
    let getterCalls = 0;
    const getterInput = {
      lifecycleId: LIFECYCLE_ID,
      action: 'unbind' as const,
      targetProjectId: null,
    } as Record<string, unknown>;
    Object.defineProperty(getterInput, 'owner', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return validOwner;
      },
    });
    expect(
      lifecycleStore(store).beginProjectContextDestructiveTransition(
        getterInput as never,
      ),
    ).toBeNull();
    expect(getterCalls).toBe(0);

    for (const hostile of [
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error('RAW_PROXY_PROTOTYPE');
          },
        },
      ),
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('RAW_PROXY_KEYS');
          },
        },
      ),
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => {
            throw new Error('RAW_PROXY_DESCRIPTOR');
          },
        },
      ),
    ]) {
      expect(() =>
        lifecycleStore(store).beginProjectContextDestructiveTransition(
          hostile as never,
        ),
      ).not.toThrow();
      expect(
        lifecycleStore(store).beginProjectContextDestructiveTransition(
          hostile as never,
        ),
      ).toBeNull();
    }

    const getterOwner = { ...validOwner } as Record<string, unknown>;
    Object.defineProperty(getterOwner, 'expectedContext', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return conversation.projectContext;
      },
    });
    expect(
      lifecycleStore(store).beginProjectContextDestructiveTransition({
        lifecycleId: LIFECYCLE_ID,
        action: 'unbind',
        targetProjectId: null,
        owner: getterOwner as never,
      }),
    ).toBeNull();
    expect(getterCalls).toBe(0);

    for (const mutate of [
      (input: Record<string, unknown>) => {
        input.extra = true;
      },
      (input: Record<string, unknown>) => {
        Object.defineProperty(input, Symbol('raw'), {
          value: true,
          enumerable: true,
        });
      },
      (input: Record<string, unknown>) => {
        Object.setPrototypeOf(input, { raw: true });
      },
    ]) {
      const input = {
        lifecycleId: LIFECYCLE_ID,
        action: 'unbind',
        targetProjectId: null,
        owner: validOwner,
      } as Record<string, unknown>;
      mutate(input);
      expect(
        lifecycleStore(store).beginProjectContextDestructiveTransition(
          input as never,
        ),
      ).toBeNull();
    }
    expect(store.getState().projectContextDestructiveTransition).toBeNull();
  });

  test('fails closed when begin sees a malformed in-memory project context', () => {
    const corruptions: Array<(context: Record<string, unknown>) => void> = [
      context => {
        const snapshot = context.snapshot as Record<string, unknown>;
        snapshot.project_id = OTHER_PROJECT_ID;
      },
      context => {
        const consent = context.consent as Record<string, unknown>;
        consent.snapshot_sha256 = 'f'.repeat(64);
      },
      context => {
        let calls = 0;
        Object.defineProperty(context, 'selectedPaths', {
          enumerable: true,
          get: () => {
            calls += 1;
            throw new Error(`RAW_CONTEXT_GETTER_${calls}`);
          },
        });
      },
    ];
    corruptions.forEach(corrupt => {
      const fixture = readyProjectStore();
      const state = fixture.store.getState();
      const conversation = state.conversations[fixture.conversationId]!;
      const context = {
        ...conversation.projectContext!,
        snapshot: { ...conversation.projectContext!.snapshot! },
        consent: { ...conversation.projectContext!.consent! },
        selectedPaths: [...conversation.projectContext!.selectedPaths],
      } as Record<string, unknown>;
      corrupt(context);
      const corruptStore = createChatStore({
        initialState: {
          ...state,
          conversations: {
            ...state.conversations,
            [fixture.conversationId]: {
              ...conversation,
              projectContext: context,
            },
          },
        } as ChatState,
      });
      expect(
        beginLifecycle(corruptStore, fixture.conversationId),
      ).toBeNull();
      expect(corruptStore.getState().projectContextDestructiveTransition).toBeNull();
    });
  });

  function schema3Receipt(
    prepared: { turnId: string; attemptId: string },
  ): CompletionRoundReceiptV1 {
    return {
      ...schema2Receipt(prepared),
      transportSchemaVersion: 3,
      providerRequestId: '66666666-6666-4666-8666-666666666666',
      projectContextReceipt: {
        schema_version: 1,
        snapshot_id: SNAPSHOT_ID,
        snapshot_sha256: contextManifest.snapshot_sha256,
        source_fingerprint: contextManifest.source_fingerprint,
        context_bytes: contextManifest.context_bytes,
        verified_at: T2,
      },
    };
  }

  test('migrates old bound chats without rewriting ids or inventing attempts', () => {
    const legacy = JSON.parse(
      serializeChatState(
        chatReducer(createEmptyChatState(), {
          type: 'conversation/create',
          payload: { id: 'legacy-chat', at: T0, projectId: 'project-a' },
        }),
      ),
    ) as Record<string, unknown>;
    legacy.schema_version = 5;
    const conversations = legacy.conversations as Array<Record<string, unknown>>;
    conversations.forEach(row => {
      delete row.runtime_context_id;
      delete row.project_context;
      delete row.turns;
      delete row.attempts;
    });

    const migrated = hydrateChatState(legacy);
    const conversation = migrated.conversations['legacy-chat'];
    expect(migrated.schemaVersion).toBe(CHAT_STATE_SCHEMA_VERSION);
    expect(migrated).toMatchObject({
      projectContextDestructiveEpoch: 0,
      projectContextDestructiveTransition: null,
    });
    expect(conversation?.id).toBe('legacy-chat');
    expect(conversation?.runtimeContextId).toBeNull();
    expect(conversation?.projectContext).toMatchObject({
      projectId: 'project-a',
      status: 'setup_required',
    });
    expect(conversation?.turns).toEqual([]);
    expect(conversation?.attempts).toEqual([]);
  });

  test.each([3, 4, 5])(
    'migrates schema v%s bound chats to setup required',
    schemaVersion => {
      const legacy = JSON.parse(
        serializeChatState(
          chatReducer(createEmptyChatState(), {
            type: 'conversation/create',
            payload: { id: 'legacy-chat', at: T0, projectId: 'project-a' },
          }),
        ),
      ) as {
        schema_version: number;
        conversations: Array<Record<string, unknown>>;
      };
      legacy.schema_version = schemaVersion;
      if (schemaVersion < 5) {
        legacy.conversations.forEach(row => delete row.workspace_id);
      }
      const migrated = hydrateChatState(legacy);
      expect(migrated.conversations['legacy-chat']).toMatchObject({
        runtimeContextId: null,
        projectContext: {
          projectId: 'project-a',
          status: 'setup_required',
        },
        turns: [],
        attempts: [],
      });
    },
  );

  test('late-allocates one canonical runtime context id atomically', () => {
    const store = v6Store();
    const conversationId = store.createConversation({ projectId: 'project-a' });
    expect(store.getState().conversations[conversationId]?.runtimeContextId).toBeNull();
    expect(store.ensureRuntimeContextId(conversationId)).toBe(RUNTIME_ID);
    expect(store.ensureRuntimeContextId(conversationId)).toBe(RUNTIME_ID);
    expect(store.getState().conversations[conversationId]?.runtimeContextId).toBe(
      RUNTIME_ID,
    );
  });

  test('requires an explicit durable disposition to bypass project context', () => {
    const store = v6Store();
    const conversationId = store.createConversation({ projectId: 'project-a' });
    const before = store.getState();
    expect(store.prepareTurnAttempt(conversationId, 'default blocked')).toBeNull();
    expect(store.getState()).toBe(before);

    const explicit = store.prepareTurnAttempt(
      conversationId,
      'explicit local-only context bypass',
      { sendWithoutProjectContext: true },
    );
    expect(explicit).not.toBeNull();
    expect(
      store.getState().conversations[conversationId]?.attempts[0],
    ).toMatchObject({
      contextDisposition: 'explicit_without_context',
      contextProjectId: 'project-a',
      projectContext: null,
    });
    const serialized = store.serialize();
    expect(serialized).toContain(
      '"context_disposition":"explicit_without_context"',
    );
    expect(hydrateChatState(serialized)).toEqual(store.getState());
    store.startAttemptRound(
      conversationId,
      explicit!.attemptId,
      ROUND_ID,
      0,
    );
    expect(
      store.recordAttemptRound(
        conversationId,
        explicit!.attemptId,
        schema2Receipt(explicit!),
      ),
    ).toBe(true);
  });

  test('honors explicit without-context when verified context is ready', () => {
    const { store, conversationId } = readyProjectStore();
    const explicit = store.prepareTurnAttempt(
      conversationId,
      'do not send verified project context',
      { sendWithoutProjectContext: true },
    );
    expect(explicit).not.toBeNull();
    expect(
      store.getState().conversations[conversationId]?.attempts[0],
    ).toMatchObject({
      contextDisposition: 'explicit_without_context',
      contextProjectId: PROJECT_ID,
      projectContext: null,
    });
  });

  test('atomically prepares a user turn from ordered visible message ids', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const prepared = store.prepareTurnAttempt(conversationId, 'hello');
    expect(prepared).toMatchObject({ turnId: RUNTIME_ID, attemptId: TURN_ID });
    const conversation = store.getState().conversations[conversationId]!;
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.turns[0]).toMatchObject({
      turnId: RUNTIME_ID,
      userMessageId: prepared?.userMessageId,
      attemptIds: [TURN_ID],
    });
    expect(conversation.attempts[0]).toMatchObject({
      attemptId: TURN_ID,
      turnId: RUNTIME_ID,
      status: 'prepared',
      visibleMessageIds: [prepared?.userMessageId],
      visibleHistorySha256: null,
      contextDisposition: 'unbound',
      contextProjectId: null,
      rounds: [],
    });
  });

  test('freezes and round-trips the exact legal user text for a prepared attempt', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const prepared = store.prepareTurnAttempt(
      conversationId,
      '  exact prepared text  ',
    );

    expect(prepared).not.toBeNull();
    expect(
      store.getState().conversations[conversationId]?.messages.at(-1)?.text,
    ).toBe('  exact prepared text  ');
    expect(
      hydrateChatState(store.serialize()).conversations[conversationId]?.messages.at(
        -1,
      )?.text,
    ).toBe('  exact prepared text  ');
  });

  test('bounds prepared raw text and keeps attachment title fallback', () => {
    const boundary = `x${' '.repeat(MAX_CHAT_MESSAGE_LENGTH - 1)}`;
    const acceptedStore = v6Store();
    const acceptedConversation = acceptedStore.createConversation();
    expect(
      acceptedStore.prepareTurnAttempt(acceptedConversation, boundary),
    ).not.toBeNull();
    expect(
      hydrateChatState(acceptedStore.serialize()).conversations[
        acceptedConversation
      ]?.messages.at(-1)?.text,
    ).toBe(boundary);

    const rejectedStore = v6Store();
    const rejectedConversation = rejectedStore.createConversation();
    expect(
      rejectedStore.prepareTurnAttempt(rejectedConversation, `${boundary} `),
    ).toBeNull();
    expect(
      rejectedStore.getState().conversations[rejectedConversation]?.messages,
    ).toHaveLength(0);

    const attachmentStore = v6Store();
    const attachmentConversation = attachmentStore.createConversation();
    expect(
      attachmentStore.prepareTurnAttempt(attachmentConversation, ' \n\t ', {
        attachments: [IMAGE_ATTACHMENT],
      }),
    ).not.toBeNull();
    expect(
      attachmentStore.getState().conversations[attachmentConversation]?.title,
    ).toBe('receipt.png');
  });

  test('freezes only the last 200 contiguous visible messages', () => {
    let ordinary = 0;
    const lifecycleIds = [TURN_ID, ATTEMPT_ID];
    const store = createChatStore({
      now: () => T1,
      createId: kind => `${kind}-${++ordinary}`,
      createLifecycleId: () => lifecycleIds.shift() ?? RETRY_ID,
    });
    const conversationId = store.createConversation();
    for (let index = 0; index < 205; index += 1) {
      store.appendUserMessage(conversationId, `history ${index}`);
    }
    const prepared = store.prepareTurnAttempt(conversationId, 'current')!;
    const conversation = store.getState().conversations[conversationId]!;
    const attempt = conversation.attempts[0]!;
    expect(attempt.visibleMessageIds).toHaveLength(200);
    expect(attempt.visibleMessageIds).toEqual(
      conversation.messages.slice(-200).map(message => message.id),
    );
    expect(attempt.visibleMessageIds.at(-1)).toBe(prepared.userMessageId);
  });

  test('retains visible-window attachments in first-seen order', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    store.appendUserMessage(conversationId, 'with image', {
      attachments: [IMAGE_ATTACHMENT],
    });
    const prepared = store.prepareTurnAttempt(conversationId, 'current')!;
    const attempt = store
      .getState()
      .conversations[conversationId]?.attempts.find(
        item => item.attemptId === prepared.attemptId,
      );
    expect(attempt?.attachmentIds).toEqual([IMAGE_ATTACHMENT.id]);
  });

  test('caps attachment references before retention-id deduplication', () => {
    for (const [historyCount, accepted] of [
      [24, true],
      [25, false],
    ] as const) {
      const store = v6Store();
      const conversationId = store.createConversation();
      for (let index = 0; index < historyCount; index += 1) {
        store.appendUserMessage(conversationId, `attachment ${index}`, {
          attachments: [IMAGE_ATTACHMENT],
        });
      }
      const prepared = store.prepareTurnAttempt(conversationId, 'current');
      expect(prepared !== null).toBe(accepted);
      if (prepared !== null) {
        expect(
          store.getState().conversations[conversationId]?.attempts[0]
            ?.attachmentIds,
        ).toEqual([IMAGE_ATTACHMENT.id]);
      }
    }
  });

  test('downgrades persisted sending to interrupted and retries with a new attempt', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const prepared = store.prepareTurnAttempt(conversationId, 'retry me')!;
    expect(store.startAttemptRound(conversationId, prepared.attemptId, ROUND_ID, 0)).toBe(
      true,
    );
    const hydrated = hydrateChatState(store.serialize());
    expect(hydrated.conversations[conversationId]?.attempts[0]).toMatchObject({
      status: 'failed',
      activeRound: null,
      failureCode: 'E_ATTEMPT_INTERRUPTED',
    });

    const resumed = createChatStore({
      initialState: hydrated,
      now: () => T2,
      createLifecycleId: () => RETRY_ID,
    });
    resumed.setModel(conversationId, 'deepseek-v4-pro');
    resumed.setThinkingMode(conversationId, 'max');
    const retry = resumed.retryAttempt(conversationId, prepared.attemptId);
    expect(retry?.turnId).toBe(prepared.turnId);
    expect(retry?.attemptId).toBe(RETRY_ID);
    expect(resumed.getState().conversations[conversationId]?.turns[0]?.attemptIds).toEqual([
      prepared.attemptId,
      RETRY_ID,
    ]);
    expect(
      resumed.getState().conversations[conversationId]?.attempts[1],
    ).toMatchObject({
      modelId: 'deepseek-v4-flash',
      thinkingMode: 'high',
      visibleHistorySha256: null,
      rounds: [],
    });
  });

  test('persists exact schema3 round receipt metadata without raw context', () => {
    const { store, conversationId } = readyProjectStore();
    const prepared = store.prepareTurnAttempt(conversationId, 'context')!;
    store.startAttemptRound(conversationId, prepared.attemptId, ROUND_ID, 0);
    expect(
      store.recordAttemptRound(conversationId, prepared.attemptId, {
        schemaVersion: 1,
        transportSchemaVersion: 3,
        turnId: prepared.turnId,
        attemptId: prepared.attemptId,
        roundId: ROUND_ID,
        roundIndex: 0,
        providerRequestId: '66666666-6666-4666-8666-666666666666',
        providerResponseId: 'resp_1',
        requestedModel: 'deepseek-v4-flash',
        model: 'deepseek-v4-flash',
        thinkingMode: 'high',
        finishReason: 'stop',
        latencyMs: 10,
        visibleHistorySha256: 'a'.repeat(64),
        modelInputSha256: 'b'.repeat(64),
        requestBodySha256: 'c'.repeat(64),
        projectContextReceipt: {
          schema_version: 1,
          snapshot_id: SNAPSHOT_ID,
          snapshot_sha256: 'd'.repeat(64),
          source_fingerprint: 'e'.repeat(64),
          context_bytes: 10,
          verified_at: T2,
        },
      }),
    ).toBe(true);
    const serialized = store.serialize();
    expect(serialized).toContain('visible_history_sha256');
    expect(serialized).not.toContain('raw_content');
    expect(serialized).not.toContain('source_descriptor');
  });

  test('freezes a confirmed context binding and rejects correlation mismatch', () => {
    const { store, conversationId } = readyProjectStore();
    const prepared = store.prepareTurnAttempt(conversationId, 'frozen')!;
    const attempt =
      store.getState().conversations[conversationId]?.attempts[0];
    expect(attempt?.projectContext).toEqual({
      schemaVersion: 1,
      runtimeContextId: RUNTIME_ID,
      projectId: PROJECT_ID,
      snapshotId: SNAPSHOT_ID,
      snapshotSha256: 'd'.repeat(64),
      sourceFingerprint: 'e'.repeat(64),
      contextBytes: 10,
      consentReceiptId: CONSENT_ID,
      provider: 'deepseek',
      policy: 'chat-read-v1',
      policyVersion: 'chat-read-v1.0.0',
    });
    expect(attempt?.contextDisposition).toBe('verified');
    expect(attempt?.contextProjectId).toBe(PROJECT_ID);
    expect(
      store.startAttemptRound(
        conversationId,
        prepared.attemptId,
        ROUND_ID,
        0,
      ),
    ).toBe(true);
    const before = store.getState();
    expect(
      store.recordAttemptRound(conversationId, prepared.attemptId, {
        schemaVersion: 1,
        transportSchemaVersion: 3,
        turnId: '99999999-9999-4999-8999-999999999999',
        attemptId: prepared.attemptId,
        roundId: ROUND_ID,
        roundIndex: 0,
        providerRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        providerResponseId: 'resp_1',
        requestedModel: 'deepseek-v4-flash',
        model: 'deepseek-v4-flash',
        thinkingMode: 'high',
        finishReason: 'stop',
        latencyMs: 1,
        visibleHistorySha256: 'a'.repeat(64),
        modelInputSha256: 'b'.repeat(64),
        requestBodySha256: 'c'.repeat(64),
        projectContextReceipt: {
          schema_version: 1,
          snapshot_id: SNAPSHOT_ID,
          snapshot_sha256: 'd'.repeat(64),
          source_fingerprint: 'e'.repeat(64),
          context_bytes: 10,
          verified_at: T2,
        },
      }),
    ).toBe(false);
    expect(store.getState()).toBe(before);
  });

  test('rejects extra or accessor-backed round receipt fields atomically', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const prepared = store.prepareTurnAttempt(conversationId, 'receipt')!;
    store.startAttemptRound(conversationId, prepared.attemptId, ROUND_ID, 0);
    const before = store.getState();
    expect(
      store.recordAttemptRound(
        conversationId,
        prepared.attemptId,
        {
          ...schema2Receipt(prepared),
          raw_content: 'UNIQUE_RECEIPT_SECRET',
        } as CompletionRoundReceiptV1,
      ),
    ).toBe(false);
    expect(store.getState()).toBe(before);

    const { store: verified, conversationId: verifiedId } =
      readyProjectStore();
    const verifiedAttempt = verified.prepareTurnAttempt(
      verifiedId,
      'verified receipt',
    )!;
    verified.startAttemptRound(
      verifiedId,
      verifiedAttempt.attemptId,
      ROUND_ID,
      0,
    );
    const contextReceipt: Record<string, unknown> = {
      schema_version: 1,
      snapshot_id: SNAPSHOT_ID,
      snapshot_sha256: 'd'.repeat(64),
      source_fingerprint: 'e'.repeat(64),
      context_bytes: 10,
      verified_at: T2,
    };
    const getter = jest.fn(() => {
      throw new Error('RECEIPT_GETTER_SENTINEL');
    });
    Object.defineProperty(contextReceipt, 'raw_content', {
      enumerable: true,
      get: getter,
    });
    const verifiedBefore = verified.getState();
    expect(
      verified.recordAttemptRound(verifiedId, verifiedAttempt.attemptId, {
        ...schema2Receipt(verifiedAttempt),
        transportSchemaVersion: 3,
        projectContextReceipt:
          contextReceipt as CompletionRoundReceiptV1['projectContextReceipt'],
      }),
    ).toBe(false);
    expect(verified.getState()).toBe(verifiedBefore);
    expect(getter).not.toHaveBeenCalled();
  });

  test('rejects an active round with extra fields atomically', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const prepared = store.prepareTurnAttempt(conversationId, 'round')!;
    const before = store.getState();
    store.dispatch({
      type: 'attempt/start-round',
      payload: {
        conversationId,
        attemptId: prepared.attemptId,
        round: {
          roundId: ROUND_ID,
          roundIndex: 0,
          raw_content: 'UNIQUE_ROUND_SECRET',
        } as { roundId: string; roundIndex: number },
        at: T2,
      },
    });
    expect(store.getState()).toBe(before);
  });

  test('rejects a verified receipt that disagrees with frozen source metadata', () => {
    for (const override of [
      { source_fingerprint: 'f'.repeat(64) },
      { context_bytes: 11 },
    ]) {
      const { store, conversationId } = readyProjectStore();
      const prepared = store.prepareTurnAttempt(conversationId, 'source')!;
      store.startAttemptRound(
        conversationId,
        prepared.attemptId,
        ROUND_ID,
        0,
      );
      const before = store.getState();
      expect(
        store.recordAttemptRound(conversationId, prepared.attemptId, {
          ...schema2Receipt(prepared),
          transportSchemaVersion: 3,
          projectContextReceipt: {
            schema_version: 1,
            snapshot_id: SNAPSHOT_ID,
            snapshot_sha256: 'd'.repeat(64),
            source_fingerprint: 'e'.repeat(64),
            context_bytes: 10,
            verified_at: T2,
            ...override,
          },
        }),
      ).toBe(false);
      expect(store.getState()).toBe(before);
    }
  });

  test('does not revive a verified retry after project unbind and rebind', () => {
    const { store, conversationId } = readyProjectStore();
    const prepared = store.prepareTurnAttempt(conversationId, 'rebind')!;
    expect(
      store.failAttempt(
        conversationId,
        prepared.attemptId,
        'E_COMPLETION_TRANSPORT',
      ),
    ).toBe(true);
    store.appendUserMessage(conversationId, 'advance visible history');
    const ready = advanceLifecycleToReady(
      store,
      conversationId,
      'rebind',
      OTHER_PROJECT_ID,
    );
    expect(
      finalizeLifecycle(store, ready.lifecycleId, ready.epoch)
        ?.commit(),
    ).toBe(true);
    store.bindConversationToProject(conversationId, PROJECT_ID);
    const before = store.getState();
    expect(store.retryAttempt(conversationId, prepared.attemptId)).toBeNull();
    expect(store.getState()).toBe(before);
  });

  test('strictly validates persisted v6 project context metadata', () => {
    const { store } = readyProjectStore();
    const baseline = JSON.parse(store.serialize()) as {
      conversations: Array<{
        project_id: string;
        project_context: {
          project_id: string;
          selected_paths: string[];
          manifest: Record<string, unknown>;
          consent: Record<string, unknown>;
        };
      }>;
    };

    const mutations: Array<
      (conversation: (typeof baseline.conversations)[number]) => void
    > = [
      row => {
        row.project_context.manifest.snapshot_id = 'snapshot-1';
        row.project_context.consent.snapshot_id = 'snapshot-1';
      },
      row => {
        row.project_context.consent.consent_receipt_id = 'consent-1';
      },
      row => {
        row.project_context.selected_paths = ['../secret'];
      },
      row => {
        row.project_context.selected_paths = Array.from(
          { length: 5001 },
          (_, index) => `src/file-${index}.ts`,
        );
      },
      row => {
        row.project_context.selected_paths = ['z.ts', 'a.ts'];
      },
      row => {
        row.project_context.manifest.project_name = '/private/raw-path';
      },
      row => {
        row.project_context.manifest.branch = '@';
      },
      row => {
        row.project_context.manifest.conflicted = true;
      },
      row => {
        row.project_context.manifest.policy_version = 'chat-read-v1';
      },
      row => {
        row.project_context.manifest.context_bytes = 0;
      },
      row => {
        row.project_context.manifest.estimated_tokens = 4;
      },
      row => {
        const included = row.project_context.manifest.included as Array<
          Record<string, unknown>
        >;
        included[0]!.path = '../README.md';
      },
      row => {
        const included = row.project_context.manifest.included as Array<
          Record<string, unknown>
        >;
        const base = included[0]!;
        row.project_context.manifest.included = Array.from(
          { length: 33 },
          (_, index) => ({ ...base, path: `src/file-${index}.ts` }),
        );
      },
      row => {
        row.project_context.manifest.omitted = [
          { path: '.env', reason: 'secret_path' },
          { path: '.env', reason: 'secret_path' },
        ];
      },
      row => {
        row.project_context.consent.confirmed_at = T0;
      },
      row => {
        row.project_id = 'project-a';
        row.project_context.project_id = 'project-a';
        row.project_context.manifest.project_id = 'project-a';
      },
    ];

    for (const mutate of mutations) {
      const payload = JSON.parse(JSON.stringify(baseline)) as typeof baseline;
      mutate(payload.conversations[0]!);
      expect(() => hydrateChatState(payload)).toThrow(
        ChatStateValidationError,
      );
    }
  });

  test('prepares atomically and refuses malformed generated identity', () => {
    const store = createChatStore({
      now: () => T1,
      createId: () => 'message-1',
      createLifecycleId: kind =>
        kind === 'turn' ? 'not-a-uuid' : ATTEMPT_ID,
    });
    const conversationId = store.createConversation();
    const before = store.getState();
    expect(store.prepareTurnAttempt(conversationId, 'hello')).toBeNull();
    expect(store.getState()).toBe(before);
    expect(store.getState().conversations[conversationId]?.messages).toEqual(
      [],
    );
  });

  test('rejects a turn and attempt generated with the same lifecycle id', () => {
    const store = createChatStore({
      now: () => T1,
      createId: kind => `${kind}-1`,
      createLifecycleId: () => TURN_ID,
    });
    const conversationId = store.createConversation();
    const before = store.getState();
    expect(store.prepareTurnAttempt(conversationId, 'collision')).toBeNull();
    expect(store.getState()).toBe(before);
  });

  test('blocks project rebinding while an attempt is live', () => {
    const unbound = v6Store();
    const unboundId = unbound.createConversation();
    unbound.prepareTurnAttempt(unboundId, 'live');
    const unboundBefore = unbound.getState();
    unbound.bindConversationToProject(unboundId, PROJECT_ID);
    expect(unbound.getState()).toBe(unboundBefore);

    const explicit = v6Store();
    const explicitId = explicit.createConversation({ projectId: PROJECT_ID });
    explicit.prepareTurnAttempt(explicitId, 'live', {
      sendWithoutProjectContext: true,
    });
    const explicitBefore = explicit.getState();
    explicit.unbindConversationFromProject(explicitId);
    expect(explicit.getState()).toBe(explicitBefore);
  });

  test('completes an attempt by atomically storing the assistant reference', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const prepared = store.prepareTurnAttempt(conversationId, 'finish')!;
    store.startAttemptRound(conversationId, prepared.attemptId, ROUND_ID, 0);
    store.recordAttemptRound(conversationId, prepared.attemptId, {
      schemaVersion: 1,
      transportSchemaVersion: 2,
      turnId: prepared.turnId,
      attemptId: prepared.attemptId,
      roundId: ROUND_ID,
      roundIndex: 0,
      providerRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      providerResponseId: 'resp_1',
      requestedModel: 'deepseek-v4-flash',
      model: 'deepseek-v4-flash',
      thinkingMode: 'high',
      finishReason: 'stop',
      latencyMs: 1,
      visibleHistorySha256: 'a'.repeat(64),
      modelInputSha256: 'b'.repeat(64),
      requestBodySha256: 'c'.repeat(64),
      projectContextReceipt: null,
    });
    const messageId = store.completeAttempt(
      conversationId,
      prepared.attemptId,
      'done',
      {
        metadata: {
          modelId: 'deepseek-v4-flash',
          latencyMs: 1,
          finishReason: 'stop',
          reasoning: 'real reasoning',
        },
      },
    );
    expect(messageId).toBe('message-3');
    expect(
      store.getState().conversations[conversationId]?.attempts[0],
    ).toMatchObject({
      status: 'completed',
      assistantMessageId: 'message-3',
      failureCode: null,
    });
    expect(
      store.getState().conversations[conversationId]?.messages.at(-1),
    ).toMatchObject({ id: 'message-3', role: 'assistant', text: 'done' });
  });

  test('rejects completion metadata that does not match the terminal receipt', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const prepared = store.prepareTurnAttempt(conversationId, 'metadata')!;
    store.startAttemptRound(conversationId, prepared.attemptId, ROUND_ID, 0);
    store.recordAttemptRound(
      conversationId,
      prepared.attemptId,
      schema2Receipt(prepared),
    );

    for (const metadata of [
      undefined,
      {
        modelId: 'deepseek-v4-pro' as const,
        latencyMs: 1,
        finishReason: 'stop',
      },
      {
        modelId: 'deepseek-v4-flash' as const,
        latencyMs: 2,
        finishReason: 'stop',
      },
      {
        modelId: 'deepseek-v4-flash' as const,
        latencyMs: 1,
        finishReason: 'length',
      },
    ]) {
      const before = store.getState();
      expect(
        store.completeAttempt(
          conversationId,
          prepared.attemptId,
          'must stay atomic',
          metadata === undefined ? {} : { metadata },
        ),
      ).toBeNull();
      expect(store.getState()).toBe(before);
    }
  });

  test('allows one completed attempt and one assistant reference per turn', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const prepared = store.prepareTurnAttempt(conversationId, 'complete')!;
    store.startAttemptRound(conversationId, prepared.attemptId, ROUND_ID, 0);
    store.recordAttemptRound(
      conversationId,
      prepared.attemptId,
      schema2Receipt(prepared),
    );
    store.completeAttempt(conversationId, prepared.attemptId, 'done', {
      metadata: {
        modelId: 'deepseek-v4-flash',
        latencyMs: 1,
        finishReason: 'stop',
      },
    });
    const payload = JSON.parse(store.serialize()) as {
      conversations: Array<{
        turns: Array<{ attempt_ids: string[] }>;
        attempts: Array<{
          attempt_id: string;
          rounds: Array<{
            attempt_id: string;
            round_id: string;
            provider_request_id: string;
            provider_response_id: string;
          }>;
        }>;
      }>;
    };
    const conversation = payload.conversations[0]!;
    const duplicate = JSON.parse(
      JSON.stringify(conversation.attempts[0]),
    ) as (typeof conversation.attempts)[number];
    duplicate.attempt_id = '77777777-7777-4777-8777-777777777777';
    duplicate.rounds[0]!.attempt_id = duplicate.attempt_id;
    duplicate.rounds[0]!.round_id =
      '66666666-6666-4666-8666-666666666666';
    duplicate.rounds[0]!.provider_request_id =
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    duplicate.rounds[0]!.provider_response_id = 'resp_2';
    conversation.turns[0]!.attempt_ids.push(duplicate.attempt_id);
    conversation.attempts.push(duplicate);
    expect(() => hydrateChatState(payload)).toThrow(
      ChatStateValidationError,
    );
  });

  test('requires a completed assistant message after its user turn', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const olderAssistantId = store.appendAssistantMessage(
      conversationId,
      'older',
      {
        metadata: {
          modelId: 'deepseek-v4-flash',
          latencyMs: 1,
          finishReason: 'stop',
        },
      },
    );
    const prepared = store.prepareTurnAttempt(conversationId, 'current')!;
    store.startAttemptRound(conversationId, prepared.attemptId, ROUND_ID, 0);
    store.recordAttemptRound(
      conversationId,
      prepared.attemptId,
      schema2Receipt(prepared),
    );
    const payload = JSON.parse(store.serialize()) as {
      conversations: Array<{
        attempts: Array<{
          status: string;
          assistant_message_id: string | null;
        }>;
      }>;
    };
    const attempt = payload.conversations[0]!.attempts[0]!;
    attempt.status = 'completed';
    attempt.assistant_message_id = olderAssistantId;
    expect(() => hydrateChatState(payload)).toThrow(
      ChatStateValidationError,
    );
  });

  test('persists cancellation without manufacturing a failure code', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const prepared = store.prepareTurnAttempt(conversationId, 'cancel')!;
    expect(store.cancelAttempt(conversationId, prepared.attemptId)).toBe(true);
    const attempt = store.getState().conversations[conversationId]?.attempts[0];
    expect(attempt).toMatchObject({
      status: 'cancelled',
      failureCode: null,
      activeRound: null,
    });
    expect(() => hydrateChatState(store.serialize())).not.toThrow();
  });

  test('allows only explicit stable attempt failure codes', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const prepared = store.prepareTurnAttempt(conversationId, 'failure')!;
    const before = store.getState();
    expect(
      store.failAttempt(
        conversationId,
        prepared.attemptId,
        'E_API_KEY_SECRET',
      ),
    ).toBe(false);
    expect(store.getState()).toBe(before);

    expect(
      store.failAttempt(
        conversationId,
        prepared.attemptId,
        'E_COMPLETION_TRANSPORT',
      ),
    ).toBe(true);
    const payload = JSON.parse(store.serialize()) as {
      conversations: Array<{
        attempts: Array<{ failure_code: string | null }>;
      }>;
    };
    payload.conversations[0]!.attempts[0]!.failure_code =
      'E_API_KEY_SECRET';
    expect(() => hydrateChatState(payload)).toThrow(/failure_code/);
  });

  test('rejects zero and over-budget verified context receipt bytes', () => {
    for (const contextBytes of [0, 256 * 1024 + 1]) {
      const { store, conversationId } = readyProjectStore();
      const prepared = store.prepareTurnAttempt(conversationId, 'bytes')!;
      store.startAttemptRound(conversationId, prepared.attemptId, ROUND_ID, 0);
      const before = store.getState();
      expect(
        store.recordAttemptRound(conversationId, prepared.attemptId, {
          ...schema2Receipt(prepared),
          transportSchemaVersion: 3,
          projectContextReceipt: {
            schema_version: 1,
            snapshot_id: SNAPSHOT_ID,
            snapshot_sha256: 'd'.repeat(64),
            source_fingerprint: 'e'.repeat(64),
            context_bytes: contextBytes,
            verified_at: T2,
          },
        }),
      ).toBe(false);
      expect(store.getState()).toBe(before);
    }
  });

  test('accepts verified context receipt byte boundaries', () => {
    for (const contextBytes of [1, 256 * 1024]) {
      const { store, conversationId } = readyProjectStore(contextBytes);
      const prepared = store.prepareTurnAttempt(conversationId, 'bytes')!;
      store.startAttemptRound(conversationId, prepared.attemptId, ROUND_ID, 0);
      expect(
        store.recordAttemptRound(conversationId, prepared.attemptId, {
          ...schema2Receipt(prepared),
          transportSchemaVersion: 3,
          projectContextReceipt: {
            schema_version: 1,
            snapshot_id: SNAPSHOT_ID,
            snapshot_sha256: 'd'.repeat(64),
            source_fingerprint: 'e'.repeat(64),
            context_bytes: contextBytes,
            verified_at: T2,
          },
        }),
      ).toBe(true);
    }
  });

  test('retains a known visible digest when retry resets prior rounds', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const prepared = store.prepareTurnAttempt(conversationId, 'retry rounds')!;
    store.startAttemptRound(conversationId, prepared.attemptId, ROUND_ID, 0);
    store.recordAttemptRound(conversationId, prepared.attemptId, {
      schemaVersion: 1,
      transportSchemaVersion: 2,
      turnId: prepared.turnId,
      attemptId: prepared.attemptId,
      roundId: ROUND_ID,
      roundIndex: 0,
      providerRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      providerResponseId: 'resp_0',
      requestedModel: 'deepseek-v4-flash',
      model: 'deepseek-v4-flash',
      thinkingMode: 'high',
      finishReason: 'tool_calls',
      latencyMs: 1,
      visibleHistorySha256: 'a'.repeat(64),
      modelInputSha256: 'b'.repeat(64),
      requestBodySha256: 'c'.repeat(64),
      projectContextReceipt: null,
    });
    expect(
      store.failAttempt(
        conversationId,
        prepared.attemptId,
        'E_COMPLETION_TRANSPORT',
      ),
    ).toBe(true);
    const retry = store.retryAttempt(conversationId, prepared.attemptId)!;
    const attempt = store
      .getState()
      .conversations[conversationId]?.attempts.find(
        item => item.attemptId === retry.attemptId,
      );
    expect(attempt).toMatchObject({
      visibleHistorySha256: 'a'.repeat(64),
      rounds: [],
    });
    expect(() => hydrateChatState(store.serialize())).not.toThrow();
    const tampered = JSON.parse(store.serialize()) as {
      conversations: Array<{
        attempts: Array<{ model_id: string }>;
      }>;
    };
    tampered.conversations[0]!.attempts[1]!.model_id =
      'deepseek-v4-pro';
    expect(() => hydrateChatState(tampered)).toThrow(
      ChatStateValidationError,
    );

    const droppedDigest = JSON.parse(store.serialize()) as {
      conversations: Array<{
        attempts: Array<{ visible_history_sha256: string | null }>;
      }>;
    };
    droppedDigest.conversations[0]!.attempts[1]!.visible_history_sha256 = null;
    expect(() => hydrateChatState(droppedDigest)).toThrow(
      /visible_history_sha256/,
    );
  });

  test('roundtrips the first known visible digest after an unknown failed attempt', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const first = store.prepareTurnAttempt(conversationId, 'retry before receipt')!;
    expect(first.commit()).toBe(true);
    expect(
      store.startAttemptRound(
        conversationId,
        first.attemptId,
        ROUND_ID,
        0,
      ),
    ).toBe(true);
    expect(
      store.failAttempt(
        conversationId,
        first.attemptId,
        'E_COMPLETION_TRANSPORT',
      ),
    ).toBe(true);
    const retry = store.retryAttempt(conversationId, first.attemptId)!;
    expect(retry.commit()).toBe(true);
    const retryRoundId = '66666666-6666-4666-8666-666666666666';
    expect(
      store.startAttemptRound(
        conversationId,
        retry.attemptId,
        retryRoundId,
        0,
      ),
    ).toBe(true);
    expect(
      store.recordAttemptRound(conversationId, retry.attemptId, {
        ...schema2Receipt(retry),
        roundId: retryRoundId,
        providerRequestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        providerResponseId: 'resp_retry',
      }),
    ).toBe(true);
    expect(
      store.completeAttempt(conversationId, retry.attemptId, 'Recovered', {
        metadata: {
          modelId: 'deepseek-v4-flash',
          latencyMs: 1,
          finishReason: 'stop',
        },
      }),
    ).not.toBeNull();

    expect(
      store.getState().conversations[conversationId]?.attempts.map(attempt =>
        attempt.visibleHistorySha256,
      ),
    ).toEqual([null, 'a'.repeat(64)]);
    const serialized = store.serialize();
    expect(serializeChatState(hydrateChatState(serialized))).toBe(serialized);
  });

  test('rejects a roundful retry with a changed visible-history digest', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const first = store.prepareTurnAttempt(conversationId, 'digest')!;
    store.startAttemptRound(conversationId, first.attemptId, ROUND_ID, 0);
    store.recordAttemptRound(conversationId, first.attemptId, {
      ...schema2Receipt(first),
      finishReason: 'tool_calls',
    });
    store.failAttempt(
      conversationId,
      first.attemptId,
      'E_COMPLETION_TRANSPORT',
    );
    const retry = store.retryAttempt(conversationId, first.attemptId)!;
    const retryRoundId = '66666666-6666-4666-8666-666666666666';
    store.startAttemptRound(
      conversationId,
      retry.attemptId,
      retryRoundId,
      0,
    );
    store.recordAttemptRound(conversationId, retry.attemptId, {
      ...schema2Receipt(retry),
      roundId: retryRoundId,
      providerRequestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      providerResponseId: 'resp_2',
    });
    const payload = JSON.parse(store.serialize()) as {
      conversations: Array<{
        attempts: Array<{
          visible_history_sha256: string | null;
          rounds: Array<{ visible_history_sha256: string }>;
        }>;
      }>;
    };
    const persistedRetry = payload.conversations[0]!.attempts[1]!;
    persistedRetry.visible_history_sha256 = 'f'.repeat(64);
    persistedRetry.rounds[0]!.visible_history_sha256 = 'f'.repeat(64);
    expect(() => hydrateChatState(payload)).toThrow(
      ChatStateValidationError,
    );
  });

  test('copies a recorded receipt instead of retaining mutable caller input', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const prepared = store.prepareTurnAttempt(conversationId, 'copy')!;
    store.startAttemptRound(conversationId, prepared.attemptId, ROUND_ID, 0);
    const receipt = schema2Receipt(prepared);
    expect(
      store.recordAttemptRound(conversationId, prepared.attemptId, receipt),
    ).toBe(true);
    (
      receipt as CompletionRoundReceiptV1 & {
        providerResponseId: string;
      }
    ).providerResponseId = 'mutated';
    expect(
      store.getState().conversations[conversationId]?.attempts[0]?.rounds[0]
        ?.providerResponseId,
    ).toBe('resp_1');
  });

  test('refuses to retry an old failed turn after visible history advances', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const first = store.prepareTurnAttempt(conversationId, 'first')!;
    expect(
      store.failAttempt(
        conversationId,
        first.attemptId,
        'E_COMPLETION_TRANSPORT',
      ),
    ).toBe(true);
    const second = store.prepareTurnAttempt(conversationId, 'second')!;
    expect(
      store.failAttempt(
        conversationId,
        second.attemptId,
        'E_COMPLETION_TRANSPORT',
      ),
    ).toBe(true);
    const before = store.getState();
    expect(store.retryAttempt(conversationId, first.attemptId)).toBeNull();
    expect(store.getState()).toBe(before);
  });

  test('rejects missing, extra, duplicate, and raw v6 attempt fields', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    store.prepareTurnAttempt(conversationId, 'strict');
    const baseline = JSON.parse(store.serialize()) as {
      conversations: Array<Record<string, unknown>>;
    };
    const conversation = baseline.conversations[0]!;

    for (const mutate of [
      (row: Record<string, unknown>) => delete row.runtime_context_id,
      (row: Record<string, unknown>) => {
        row.raw_content = 'UNIQUE_PROJECT_SECRET';
        return true;
      },
      (row: Record<string, unknown>) => {
        const attempts = row.attempts as Array<Record<string, unknown>>;
        attempts[0]!.raw_history = ['UNIQUE_PROJECT_SECRET'];
        return true;
      },
      (row: Record<string, unknown>) => {
        const messages = row.messages as Array<Record<string, unknown>>;
        messages[0]!.raw_content = 'UNIQUE_PROJECT_SECRET';
        return true;
      },
      (row: Record<string, unknown>) => {
        const attempts = row.attempts as Array<Record<string, unknown>>;
        attempts.push({ ...attempts[0]! });
        return true;
      },
      (row: Record<string, unknown>) => {
        const attempts = row.attempts as Array<Record<string, unknown>>;
        attempts[0]!.visible_message_ids = Array.from(
          { length: 201 },
          (_, index) => `message-window-${index}`,
        );
        return true;
      },
      (row: Record<string, unknown>) => {
        const attempts = row.attempts as Array<Record<string, unknown>>;
        attempts[0]!.visible_history_sha256 = 'a'.repeat(64);
        return true;
      },
      (row: Record<string, unknown>) => {
        const attempts = row.attempts as Array<Record<string, unknown>>;
        attempts[0]!.created_at = T2;
        attempts[0]!.updated_at = T2;
        return true;
      },
      (row: Record<string, unknown>) => {
        row.runtime_context_id = 'NOT-A-UUID';
        return true;
      },
    ]) {
      const tampered = JSON.parse(JSON.stringify(baseline)) as {
        conversations: Array<Record<string, unknown>>;
      };
      mutate(tampered.conversations[0]!);
      expect(() => hydrateChatState(tampered)).toThrow(
        ChatStateValidationError,
      );
    }
    expect(JSON.stringify(conversation)).not.toContain(
      'UNIQUE_PROJECT_SECRET',
    );
    const rootExtra = JSON.parse(JSON.stringify(baseline)) as Record<
      string,
      unknown
    >;
    rootExtra.raw_context = 'UNIQUE_PROJECT_SECRET';
    expect(() => hydrateChatState(rootExtra)).toThrow(
      ChatStateValidationError,
    );
  });

  test('reports the global attempt index for a later turn validation failure', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const first = store.prepareTurnAttempt(conversationId, 'first turn')!;
    first.commit();
    store.failAttempt(
      conversationId,
      first.attemptId,
      'E_COMPLETION_TRANSPORT',
    );
    const second = store.prepareTurnAttempt(conversationId, 'second turn')!;
    second.commit();
    const payload = JSON.parse(store.serialize()) as {
      conversations: Array<{
        attempts: Array<{ visible_message_ids: string[] }>;
      }>;
    };
    payload.conversations[0]!.attempts[1]!.visible_message_ids = ['missing'];

    try {
      hydrateChatState(payload);
      throw new Error('expected hydration failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ChatStateValidationError);
      expect((error as ChatStateValidationError).path).toBe(
        '$.conversations[0].attempts[1].visible_message_ids',
      );
    }
  });

  test('rejects accessor-backed v6 fields without evaluating the getter', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    store.prepareTurnAttempt(conversationId, 'hostile');
    const payload = JSON.parse(store.serialize()) as {
      conversations: Array<Record<string, unknown>>;
    };
    const getter = jest.fn(() => {
      throw new Error('UNIQUE_GETTER_SENTINEL');
    });
    Object.defineProperty(payload.conversations[0]!, 'runtime_context_id', {
      enumerable: true,
      configurable: true,
      get: getter,
    });
    const result = safeHydrateChatState(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ChatStateValidationError);
      expect(result.error.message).not.toContain('UNIQUE_GETTER_SENTINEL');
    }
    expect(getter).not.toHaveBeenCalled();
  });

  test('rejects a root schema accessor without evaluating it', () => {
    const payload = JSON.parse(
      serializeChatState(createEmptyChatState()),
    ) as Record<string, unknown>;
    const getter = jest.fn(() => {
      throw new Error('ROOT_SCHEMA_GETTER_SENTINEL');
    });
    Object.defineProperty(payload, 'schema_version', {
      enumerable: true,
      configurable: true,
      get: getter,
    });
    const result = safeHydrateChatState(payload);
    expect(result.ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });

  test('normalizes project-context serialization failures to chat errors', () => {
    const { store, conversationId } = readyProjectStore();
    const state = store.getState();
    const conversation = state.conversations[conversationId]!;
    const unsafe: ChatState = {
      ...state,
      conversations: {
        ...state.conversations,
        [conversationId]: {
          ...conversation,
          projectContext: {
            ...conversation.projectContext!,
            consent: null,
          },
        },
      },
    };
    expect(() => serializeChatState(unsafe)).toThrow(
      ChatStateValidationError,
    );
  });

  test('rejects more than one live attempt after hydration', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const first = store.prepareTurnAttempt(conversationId, 'first')!;
    store.failAttempt(
      conversationId,
      first.attemptId,
      'E_COMPLETION_TRANSPORT',
    );
    const second = store.prepareTurnAttempt(conversationId, 'second')!;
    store.failAttempt(
      conversationId,
      second.attemptId,
      'E_COMPLETION_TRANSPORT',
    );
    const payload = JSON.parse(store.serialize()) as {
      conversations: Array<{
        attempts: Array<{
          status: string;
          failure_code: string | null;
        }>;
      }>;
    };
    payload.conversations[0]!.attempts.forEach(attempt => {
      attempt.status = 'prepared';
      attempt.failure_code = null;
    });
    expect(() => hydrateChatState(payload)).toThrow(
      ChatStateValidationError,
    );
  });

  test('rejects an unreachable nonterminal attempt before a later retry', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const first = store.prepareTurnAttempt(conversationId, 'first')!;
    store.failAttempt(
      conversationId,
      first.attemptId,
      'E_COMPLETION_TRANSPORT',
    );
    const second = store.retryAttempt(conversationId, first.attemptId)!;
    store.failAttempt(
      conversationId,
      second.attemptId,
      'E_COMPLETION_TRANSPORT',
    );
    const payload = JSON.parse(store.serialize()) as {
      conversations: Array<{
        attempts: Array<{
          status: string;
          failure_code: string | null;
        }>;
      }>;
    };
    payload.conversations[0]!.attempts[0]!.status = 'prepared';
    payload.conversations[0]!.attempts[0]!.failure_code = null;
    expect(() => hydrateChatState(payload)).toThrow(
      ChatStateValidationError,
    );
  });

  test('rejects nested project context accessors without evaluating them', () => {
    const { store } = readyProjectStore();
    const payload = JSON.parse(store.serialize()) as {
      conversations: Array<{
        project_context: Record<string, unknown>;
      }>;
    };
    const getter = jest.fn(() => {
      throw new Error('NESTED_PROJECT_GETTER_SENTINEL');
    });
    Object.defineProperty(
      payload.conversations[0]!.project_context,
      'selected_paths',
      {
        enumerable: true,
        configurable: true,
        get: getter,
      },
    );
    const result = safeHydrateChatState(payload);
    expect(result.ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });

  test('rejects non-enumerable required project context fields', () => {
    const { store } = readyProjectStore();
    const payload = JSON.parse(store.serialize()) as {
      conversations: Array<{
        project_context: {
          consent: Record<string, unknown>;
        };
      }>;
    };
    const consent = payload.conversations[0]!.project_context.consent;
    Object.defineProperty(consent, 'consent_receipt_id', {
      configurable: true,
      enumerable: false,
      value: CONSENT_ID,
    });
    expect(() => hydrateChatState(payload)).toThrow(
      ChatStateValidationError,
    );
  });

  test('rejects oversized arrays before enumerating their elements', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    store.prepareTurnAttempt(conversationId, 'oversized');
    const payload = JSON.parse(store.serialize()) as {
      conversations: Array<{
        attempts: Array<{ visible_message_ids: unknown }>;
      }>;
    };
    let ownKeysCalls = 0;
    let elementDescriptorCalls = 0;
    const oversized = new Proxy(new Array(201), {
      ownKeys: target => {
        ownKeysCalls += 1;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor: (target, key) => {
        if (key !== 'length') elementDescriptorCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    payload.conversations[0]!.attempts[0]!.visible_message_ids = oversized;
    const result = safeHydrateChatState(payload);
    expect(result.ok).toBe(false);
    expect(ownKeysCalls).toBe(0);
    expect(elementDescriptorCalls).toBe(0);
  });

  test('enforces round index and eight-round cap without partial mutation', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const prepared = store.prepareTurnAttempt(conversationId, 'many')!;
    expect(
      store.startAttemptRound(
        conversationId,
        prepared.attemptId,
        ROUND_ID,
        1,
      ),
    ).toBe(false);
    for (let index = 0; index < 8; index += 1) {
      const roundId = `${String(index + 1).padStart(8, '0')}-0000-4000-8000-000000000000`;
      expect(
        store.startAttemptRound(
          conversationId,
          prepared.attemptId,
          roundId,
          index,
        ),
      ).toBe(true);
      expect(
        store.recordAttemptRound(conversationId, prepared.attemptId, {
          schemaVersion: 1,
          transportSchemaVersion: 2,
          turnId: prepared.turnId,
          attemptId: prepared.attemptId,
          roundId,
          roundIndex: index,
          providerRequestId: `${String(index + 101).padStart(
            8,
            '0',
          )}-0000-4000-8000-000000000000`,
          providerResponseId: `resp_${index}`,
          requestedModel: 'deepseek-v4-flash',
          model: 'deepseek-v4-flash',
          thinkingMode: 'high',
          finishReason: index === 7 ? 'stop' : 'tool_calls',
          latencyMs: index,
          visibleHistorySha256: 'a'.repeat(64),
          modelInputSha256: 'b'.repeat(64),
          requestBodySha256: 'c'.repeat(64),
          projectContextReceipt: null,
        }),
      ).toBe(true);
    }
    const before = store.getState();
    expect(
      store.startAttemptRound(
        conversationId,
        prepared.attemptId,
        '99999999-0000-4000-8000-000000000000',
        8,
      ),
    ).toBe(false);
    expect(store.getState()).toBe(before);
  });

  test.each(['provider_request_id', 'provider_response_id'] as const)(
    'rejects globally reused %s in reducer and hydration',
    duplicateField => {
      function populatedSecondReceipt() {
        const store = v6Store();
        const firstConversation = store.createConversation();
        const first = store.prepareTurnAttempt(firstConversation, 'first')!;
        store.startAttemptRound(
          firstConversation,
          first.attemptId,
          ROUND_ID,
          0,
        );
        store.recordAttemptRound(firstConversation, first.attemptId, {
          ...schema2Receipt(first),
          finishReason: 'tool_calls',
        });
        store.failAttempt(
          firstConversation,
          first.attemptId,
          'E_COMPLETION_TRANSPORT',
        );

        const secondConversation = store.createConversation();
        const second = store.prepareTurnAttempt(secondConversation, 'second')!;
        const secondRoundId = '66666666-6666-4666-8666-666666666666';
        store.startAttemptRound(
          secondConversation,
          second.attemptId,
          secondRoundId,
          0,
        );
        return {
          store,
          firstConversation,
          secondConversation,
          first,
          second,
          secondRoundId,
        };
      }

      const duplicate = populatedSecondReceipt();
      const before = duplicate.store.getState();
      expect(
        duplicate.store.recordAttemptRound(
          duplicate.secondConversation,
          duplicate.second.attemptId,
          {
            ...schema2Receipt(duplicate.second),
            roundId: duplicate.secondRoundId,
            providerRequestId:
              duplicateField === 'provider_request_id'
                ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
                : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            providerResponseId:
              duplicateField === 'provider_response_id'
                ? 'resp_1'
                : 'resp_2',
          },
        ),
      ).toBe(false);
      expect(duplicate.store.getState()).toBe(before);

      const persisted = populatedSecondReceipt();
      expect(
        persisted.store.recordAttemptRound(
          persisted.secondConversation,
          persisted.second.attemptId,
          {
            ...schema2Receipt(persisted.second),
            roundId: persisted.secondRoundId,
            providerRequestId:
              'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            providerResponseId: 'resp_2',
          },
        ),
      ).toBe(true);
      const payload = JSON.parse(persisted.store.serialize()) as {
        conversations: Array<{
          attempts: Array<{
            rounds: Array<Record<string, unknown>>;
          }>;
        }>;
      };
      const allReceipts = payload.conversations.flatMap(conversation =>
        conversation.attempts.flatMap(attempt => attempt.rounds),
      );
      allReceipts[1]![duplicateField] = allReceipts[0]![duplicateField];
      expect(() => hydrateChatState(payload)).toThrow(
        ChatStateValidationError,
      );
    },
  );

  test('rejects duplicate in-flight round ids before restart downgrade', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const prepared = store.prepareTurnAttempt(conversationId, 'sending')!;
    store.startAttemptRound(conversationId, prepared.attemptId, ROUND_ID, 0);
    const payload = JSON.parse(store.serialize()) as {
      active_conversation_id: string;
      conversations: Array<{
        id: string;
        turns: Array<{
          turn_id: string;
          attempt_ids: string[];
        }>;
        attempts: Array<{
          attempt_id: string;
          turn_id: string;
        }>;
      }>;
    };
    const copy = JSON.parse(
      JSON.stringify(payload.conversations[0]),
    ) as (typeof payload.conversations)[number];
    copy.id = 'conversation-copy';
    copy.turns[0]!.turn_id =
      '66666666-6666-4666-8666-666666666666';
    copy.turns[0]!.attempt_ids = [
      '77777777-7777-4777-8777-777777777777',
    ];
    copy.attempts[0]!.turn_id =
      '66666666-6666-4666-8666-666666666666';
    copy.attempts[0]!.attempt_id =
      '77777777-7777-4777-8777-777777777777';
    payload.conversations.push(copy);
    expect(() => hydrateChatState(payload)).toThrow(
      ChatStateValidationError,
    );
  });

  test('returns a one-shot exact rollback transaction for a prepared turn', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    store.appendUserMessage(conversationId, 'preview', {
      attachments: [IMAGE_ATTACHMENT],
    });
    const before = store.getState();
    const notifications: ChatState[] = [];
    store.subscribe(state => notifications.push(state));

    const transaction = store.prepareTurnAttempt(conversationId, 'draft')!;
    const preparedState = store.getState();
    expect(typeof transaction.commit).toBe('function');
    expect(typeof transaction.rollback).toBe('function');
    expect(transaction.rollback()).toBe(true);
    expect(store.getState()).toBe(before);
    expect(
      store.getState().conversations[conversationId]?.messages[0]
        ?.attachments[0]?.thumbnail_data_url,
    ).toBe(IMAGE_ATTACHMENT.thumbnail_data_url);
    expect(transaction.rollback()).toBe(false);
    expect(transaction.commit()).toBe(false);
    expect(notifications).toEqual([preparedState, before]);
  });

  test('commit disarms rollback and retry transactions restore exact source', () => {
    const committed = v6Store();
    const committedId = committed.createConversation();
    const first = committed.prepareTurnAttempt(committedId, 'commit')!;
    expect(first.commit()).toBe(true);
    expect(first.commit()).toBe(false);
    expect(first.rollback()).toBe(false);

    expect(
      committed.failAttempt(
        committedId,
        first.attemptId,
        'E_COMPLETION_TRANSPORT',
      ),
    ).toBe(true);
    const failedState = committed.getState();
    const retry = committed.retryAttempt(committedId, first.attemptId)!;
    expect(retry.rollback()).toBe(true);
    expect(committed.getState()).toBe(failedState);
  });

  test('rollback never overwrites a listener reentrant state transition', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    let reentered = false;
    store.subscribe(() => {
      if (reentered) return;
      reentered = true;
      store.renameConversation(conversationId, 'listener update');
    });
    const transaction = store.prepareTurnAttempt(
      conversationId,
      'reentrant',
    )!;
    expect(transaction.rollback()).toBe(false);
    expect(transaction.commit()).toBe(false);
    expect(store.getState().conversations[conversationId]).toMatchObject({
      title: 'listener update',
      messages: [{ text: 'reentrant' }],
    });
  });

  test('listener failures cannot strand a prepared state without a handle', () => {
    const store = v6Store();
    const conversationId = store.createConversation();
    const before = store.getState();
    const observed: ChatState[] = [];
    store.subscribe(() => {
      throw new Error('LISTENER_SECRET');
    });
    store.subscribe(state => observed.push(state));

    let transaction:
      | ReturnType<typeof store.prepareTurnAttempt>
      | undefined;
    expect(() => {
      transaction = store.prepareTurnAttempt(conversationId, 'safe');
    }).not.toThrow();
    expect(transaction).toBeDefined();
    const prepared = store.getState();
    expect(observed).toEqual([prepared]);
    expect(() => transaction!.rollback()).not.toThrow();
    expect(store.getState()).toBe(before);
    expect(observed).toEqual([prepared, before]);
  });

  test('commit always disarms once and failed rollback is consumed', () => {
    const committed = v6Store();
    const committedId = committed.createConversation();
    const transaction = committed.prepareTurnAttempt(
      committedId,
      'commit after mutation',
    )!;
    committed.renameConversation(committedId, 'newer state');
    expect(transaction.commit()).toBe(true);
    expect(transaction.rollback()).toBe(false);
    expect(transaction.commit()).toBe(false);

    const conflicted = v6Store();
    const conflictedId = conflicted.createConversation();
    const failedRollback = conflicted.prepareTurnAttempt(
      conflictedId,
      'rollback conflict',
    )!;
    conflicted.renameConversation(conflictedId, 'wins');
    expect(failedRollback.rollback()).toBe(false);
    expect(failedRollback.commit()).toBe(false);
    expect(failedRollback.rollback()).toBe(false);
  });

  test('interrupts persisted prepared receipts but preserves zero-round resume', () => {
    const resumable = v6Store();
    const resumableId = resumable.createConversation();
    const zeroRound = resumable.prepareTurnAttempt(resumableId, 'resume')!;
    const hydratedZero = hydrateChatState(resumable.serialize());
    expect(
      hydratedZero.conversations[resumableId]?.attempts.find(
        attempt => attempt.attemptId === zeroRound.attemptId,
      ),
    ).toMatchObject({ status: 'prepared', rounds: [] });

    const interrupted = v6Store();
    const interruptedId = interrupted.createConversation();
    const prepared = interrupted.prepareTurnAttempt(
      interruptedId,
      'intermediate',
    )!;
    interrupted.startAttemptRound(
      interruptedId,
      prepared.attemptId,
      ROUND_ID,
      0,
    );
    interrupted.recordAttemptRound(interruptedId, prepared.attemptId, {
      ...schema2Receipt(prepared),
      finishReason: 'tool_calls',
    });
    const hydratedRound = hydrateChatState(interrupted.serialize());
    expect(
      hydratedRound.conversations[interruptedId]?.attempts.find(
        attempt => attempt.attemptId === prepared.attemptId,
      ),
    ).toMatchObject({
      status: 'failed',
      activeRound: null,
      failureCode: 'E_ATTEMPT_INTERRUPTED',
    });
  });

  test('start revalidates frozen model, visible history, and verified context', () => {
    const modelStore = v6Store();
    const modelConversation = modelStore.createConversation();
    const modelAttempt = modelStore.prepareTurnAttempt(
      modelConversation,
      'model',
    )!;
    modelStore.setModel(modelConversation, 'deepseek-v4-pro');
    const modelBefore = modelStore.getState();
    expect(
      modelStore.startAttemptRound(
        modelConversation,
        modelAttempt.attemptId,
        ROUND_ID,
        0,
      ),
    ).toBe(false);
    expect(modelStore.getState()).toBe(modelBefore);

    const historyStore = v6Store();
    const historyConversation = historyStore.createConversation();
    const historyAttempt = historyStore.prepareTurnAttempt(
      historyConversation,
      'history',
    )!;
    historyStore.appendAssistantMessage(historyConversation, 'later');
    expect(
      historyStore.startAttemptRound(
        historyConversation,
        historyAttempt.attemptId,
        ROUND_ID,
        0,
      ),
    ).toBe(false);

    const verified = readyProjectStore();
    const verifiedAttempt = verified.store.prepareTurnAttempt(
      verified.conversationId,
      'context',
    )!;
    verified.store.applyProjectContextAction(verified.conversationId, {
      type: 'snapshot_missing',
    });
    expect(
      verified.store.startAttemptRound(
        verified.conversationId,
        verifiedAttempt.attemptId,
        ROUND_ID,
        0,
      ),
    ).toBe(false);
  });

  test('scoped replace-prepared is one transition and never replaces Ready', () => {
    const setup = setupProjectStore();
    const observed: ChatState[] = [];
    setup.store.subscribe(state => observed.push(state));
    const transaction: ScopedProjectContextTransaction | null =
      setup.store.replaceProjectContextPrepared(
        projectContextScope(setup.store, setup.conversationId),
        {
          preparationId: REPLACEMENT_PREPARATION_ID,
          selectedPaths: ['src/index.ts'],
          manifest: replacementManifest,
        },
      );

    expect(transaction).not.toBeNull();
    expect(observed).toHaveLength(1);
    expect(
      observed.map(
        state => state.conversations[setup.conversationId]?.projectContext?.status,
      ),
    ).toEqual(['setup_required']);
    expect(
      setup.store.getState().conversations[setup.conversationId]?.projectContext,
    ).toMatchObject({
      activePreparationId: REPLACEMENT_PREPARATION_ID,
      snapshot: { snapshot_id: REPLACEMENT_SNAPSHOT_ID },
      consent: null,
    });
    expect(transaction?.commit()).toBe(true);

    const ready = scopedReadyProjectStore();
    const readyBefore = ready.store.getState();
    const readyNotifications: ChatState[] = [];
    ready.store.subscribe(state => readyNotifications.push(state));
    expect(
      ready.store.replaceProjectContextPrepared(
        projectContextScope(ready.store, ready.conversationId),
        {
          preparationId: REPLACEMENT_PREPARATION_ID,
          selectedPaths: ['src/index.ts'],
          manifest: replacementManifest,
        },
      ),
    ).toBeNull();
    expect(ready.store.getState()).toBe(readyBefore);
    expect(readyNotifications).toEqual([]);
  });

  test('scoped replace-confirmed atomically promotes prepared to Ready', () => {
    const fixture = setupProjectStore();
    const prepared = fixture.store.replaceProjectContextPrepared(
      projectContextScope(fixture.store, fixture.conversationId),
      {
        preparationId: REPLACEMENT_PREPARATION_ID,
        selectedPaths: ['src/index.ts'],
        manifest: replacementManifest,
      },
    )!;
    expect(prepared.commit()).toBe(true);
    const observed: ChatState[] = [];
    fixture.store.subscribe(state => observed.push(state));

    const confirmed = fixture.store.replaceProjectContextConfirmed(
      projectContextScope(fixture.store, fixture.conversationId),
      {
        preparationId: REPLACEMENT_PREPARATION_ID,
        selectedPaths: ['src/index.ts'],
        manifest: replacementManifest,
        consent: replacementConsent,
      },
    );

    expect(confirmed).not.toBeNull();
    expect(observed).toHaveLength(1);
    expect(
      observed[0]?.conversations[fixture.conversationId]?.projectContext,
    ).toMatchObject({
      status: 'ready',
      activePreparationId: null,
      snapshot: { snapshot_id: REPLACEMENT_SNAPSHOT_ID },
      consent: { consent_receipt_id: REPLACEMENT_CONSENT_ID },
    });
    expect(confirmed?.commit()).toBe(true);
  });

  test('scoped replace-confirmed swaps Ready A to Ready B without an intermediate state', () => {
    const fixture = scopedReadyProjectStore();
    const oldContext =
      fixture.store.getState().conversations[fixture.conversationId]!
        .projectContext!;
    const observed: ChatState[] = [];
    fixture.store.subscribe(state => observed.push(state));

    const transaction = fixture.store.replaceProjectContextConfirmed(
      projectContextScope(fixture.store, fixture.conversationId),
      {
        preparationId: REPLACEMENT_PREPARATION_ID,
        selectedPaths: ['src/index.ts'],
        manifest: replacementManifest,
        consent: replacementConsent,
      },
    );

    expect(transaction).toMatchObject({
      previousSnapshotId: SNAPSHOT_ID,
      nextSnapshotId: REPLACEMENT_SNAPSHOT_ID,
    });
    expect(observed).toHaveLength(1);
    expect(
      observed.map(
        state =>
          state.conversations[fixture.conversationId]?.projectContext?.snapshot
            ?.snapshot_id,
      ),
    ).toEqual([REPLACEMENT_SNAPSHOT_ID]);
    expect(
      observed[0]?.conversations[fixture.conversationId]?.projectContext
        ?.consent?.consent_receipt_id,
    ).toBe(REPLACEMENT_CONSENT_ID);

    // This verifies only the pure state transaction. A post-native refresh
    // persistence failure must not use this rollback after native pruned A.
    expect(transaction?.rollback()).toBe(true);
    expect(
      fixture.store.getState().conversations[fixture.conversationId]
        ?.projectContext,
    ).toBe(oldContext);
    expect(transaction?.commit()).toBe(false);
  });

  test('scoped confirmation rejects stale scope and mismatched authority metadata', () => {
    const stale = scopedReadyProjectStore();
    const staleScope = projectContextScope(stale.store, stale.conversationId);
    stale.store.setModel(stale.conversationId, 'deepseek-v4-pro');
    const afterModelChange = stale.store.getState();
    expect(
      stale.store.replaceProjectContextConfirmed(staleScope, {
        preparationId: REPLACEMENT_PREPARATION_ID,
        selectedPaths: ['src/index.ts'],
        manifest: {
          ...replacementManifest,
          model: 'deepseek-v4-pro',
        },
        consent: replacementConsent,
      }),
    ).toBeNull();
    expect(stale.store.getState()).toBe(afterModelChange);

    const fixture = scopedReadyProjectStore();
    const scope = projectContextScope(fixture.store, fixture.conversationId);
    const invalidRows: Array<{
      manifest: ProjectContextManifestV1;
      consent: ProjectContextConsentV1;
    }> = [
      {
        manifest: { ...replacementManifest, project_id: OTHER_PROJECT_ID },
        consent: replacementConsent,
      },
      {
        manifest: { ...replacementManifest, model: 'deepseek-v4-pro' },
        consent: replacementConsent,
      },
      {
        manifest: {
          ...replacementManifest,
          provider_host: 'proxy.example.com',
        } as unknown as ProjectContextManifestV1,
        consent: replacementConsent,
      },
      {
        manifest: {
          ...replacementManifest,
          policy_version: 'chat-read-v1.0.1',
        },
        consent: replacementConsent,
      },
      {
        manifest: replacementManifest,
        consent: {
          ...replacementConsent,
          snapshot_sha256: 'f'.repeat(64),
        },
      },
    ];
    for (const row of invalidRows) {
      const before = fixture.store.getState();
      expect(
        fixture.store.replaceProjectContextConfirmed(scope, {
          preparationId: REPLACEMENT_PREPARATION_ID,
          selectedPaths: ['src/index.ts'],
          manifest: row.manifest,
          consent: row.consent,
        }),
      ).toBeNull();
      expect(fixture.store.getState()).toBe(before);
    }

    expect(
      fixture.store.replaceProjectContextConfirmed(
        {
          ...scope,
          projectId: OTHER_PROJECT_ID,
          runtimeContextId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
        {
          preparationId: REPLACEMENT_PREPARATION_ID,
          selectedPaths: ['src/index.ts'],
          manifest: replacementManifest,
          consent: replacementConsent,
        },
      ),
    ).toBeNull();
  });

  test('all scoped context mutations reject live and exact-retry attempts', () => {
    const liveSetup = setupProjectStore();
    const setupScope = projectContextScope(
      liveSetup.store,
      liveSetup.conversationId,
    );
    const liveWithoutContext = liveSetup.store.prepareTurnAttempt(
      liveSetup.conversationId,
      'live',
      { sendWithoutProjectContext: true },
    )!;
    expect(liveWithoutContext.commit()).toBe(true);
    expect(
      liveSetup.store.replaceProjectContextPrepared(setupScope, {
        preparationId: REPLACEMENT_PREPARATION_ID,
        selectedPaths: ['src/index.ts'],
        manifest: replacementManifest,
      }),
    ).toBeNull();

    const retryable = scopedReadyProjectStore();
    const attempt = retryable.store.prepareTurnAttempt(
      retryable.conversationId,
      'retryable',
    )!;
    expect(attempt.commit()).toBe(true);
    expect(
      retryable.store.failAttempt(
        retryable.conversationId,
        attempt.attemptId,
        'E_COMPLETION_TRANSPORT',
      ),
    ).toBe(true);
    const retryScope = projectContextScope(
      retryable.store,
      retryable.conversationId,
    );
    expect(retryable.store.disableProjectContext(retryScope)).toBeNull();
    expect(
      retryable.store.replaceProjectContextConfirmed(retryScope, {
        preparationId: REPLACEMENT_PREPARATION_ID,
        selectedPaths: ['src/index.ts'],
        manifest: replacementManifest,
        consent: replacementConsent,
      }),
    ).toBeNull();
  });

  test('disable exposes cleanup identity and blocks schema3 before native cleanup', () => {
    const fixture = scopedReadyProjectStore();
    const observed: ChatState[] = [];
    fixture.store.subscribe(state => observed.push(state));
    const transaction = fixture.store.disableProjectContext(
      projectContextScope(fixture.store, fixture.conversationId),
    );

    expect(transaction).toMatchObject({
      previousSnapshotId: SNAPSHOT_ID,
      nextSnapshotId: null,
      cleanupSnapshotId: SNAPSHOT_ID,
    });
    expect(observed).toHaveLength(1);
    expect(
      fixture.store.getState().conversations[fixture.conversationId]
        ?.projectContext,
    ).toMatchObject({
      status: 'setup_required',
      snapshot: null,
      consent: null,
    });
    expect(
      fixture.store.prepareTurnAttempt(
        fixture.conversationId,
        'must not route schema3',
      ),
    ).toBeNull();
    expect(fixture.store.serialize()).not.toContain(SNAPSHOT_ID);
    expect(transaction?.commit()).toBe(true);
  });

  test('scoped rollback preserves unrelated root changes and rejects a target race', () => {
    const fixture = scopedReadyProjectStore();
    const transaction = fixture.store.disableProjectContext(
      projectContextScope(fixture.store, fixture.conversationId),
    )!;
    const otherConversation = fixture.store.createConversation({
      title: 'unrelated',
    });
    fixture.store.selectConversation(otherConversation);

    expect(transaction.rollback()).toBe(true);
    expect(fixture.store.getState().selectedConversationId).toBe(
      otherConversation,
    );
    expect(
      fixture.store.getState().conversations[otherConversation]?.title,
    ).toBe('unrelated');
    expect(
      fixture.store.getState().conversations[fixture.conversationId]
        ?.projectContext?.snapshot?.snapshot_id,
    ).toBe(SNAPSHOT_ID);

    const raced = scopedReadyProjectStore();
    const racedTransaction = raced.store.disableProjectContext(
      projectContextScope(raced.store, raced.conversationId),
    )!;
    raced.store.renameConversation(raced.conversationId, 'same target wins');
    expect(racedTransaction.rollback()).toBe(false);
    expect(racedTransaction.commit()).toBe(false);
    expect(racedTransaction.rollback()).toBe(false);
    expect(
      raced.store.getState().conversations[raced.conversationId]?.title,
    ).toBe('same target wins');
  });

  test('scoped transactions are once-only and isolate listener failures', () => {
    const rollbackFixture = scopedReadyProjectStore();
    const notifications: ChatState[] = [];
    rollbackFixture.store.subscribe(() => {
      throw new Error('CONTEXT_LISTENER_SECRET');
    });
    rollbackFixture.store.subscribe(state => notifications.push(state));
    let rollbackTransaction:
      | ReturnType<ChatStore['disableProjectContext']>
      | undefined;
    expect(() => {
      rollbackTransaction = rollbackFixture.store.disableProjectContext(
        projectContextScope(
          rollbackFixture.store,
          rollbackFixture.conversationId,
        ),
      );
    }).not.toThrow();
    expect(rollbackTransaction).not.toBeNull();
    expect(() => rollbackTransaction!.rollback()).not.toThrow();
    expect(rollbackTransaction!.rollback()).toBe(false);
    expect(rollbackTransaction!.commit()).toBe(false);
    expect(notifications).toHaveLength(2);

    const commitFixture = scopedReadyProjectStore();
    const commitTransaction = commitFixture.store.disableProjectContext(
      projectContextScope(commitFixture.store, commitFixture.conversationId),
    )!;
    expect(commitTransaction.commit()).toBe(true);
    expect(commitTransaction.commit()).toBe(false);
    expect(commitTransaction.rollback()).toBe(false);
  });

  test('generic project-context actions cannot bypass scoped durable mutations', () => {
    const fixture = setupProjectStore();
    const setupBefore = fixture.store.getState();
    expect(
      fixture.store.applyProjectContextAction(fixture.conversationId, {
        type: 'checking',
        preparationId: REPLACEMENT_PREPARATION_ID,
      }),
    ).toBe(false);
    expect(fixture.store.getState()).toBe(setupBefore);

    const prepared = fixture.store.replaceProjectContextPrepared(
      projectContextScope(fixture.store, fixture.conversationId),
      {
        preparationId: REPLACEMENT_PREPARATION_ID,
        selectedPaths: ['src/index.ts'],
        manifest: replacementManifest,
      },
    )!;
    expect(prepared.commit()).toBe(true);
    const preparedBefore = fixture.store.getState();
    expect(
      fixture.store.applyProjectContextAction(fixture.conversationId, {
        type: 'confirmed',
        preparationId: REPLACEMENT_PREPARATION_ID,
        manifest: replacementManifest,
        consent: replacementConsent,
      }),
    ).toBe(false);
    expect(fixture.store.getState()).toBe(preparedBefore);

    const confirmed = fixture.store.replaceProjectContextConfirmed(
      projectContextScope(fixture.store, fixture.conversationId),
      {
        preparationId: REPLACEMENT_PREPARATION_ID,
        selectedPaths: ['src/index.ts'],
        manifest: replacementManifest,
        consent: replacementConsent,
      },
    )!;
    expect(confirmed.commit()).toBe(true);
    const readyBefore = fixture.store.getState();
    expect(
      fixture.store.applyProjectContextAction(fixture.conversationId, {
        type: 'selection_changed',
        selectedPaths: ['README.md'],
      }),
    ).toBe(false);
    expect(
      fixture.store.applyProjectContextAction(fixture.conversationId, {
        type: 'disabled',
      }),
    ).toBe(false);
    expect(fixture.store.getState()).toBe(readyBefore);
  });

  test('scoped replacements reject v6-unsafe metadata before live mutation', () => {
    const invalidPreparedRows: Array<{
      selectedPaths: readonly string[];
      manifest: ProjectContextManifestV1;
    }> = [
      {
        selectedPaths: ['../secret'],
        manifest: replacementManifest,
      },
      {
        selectedPaths: ['src/index.ts'],
        manifest: {
          ...replacementManifest,
          included: [
            {
              ...replacementManifest.included[0]!,
              path: '../secret',
            },
          ],
        },
      },
      {
        selectedPaths: ['src/index.ts'],
        manifest: {
          ...replacementManifest,
          context_bytes: 256 * 1024 + 1,
          estimated_tokens: 65_537,
        },
      },
      {
        selectedPaths: ['src/index.ts'],
        manifest: {
          ...replacementManifest,
          estimated_tokens: replacementManifest.estimated_tokens + 1,
        },
      },
      {
        selectedPaths: ['src/index.ts'],
        manifest: {
          ...replacementManifest,
          clean: true,
          conflicted: true,
        },
      },
    ];

    for (const row of invalidPreparedRows) {
      const fixture = setupProjectStore();
      const before = fixture.store.getState();
      const notifications: ChatState[] = [];
      fixture.store.subscribe(state => notifications.push(state));
      expect(
        fixture.store.replaceProjectContextPrepared(
          projectContextScope(fixture.store, fixture.conversationId),
          {
            preparationId: REPLACEMENT_PREPARATION_ID,
            selectedPaths: row.selectedPaths,
            manifest: row.manifest,
          },
        ),
      ).toBeNull();
      expect(fixture.store.getState()).toBe(before);
      expect(notifications).toEqual([]);
    }

    const confirmed = scopedReadyProjectStore();
    const confirmedBefore = confirmed.store.getState();
    const confirmedNotifications: ChatState[] = [];
    confirmed.store.subscribe(state => confirmedNotifications.push(state));
    expect(
      confirmed.store.replaceProjectContextConfirmed(
        projectContextScope(confirmed.store, confirmed.conversationId),
        {
          preparationId: REPLACEMENT_PREPARATION_ID,
          selectedPaths: ['src/index.ts'],
          manifest: replacementManifest,
          consent: { ...replacementConsent, confirmed_at: T0 },
        },
      ),
    ).toBeNull();
    expect(confirmed.store.getState()).toBe(confirmedBefore);
    expect(confirmedNotifications).toEqual([]);
  });

  test('hostile scoped conversation identity is rejected without coercion', () => {
    const fixture = scopedReadyProjectStore();
    const validScope = projectContextScope(
      fixture.store,
      fixture.conversationId,
    );
    let coercions = 0;
    const hostileConversationId = {
      [Symbol.toPrimitive]: () => {
        coercions += 1;
        throw new Error('SCOPE_COERCION_SECRET');
      },
    };
    const hostileScope = {
      ...validScope,
      conversationId: hostileConversationId as unknown as string,
    };
    const before = fixture.store.getState();
    expect(() => fixture.store.disableProjectContext(hostileScope)).not.toThrow();
    expect(fixture.store.disableProjectContext(hostileScope)).toBeNull();
    expect(coercions).toBe(0);
    expect(fixture.store.getState()).toBe(before);
  });

  test('generic unavailable cannot clear a durable snapshot without cleanup identity', () => {
    const fixture = scopedReadyProjectStore();
    const before = fixture.store.getState();
    expect(
      fixture.store.applyProjectContextAction(fixture.conversationId, {
        type: 'unavailable',
      }),
    ).toBe(false);
    expect(fixture.store.getState()).toBe(before);
  });

  test('selects only verified prepared, sending, and exact-retry references', () => {
    const fixture = scopedReadyProjectStore();
    const prepared = fixture.store.prepareTurnAttempt(
      fixture.conversationId,
      'reference',
    )!;
    expect(prepared.commit()).toBe(true);
    expect(
      selectProjectContextSnapshotReferences(
        fixture.store.getState(),
        fixture.conversationId,
      ),
    ).toEqual([
      {
        conversationId: fixture.conversationId,
        attemptId: prepared.attemptId,
        kind: 'prepared',
      },
    ]);
    expect(
      selectProjectContextSnapshotReferences(
        fixture.store.getState(),
        fixture.conversationId,
        REPLACEMENT_SNAPSHOT_ID,
      ),
    ).toEqual([]);

    expect(
      fixture.store.startAttemptRound(
        fixture.conversationId,
        prepared.attemptId,
        ROUND_ID,
        0,
      ),
    ).toBe(true);
    expect(
      selectProjectContextSnapshotReferences(
        fixture.store.getState(),
        fixture.conversationId,
        SNAPSHOT_ID,
      ),
    ).toEqual([
      {
        conversationId: fixture.conversationId,
        attemptId: prepared.attemptId,
        kind: 'sending',
      },
    ]);

    expect(
      fixture.store.failAttempt(
        fixture.conversationId,
        prepared.attemptId,
        'E_COMPLETION_TRANSPORT',
      ),
    ).toBe(true);
    expect(
      selectProjectContextSnapshotReferences(
        fixture.store.getState(),
        fixture.conversationId,
        SNAPSHOT_ID,
      ),
    ).toEqual([
      {
        conversationId: fixture.conversationId,
        attemptId: prepared.attemptId,
        kind: 'retryable',
      },
    ]);

    const cancelled = scopedReadyProjectStore();
    const cancelledAttempt = cancelled.store.prepareTurnAttempt(
      cancelled.conversationId,
      'cancelled retry',
    )!;
    expect(cancelledAttempt.commit()).toBe(true);
    expect(
      cancelled.store.cancelAttempt(
        cancelled.conversationId,
        cancelledAttempt.attemptId,
      ),
    ).toBe(true);
    expect(
      selectProjectContextSnapshotReferences(
        cancelled.store.getState(),
        cancelled.conversationId,
        SNAPSHOT_ID,
      ),
    ).toEqual([
      {
        conversationId: cancelled.conversationId,
        attemptId: cancelledAttempt.attemptId,
        kind: 'retryable',
      },
    ]);
  });

  test('excludes plain, completed, old-visible, and other-snapshot attempts', () => {
    const explicit = setupProjectStore();
    const plain = explicit.store.prepareTurnAttempt(
      explicit.conversationId,
      'plain',
      { sendWithoutProjectContext: true },
    )!;
    expect(plain.commit()).toBe(true);
    expect(
      selectProjectContextSnapshotReferences(
        explicit.store.getState(),
        explicit.conversationId,
      ),
    ).toEqual([]);

    const completed = scopedReadyProjectStore();
    const terminal = completed.store.prepareTurnAttempt(
      completed.conversationId,
      'done',
    )!;
    expect(terminal.commit()).toBe(true);
    expect(
      completed.store.startAttemptRound(
        completed.conversationId,
        terminal.attemptId,
        ROUND_ID,
        0,
      ),
    ).toBe(true);
    expect(
      completed.store.recordAttemptRound(
        completed.conversationId,
        terminal.attemptId,
        schema3Receipt(terminal),
      ),
    ).toBe(true);
    expect(
      completed.store.completeAttempt(
        completed.conversationId,
        terminal.attemptId,
        'complete',
        {
          metadata: {
            modelId: 'deepseek-v4-flash',
            latencyMs: 1,
            finishReason: 'stop',
          },
        },
      ),
    ).not.toBeNull();
    expect(
      selectProjectContextSnapshotReferences(
        completed.store.getState(),
        completed.conversationId,
      ),
    ).toEqual([]);

    const oldVisible = scopedReadyProjectStore();
    const failed = oldVisible.store.prepareTurnAttempt(
      oldVisible.conversationId,
      'old',
    )!;
    expect(failed.commit()).toBe(true);
    expect(
      oldVisible.store.failAttempt(
        oldVisible.conversationId,
        failed.attemptId,
        'E_COMPLETION_TRANSPORT',
      ),
    ).toBe(true);
    oldVisible.store.appendAssistantMessage(
      oldVisible.conversationId,
      'history advanced',
    );
    expect(
      selectProjectContextSnapshotReferences(
        oldVisible.store.getState(),
        oldVisible.conversationId,
        SNAPSHOT_ID,
      ),
    ).toEqual([]);
  });

  test('bounds snapshot reference rows without returning raw context metadata', () => {
    const fixture = scopedReadyProjectStore();
    const prepared = fixture.store.prepareTurnAttempt(
      fixture.conversationId,
      'bounded',
    )!;
    expect(prepared.commit()).toBe(true);
    const state = fixture.store.getState();
    const conversation = state.conversations[fixture.conversationId]!;
    const source = conversation.attempts[0]!;
    const attempts = Array.from({ length: 2_000 }, (_, index) => ({
      ...source,
      attemptId: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    }));
    const adversarialState: ChatState = {
      ...state,
      conversations: {
        ...state.conversations,
        [fixture.conversationId]: { ...conversation, attempts },
      },
    };

    const rows = selectProjectContextSnapshotReferences(
      adversarialState,
      fixture.conversationId,
      SNAPSHOT_ID,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(
      MAX_PROJECT_CONTEXT_SNAPSHOT_REFERENCE_ROWS,
    );
    expect(JSON.stringify(rows)).not.toMatch(
      /snapshot|consent|source|fingerprint|contextBytes|projectContext/u,
    );
  });

  test('snapshot reference selector fails closed for missing and hostile inputs', () => {
    const fixture = scopedReadyProjectStore();
    expect(
      selectProjectContextSnapshotReferences(
        fixture.store.getState(),
        'missing-conversation',
      ),
    ).toEqual([]);

    let coercions = 0;
    const hostile = {
      [Symbol.toPrimitive]: () => {
        coercions += 1;
        throw new Error('REFERENCE_SELECTOR_SECRET');
      },
    };
    expect(() =>
      selectProjectContextSnapshotReferences(
        fixture.store.getState(),
        hostile as unknown as string,
        hostile as unknown as string,
      ),
    ).not.toThrow();
    expect(
      selectProjectContextSnapshotReferences(
        fixture.store.getState(),
        hostile as unknown as string,
        hostile as unknown as string,
      ),
    ).toEqual([]);
    expect(coercions).toBe(0);

    const hostileState = new Proxy({} as ChatState, {
      get: () => {
        throw new Error('HOSTILE_STATE_SECRET');
      },
    });
    expect(() =>
      selectProjectContextSnapshotReferences(
        hostileState,
        fixture.conversationId,
      ),
    ).not.toThrow();
    expect(
      selectProjectContextSnapshotReferences(
        hostileState,
        fixture.conversationId,
      ),
    ).toEqual([]);

    const validAttempt = fixture.store.prepareTurnAttempt(
      fixture.conversationId,
      'valid before hostile',
    )!;
    expect(validAttempt.commit()).toBe(true);
    let getterCalls = 0;
    const hostileAttempt = {};
    Object.defineProperty(hostileAttempt, 'attemptId', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error('ATTEMPT_GETTER_SECRET');
      },
    });
    const current = fixture.store.getState();
    const currentConversation = current.conversations[fixture.conversationId]!;
    const hostileAttemptState = {
      ...current,
      conversations: {
        ...current.conversations,
        [fixture.conversationId]: {
          ...currentConversation,
          attempts: [...currentConversation.attempts, hostileAttempt],
        },
      },
    } as ChatState;
    expect(
      selectProjectContextSnapshotReferences(
        hostileAttemptState,
        fixture.conversationId,
      ),
    ).toEqual([]);
    expect(getterCalls).toBe(0);
  });
});

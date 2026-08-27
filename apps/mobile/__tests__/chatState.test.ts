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
  selectOrderedConversations,
  serializeChatState,
  type ChatAttachment,
  type ChatState,
  type PersistedChatStateV4,
} from '../src/state';

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
    const decoded = JSON.parse(first) as PersistedChatStateV4;

    expect(first).toBe(second);
    expect(decoded.schema_version).toBe(5);
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
    expect(first.schemaVersion).toBe(5);
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
    expect(migrated.schema_version).toBe(5);
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
    expect(hydrated.schemaVersion).toBe(5);
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
      conversations: Array<{ thinking_mode?: string }>;
    };
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

  test('persists schema v5 workspace ids deterministically', () => {
    const state = workspaceBoundState();
    const first = serializeChatState(state);
    const second = serializeChatState(state);
    const decoded = JSON.parse(first) as {
      schema_version: number;
      conversations: Array<{ id: string; workspace_id: string | null }>;
    };

    expect(first).toBe(second);
    expect(decoded.schema_version).toBe(5);
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
    expect(first.schemaVersion).toBe(5);
    expect(
      Object.values(first.conversations).every(
        conversation => conversation.workspaceId === null,
      ),
    ).toBe(true);

    const migrated = JSON.parse(serializeChatState(first)) as {
      schema_version: number;
      conversations: Array<{ workspace_id: string | null }>;
    };
    expect(migrated.schema_version).toBe(5);
    expect(
      migrated.conversations.every(conversation =>
        conversation.workspace_id === null,
      ),
    ).toBe(true);
  });

  test('strictly validates the required v5 workspace_id field', () => {
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

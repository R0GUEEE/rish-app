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
  type CompletionRoundReceiptV1,
  type ChatState,
  type PersistedChatStateV4,
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
    expect(decoded.schema_version).toBe(6);
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
    expect(first.schemaVersion).toBe(6);
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
    expect(migrated.schema_version).toBe(6);
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
    expect(hydrated.schemaVersion).toBe(6);
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

  test('persists schema v6 workspace ids deterministically', () => {
    const state = workspaceBoundState();
    const first = serializeChatState(state);
    const second = serializeChatState(state);
    const decoded = JSON.parse(first) as {
      schema_version: number;
      conversations: Array<{ id: string; workspace_id: string | null }>;
    };

    expect(first).toBe(second);
    expect(decoded.schema_version).toBe(6);
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
    expect(first.schemaVersion).toBe(6);
    expect(
      Object.values(first.conversations).every(
        conversation => conversation.workspaceId === null,
      ),
    ).toBe(true);

    const migrated = JSON.parse(serializeChatState(first)) as {
      schema_version: number;
      conversations: Array<{ workspace_id: string | null }>;
    };
    expect(migrated.schema_version).toBe(6);
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
  const SNAPSHOT_ID = '77777777-7777-4777-8777-777777777777';
  const CONSENT_ID = '88888888-8888-4888-8888-888888888888';

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
    store.applyProjectContextAction(conversationId, {
      type: 'checking',
      preparationId: 'prepare-1',
    });
    store.applyProjectContextAction(conversationId, {
      type: 'prepared',
      preparationId: 'prepare-1',
      manifest,
    });
    store.applyProjectContextAction(conversationId, {
      type: 'confirmed',
      preparationId: 'prepare-1',
      manifest,
      consent: contextConsent,
    });
    return { store, conversationId };
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
    expect(migrated.schemaVersion).toBe(6);
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
    store.unbindConversationFromProject(conversationId);
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
      type: 'selection_changed',
      selectedPaths: ['README.md'],
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
});

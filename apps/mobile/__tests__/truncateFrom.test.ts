import { chatReducer } from '../src/state/reducer';
import { createChatStore } from '../src/state/store';
import type { ChatState, Conversation, TurnAttemptV1 } from '../src/state/types';

const T0 = '2026-09-30T08:00:00.000Z';
const T1 = '2026-09-30T08:00:01.000Z';

let lifecycle = 0;
const uuid = (): string => {
  lifecycle += 1;
  const tail = String(lifecycle).padStart(12, '0');
  return `11111111-1111-4111-8111-${tail}`;
};

/** A conversation with two prompt/reply pairs and nothing else. */
function twoTurnConversation(): { state: ChatState; conversationId: string } {
  let ids = 0;
  const store = createChatStore({
    now: () => T0,
    createId: kind => `${kind}-${++ids}`,
    createLifecycleId: uuid,
  });
  const conversationId = store.createConversation();
  store.appendUserMessage(conversationId, 'first prompt');
  store.appendAssistantMessage(conversationId, 'first answer');
  store.appendUserMessage(conversationId, 'second prompt');
  store.appendAssistantMessage(conversationId, 'second answer');
  return { state: store.getState(), conversationId };
}

const texts = (state: ChatState, conversationId: string): string[] =>
  (state.conversations[conversationId]?.messages ?? []).map(
    message => message.text,
  );

describe('conversation/truncate-from', () => {
  test('drops the prompt it names and everything after it', () => {
    const { state, conversationId } = twoTurnConversation();
    const before = state.conversations[conversationId]!.messages;
    const target = before[2]!.id;
    const next = chatReducer(state, {
      type: 'conversation/truncate-from',
      payload: { conversationId, messageId: target, at: T1 },
    });
    expect(texts(next, conversationId)).toEqual(['first prompt', 'first answer']);
    expect(next.conversations[conversationId]!.updatedAt).toBe(T1);
  });

  test('leaves messages before the cut untouched', () => {
    const { state, conversationId } = twoTurnConversation();
    const target = state.conversations[conversationId]!.messages[0]!.id;
    const next = chatReducer(state, {
      type: 'conversation/truncate-from',
      payload: { conversationId, messageId: target, at: T1 },
    });
    expect(texts(next, conversationId)).toEqual([]);
  });

  test('refuses to cut at a reply, because only a prompt starts a turn', () => {
    const { state, conversationId } = twoTurnConversation();
    const reply = state.conversations[conversationId]!.messages[1]!.id;
    expect(
      chatReducer(state, {
        type: 'conversation/truncate-from',
        payload: { conversationId, messageId: reply, at: T1 },
      }),
    ).toBe(state);
  });

  test('refuses an unknown message, conversation or timestamp', () => {
    const { state, conversationId } = twoTurnConversation();
    const target = state.conversations[conversationId]!.messages[0]!.id;
    for (const payload of [
      { conversationId, messageId: 'nope', at: T1 },
      { conversationId: 'nope', messageId: target, at: T1 },
      { conversationId, messageId: target, at: 'not-a-timestamp' },
    ]) {
      expect(
        chatReducer(state, { type: 'conversation/truncate-from', payload }),
      ).toBe(state);
    }
  });

  test('refuses while a round is still in flight', () => {
    const { state, conversationId } = twoTurnConversation();
    const conversation = state.conversations[conversationId]!;
    const target = conversation.messages[2]!.id;
    const withAttempt = (status: TurnAttemptV1['status']): ChatState => ({
      ...state,
      conversations: {
        ...state.conversations,
        [conversationId]: {
          ...conversation,
          attempts: [
            {
              attemptId: uuid(),
              turnId: 'turn-x',
              status,
              agent: null,
            } as unknown as TurnAttemptV1,
          ],
        },
      },
    });
    for (const status of ['prepared', 'sending'] as const) {
      const loaded = withAttempt(status);
      expect(
        chatReducer(loaded, {
          type: 'conversation/truncate-from',
          payload: { conversationId, messageId: target, at: T1 },
        }),
      ).toBe(loaded);
    }
  });

  test('refuses when an Agent journal owns what would be dropped', () => {
    const { state, conversationId } = twoTurnConversation();
    const conversation = state.conversations[conversationId]!;
    const target = conversation.messages[2]!.id;
    // A turn covering the target, with an attempt carrying an Agent journal.
    const turnId = conversation.messages[2]!.id.replace('message', 'turn');
    const guarded: ChatState = {
      ...state,
      conversations: {
        ...state.conversations,
        [conversationId]: {
          ...conversation,
          turns: [
            ...conversation.turns,
            {
              turnId,
              userMessageId: target,
              attemptIds: [],
            } as unknown as Conversation['turns'][number],
          ],
          attempts: [
            {
              attemptId: uuid(),
              turnId,
              status: 'failed',
              agent: { phase: 'failed' },
            } as unknown as TurnAttemptV1,
          ],
        },
      },
    };
    expect(
      chatReducer(guarded, {
        type: 'conversation/truncate-from',
        payload: { conversationId, messageId: target, at: T1 },
      }),
    ).toBe(guarded);
  });

  test('drops the attempts and turns of what it truncated', () => {
    const { state, conversationId } = twoTurnConversation();
    const conversation = state.conversations[conversationId]!;
    const target = conversation.messages[2]!.id;
    const keptTurnId = conversation.messages[0]!.id.replace('message', 'turn');
    const droppedTurnId = target.replace('message', 'turn');
    const withTurns: ChatState = {
      ...state,
      conversations: {
        ...state.conversations,
        [conversationId]: {
          ...conversation,
          turns: [
            { turnId: keptTurnId, userMessageId: conversation.messages[0]!.id, attemptIds: [] },
            { turnId: droppedTurnId, userMessageId: target, attemptIds: [] },
          ] as unknown as Conversation['turns'],
          attempts: [
            { attemptId: 'kept-attempt', turnId: keptTurnId, status: 'failed', agent: null },
            { attemptId: 'dropped-attempt', turnId: droppedTurnId, status: 'failed', agent: null },
          ] as unknown as TurnAttemptV1[],
        },
      },
      sessionEvents: [
        { attempt_id: 'kept-attempt' },
        { attempt_id: 'dropped-attempt' },
      ] as unknown as ChatState['sessionEvents'],
    };
    const next = chatReducer(withTurns, {
      type: 'conversation/truncate-from',
      payload: { conversationId, messageId: target, at: T1 },
    });
    const result = next.conversations[conversationId]!;
    expect(result.turns.map(turn => turn.turnId)).toEqual([keptTurnId]);
    expect(result.attempts.map(attempt => attempt.attemptId)).toEqual([
      'kept-attempt',
    ]);
    expect(
      (next.sessionEvents ?? []).map(event => event.attempt_id),
    ).toEqual(['kept-attempt']);
  });

  test('never touches another conversation', () => {
    const { state, conversationId } = twoTurnConversation();
    const target = state.conversations[conversationId]!.messages[2]!.id;
    const next = chatReducer(state, {
      type: 'conversation/truncate-from',
      payload: { conversationId, messageId: target, at: T1 },
    });
    expect(next.conversationOrder).toEqual(state.conversationOrder);
    expect(next.selectedConversationId).toBe(state.selectedConversationId);
  });

  test('the store exposes it, and notifies its listeners', () => {
    let ids = 0;
    const store = createChatStore({
      now: () => T0,
      createId: kind => `${kind}-${++ids}`,
      createLifecycleId: uuid,
    });
    const conversationId = store.createConversation();
    store.appendUserMessage(conversationId, 'first prompt');
    store.appendAssistantMessage(conversationId, 'first answer');
    store.appendUserMessage(conversationId, 'second prompt');
    store.appendAssistantMessage(conversationId, 'second answer');
    const target = store.getState().conversations[conversationId]!.messages[2]!.id;

    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.truncateFrom(conversationId, target);
    expect(notified).toBe(1);
    expect(texts(store.getState(), conversationId)).toEqual([
      'first prompt',
      'first answer',
    ]);
  });

  test('refusing through the store changes nothing and notifies nobody', () => {
    let ids = 0;
    const store = createChatStore({
      now: () => T0,
      createId: kind => `${kind}-${++ids}`,
      createLifecycleId: uuid,
    });
    const conversationId = store.createConversation();
    store.appendUserMessage(conversationId, 'only prompt');
    const reply = store.getState().conversations[conversationId]!.messages;
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    // A cut at a prompt that is not there is refused by the reducer.
    store.truncateFrom(conversationId, 'missing');
    expect(notified).toBe(0);
    expect(texts(store.getState(), conversationId)).toEqual(['only prompt']);
    expect(reply).toHaveLength(1);
  });
});

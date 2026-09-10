let nextId = 0;
const randomUUID = () => `${(++nextId).toString(16).padStart(8, '0')}-1111-4111-8111-000000000001`;
import { createChatStore, hydrateChatState, serializeChatState, MAX_SESSION_EVENT_ROWS, AGENT_EVENT_START_RESERVE } from '../src/state';
import { createCompletionController } from '../src/completion/CompletionController';
import type { AgentRuntimeFacadeV2 } from '../src/native/AgentRuntime';

const base = require('../ios/RishTests/Fixtures/agent-next-round-after-tool-session.json');
function history(copies: number) {
  const result = JSON.parse(JSON.stringify(base));
  result.conversations = [];
  result.session_events = [];
  for (let index = 0; index < copies; index++) {
    const ids = new Map<string, string>();
    const copy = JSON.parse(JSON.stringify(base).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, id => {
      if (!ids.has(id)) ids.set(id, randomUUID());
      return ids.get(id)!;
    }));
    for (const conversation of copy.conversations) {
      for (const attempt of conversation.attempts) {
        for (const round of attempt.rounds) round.provider_response_id += `-${index}`;
      }
    }
    result.conversations.push(...copy.conversations);
    result.session_events.push(...copy.session_events);
  }
  result.active_conversation_id = result.conversations[0].id;
  result.messages = result.conversations[0].messages;
  return result;
}

test('retains more than 512 correlated audit rows through serialization and hydration', () => {
  const fixture = history(40);
  expect(fixture.session_events.length).toBeGreaterThan(512);
  const state = hydrateChatState(JSON.stringify(fixture));
  expect(JSON.parse(serializeChatState(state)).session_events).toEqual(fixture.session_events);
});

test('the enlarged event limit remains enforced', () => {
  const fixture = history(1);
  fixture.session_events = Array.from({length: MAX_SESSION_EVENT_ROWS + 1}, () => fixture.session_events[0]);
  expect(() => hydrateChatState(JSON.stringify(fixture))).toThrow('exceeds the array limit');
});

test('insufficient event headroom blocks a new Agent task before messages, persistence or dispatch', async () => {
  const rowsPerCopy = base.session_events.length;
  const fixture = history(Math.ceil((MAX_SESSION_EVENT_ROWS - AGENT_EVENT_START_RESERVE + 1) / rowsPerCopy));
  const store = createChatStore({initialState: hydrateChatState(JSON.stringify(fixture))});
  const before = store.getState();
  const nativePrepare = jest.fn();
  const nativeComplete = jest.fn();
  const persist = jest.fn();
  const controller = createCompletionController({
    chat: store, persistCurrent: persist, completeRoundV2: nativeComplete,
    cancelRoundV2: jest.fn(), completeRoundV3: nativeComplete, cancelRoundV3: jest.fn(), createRoundId: randomUUID, createOperationId: randomUUID,
    agentRuntime: { isAvailable: () => true, prepareAgentAttempt: nativePrepare } as unknown as AgentRuntimeFacadeV2,
  });
  const result = await controller.send({conversationId: before.selectedConversationId!, text: 'new tool task', attachments: []});
  expect(result.code).toBe('E_AGENT_EVENT_CAPACITY');
  expect(store.getState()).toBe(before);
  expect(nativePrepare).not.toHaveBeenCalled();
  expect(nativeComplete).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
});

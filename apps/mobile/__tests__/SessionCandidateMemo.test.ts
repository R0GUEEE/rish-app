import { createChatStore } from '../src/state';
import {
  serializeChatState,
  sessionCandidateIsValid,
} from '../src/state/persistence';

const T0 = '2026-08-24T01:00:00.000Z';

function candidate(): string {
  const store = createChatStore({ now: () => T0 });
  const conversationId = store.createConversation();
  store.dispatch({
    type: 'message/append',
    payload: {
      conversationId,
      message: {
        id: 'u1',
        role: 'user',
        text: 'memo?',
        createdAt: T0,
        attachments: [],
      },
    },
  });
  return store.serialize();
}

test('serialising the same state twice yields the same validated text', () => {
  const store = createChatStore({ now: () => T0 });
  const first = serializeChatState(store.getState());
  const second = serializeChatState(store.getState());
  expect(second).toBe(first);
  expect(sessionCandidateIsValid(first)).toBe(true);
});

test('memory never makes an invalid candidate valid', () => {
  const valid = candidate();
  expect(sessionCandidateIsValid(valid)).toBe(true);
  expect(sessionCandidateIsValid(valid)).toBe(true);
  expect(sessionCandidateIsValid(valid.slice(0, -1))).toBe(false);
  expect(sessionCandidateIsValid(valid.replace('"schema_version":9', '"schema_version":8'))).toBe(false);
  expect(sessionCandidateIsValid('')).toBe(false);
  expect(sessionCandidateIsValid('{}')).toBe(false);
  // A whitespace variant is a different string and must be validated on its own.
  expect(sessionCandidateIsValid(`${valid.slice(0, -1)} }`)).toBe(true);
});

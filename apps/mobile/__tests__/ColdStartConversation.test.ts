import { createChatStore, serializeChatState, type ChatState } from '../src/state';
import { createColdStartConversationSelection } from '../src/state/coldStartConversation';

const options = { modelId: 'claude-haiku-4-5-20251001' as const, thinkingMode: 'off' as const };
let nextId = 0;
function makeStore() {
  return createChatStore({
    createId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    now: () => '2026-09-13T00:00:00.000Z',
  });
}

it('cold launch selects a blank after hydration, preserving history, settings and CAS authority', () => {
  const saved = makeStore();
  const previous = saved.createConversation(options);
  saved.appendUserMessage(previous, 'Keep this history');
  const store = makeStore();
  store.hydrate(serializeChatState(saved.getState()));
  const authority = { generation: 4, sessionSha256: 'a'.repeat(64) };
  store.setSessionAuthority(authority);
  const history = store.getState().conversations[previous];
  const select = createColdStartConversationSelection();
  expect(select(store, options)).toBe(true);
  const freshId = store.getState().selectedConversationId!;
  expect(freshId).not.toBe(previous);
  expect(store.getState().conversations[freshId]).toMatchObject({ ...options, messages: [] });
  expect(store.getState().conversations[previous]).toEqual(history);
  expect(store.getSessionAuthority()).toEqual(authority);
  // Explicit history/notification selection wins; resume cannot reset it.
  store.selectConversation(previous);
  expect(select(store, options)).toBe(false);
  expect(store.getState().selectedConversationId).toBe(previous);
  expect(store.getState().conversations[previous]).toEqual(history);
});

it('reuses a pristine blank on later launches instead of accumulating empty chats', () => {
  const store = makeStore();
  const history = store.createConversation(options);
  store.appendUserMessage(history, 'history');
  createColdStartConversationSelection()(store, options);
  const blank = store.getState().selectedConversationId;
  store.selectConversation(history);
  const count = Object.keys(store.getState().conversations).length;
  expect(createColdStartConversationSelection()(store, options)).toBe(true);
  expect(store.getState().selectedConversationId).toBe(blank);
  expect(Object.keys(store.getState().conversations)).toHaveLength(count);
  expect(createColdStartConversationSelection()(store, options)).toBe(false);
});

it('preserves named empty drafts and uses current default model/thinking settings', () => {
  const store = makeStore();
  const draft = store.createConversation({ ...options, title: 'A saved draft' });
  expect(createColdStartConversationSelection()(store, { ...options, thinkingMode: 'high' })).toBe(true);
  expect(store.getState().conversations[draft].title).toBe('A saved draft');
  expect(store.getState().conversations[store.getState().selectedConversationId!]).toMatchObject({
    modelId: options.modelId, thinkingMode: 'high', messages: [],
  });
});

it('leaves pending destructive recovery navigation untouched', () => {
  const store = makeStore();
  const previous = store.createConversation(options);
  store.appendUserMessage(previous, 'recover this conversation');
  const recoveryState: ChatState = {
    ...store.getState(),
    projectContextDestructiveTransition: {
      schemaVersion: 1, lifecycleId: '00000000-0000-4000-8000-000000000100',
      epoch: 1, action: 'rebind', phase: 'cleanup_pending', conversationId: previous,
      sourceProjectId: 'project', sourceRuntimeContextId: 'runtime', sourceModelId: options.modelId,
      snapshotId: 'snapshot', snapshotSha256: 'c'.repeat(64), consentReceiptId: 'consent',
      targetProjectId: 'target', createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z',
    },
  };
  jest.spyOn(store, 'getState').mockReturnValue(recoveryState);
  const create = jest.spyOn(store, 'createConversation');
  const select = jest.spyOn(store, 'selectConversation');
  expect(createColdStartConversationSelection()(store, options)).toBe(false);
  expect(create).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
});

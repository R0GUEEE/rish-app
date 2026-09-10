import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

import { MessageList } from '../src/components/MessageList';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import { createPreferencesStore } from '../src/preferences';
import { displayMessages } from '../src/screens/HomeScreen';
import type {
  ChatState,
  Conversation,
  PersistedSessionEventV3,
} from '../src/state';

const ATTEMPT_ID = 'attempt-1';
const OTHER_ATTEMPT_ID = 'attempt-2';
const SECRET = 'raw-secret-should-never-render';
const DIGEST = 'f'.repeat(64);

function event(
  overrides: Partial<PersistedSessionEventV3> &
    Pick<PersistedSessionEventV3, 'event_id' | 'seq' | 'kind' | 'status'>,
): PersistedSessionEventV3 {
  const { event_id, seq, kind, status, ...rest } = overrides;
  return {
    schema_version: 2,
    event_id,
    attempt_id: ATTEMPT_ID,
    seq,
    kind,
    round_index: null,
    call_id: null,
    status,
    safe_summary_key: null,
    arguments_sha256: null,
    result_sha256: null,
    approval_reference: null,
    failure_code: null,
    created_at: '2026-09-09T00:00:01.000Z',
    ...rest,
  } as PersistedSessionEventV3;
}

const events: readonly PersistedSessionEventV3[] = [
  event({
    event_id: 'call-read',
    seq: 1,
    kind: 'tool_call',
    round_index: 1,
    call_id: 'call-read',
    status: 'running',
    safe_summary_key: 'agent.read_file',
    arguments_sha256: DIGEST,
  }),
  event({
    event_id: 'call-write',
    seq: 2,
    kind: 'tool_call',
    round_index: 1,
    call_id: 'call-write',
    status: 'running',
    safe_summary_key: 'agent.write_file',
    arguments_sha256: DIGEST,
  }),
  event({
    event_id: 'result-read',
    seq: 3,
    kind: 'tool_result',
    round_index: 1,
    call_id: 'call-read',
    status: 'ok',
    result_sha256: DIGEST,
    created_at: '2026-09-09T00:00:01.125Z',
  }),
  event({
    event_id: 'cancel-write',
    seq: 4,
    kind: 'cancel',
    round_index: 1,
    call_id: 'call-write',
    status: 'cancelled',
    approval_reference: 'cancel-write',
    failure_code: 'E_AGENT_CANCELLED',
  }),
  event({
    event_id: 'call-round-two',
    seq: 5,
    kind: 'tool_call',
    round_index: 2,
    call_id: 'call-round-two',
    status: 'running',
    safe_summary_key: 'agent.read_file',
  }),
  event({
    event_id: 'terminal-round-two',
    seq: 6,
    kind: 'terminal',
    round_index: 2,
    status: 'unknown',
  }),
  // A repeated result updates the call block and must not append another one.
  event({
    event_id: 'result-read-again',
    seq: 7,
    kind: 'tool_result',
    round_index: 1,
    call_id: 'call-read',
    status: 'ok',
    result_sha256: DIGEST,
    created_at: '2026-09-09T00:00:01.125Z',
  }),
  // Same call id in another attempt must not affect this assistant message.
  event({
    event_id: 'other-attempt-result',
    seq: 8,
    attempt_id: OTHER_ATTEMPT_ID,
    kind: 'tool_result',
    call_id: 'call-round-two',
    status: 'ok',
  }),
];

const conversation: Conversation = {
  id: 'conversation-1',
  projectId: null,
  workspaceId: null,
  runtimeContextId: null,
  projectContext: null,
  title: 'Tool activity',
  titleSource: 'auto',
  modelId: 'gpt-5.6',
  thinkingMode: 'high',
  messages: [
    {
      id: 'user-1',
      role: 'user',
      text: 'Inspect the workspace',
      createdAt: '2026-09-09T00:00:00.000Z',
      attachments: [],
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      text: 'Safe answer',
      createdAt: '2026-09-09T00:00:02.000Z',
      attachments: [],
    },
  ],
  turns: [
    {
      schemaVersion: 1,
      turnId: 'turn-1',
      userMessageId: 'user-1',
      attemptIds: [ATTEMPT_ID],
      createdAt: '2026-09-09T00:00:00.000Z',
    },
  ],
  attempts: [
    {
      schemaVersion: 1,
      attemptId: ATTEMPT_ID,
      turnId: 'turn-1',
      status: 'completed',
      harnessId: 'codex',
      visibleMessageIds: ['user-1', 'assistant-1'],
      visibleHistorySha256: null,
      attachmentIds: [],
      modelId: 'gpt-5.6',
      thinkingMode: 'high',
      contextDisposition: 'unbound',
      contextProjectId: null,
      workspaceId: null,
      workspaceBindingRevision: null,
      projectContext: null,
      activeRound: null,
      rounds: [],
      assistantMessageId: 'assistant-1',
      failureCode: null,
      createdAt: '2026-09-09T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:02.000Z',
    },
  ],
  createdAt: '2026-09-09T00:00:00.000Z',
  updatedAt: '2026-09-09T00:00:02.000Z',
};

const chatState: ChatState = {
  schemaVersion: 9,
  projectContextDestructiveEpoch: 0,
  projectContextDestructiveTransition: null,
  conversations: { [conversation.id]: conversation },
  conversationOrder: [conversation.id],
  selectedConversationId: conversation.id,
  sessionEvents: events,
};

function projectedMessages() {
  return displayMessages(
    chatState.conversations[chatState.selectedConversationId!],
    {},
    chatState.sessionEvents,
  );
}

async function renderMessages() {
  const store = createPreferencesStore();
  store.setLocale('zh-CN');
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <AppPresentationProvider store={store}>
        <MessageList messages={projectedMessages()} />
      </AppPresentationProvider>,
    );
  });
  if (renderer === undefined) throw new Error('renderer missing');
  return renderer;
}

test('integrates real chat state events into one assistant tool timeline', async () => {
  const messages = projectedMessages();
  expect(messages).toHaveLength(2);
  const blocks = messages[1].blocks ?? [];
  expect(blocks.filter(block => block.type === 'tool-call')).toHaveLength(3);
  expect(blocks.filter(block => block.type === 'tool-result')).toHaveLength(0);
  expect(blocks.filter(block => block.type === 'tool-call').map(block => block.status)).toEqual([
    'success',
    'cancelled',
    'unknown',
  ]);
  expect(JSON.stringify(messages)).not.toContain(SECRET);
  expect(JSON.stringify(messages)).not.toContain(DIGEST);
});

test('keeps result updates and cancellation isolated by attempt, round, and call', () => {
  const assistant = projectedMessages()[1];
  const calls = (assistant.blocks ?? []).filter(
    block => block.type === 'tool-call',
  );
  expect(calls.map(call => call.type === 'tool-call' && call.name)).toEqual([
    'read_file',
    'write_file',
    'read_file',
  ]);
  expect(calls[0]).toMatchObject({ id: 'call-read', status: 'success', durationMs: 125 });
  expect(calls[1]).toMatchObject({ id: 'call-write', status: 'cancelled' });
  expect(calls[2]).toMatchObject({ id: 'call-round-two', status: 'unknown' });
});

test('renders localized status, duration, unknown terminal, and safe collapsed details', async () => {
  const renderer = await renderMessages();
  const root = renderer.root;
  expect(root.findByProps({ children: '成功 · 125 毫秒' })).toBeDefined();
  expect(root.findByProps({ children: '已取消' })).toBeDefined();
  expect(root.findByProps({ children: '未知' })).toBeDefined();
  expect(root.findAllByProps({ children: SECRET })).toHaveLength(0);
  expect(root.findAllByProps({ children: DIGEST })).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).not.toContain(SECRET);
  expect(JSON.stringify(renderer.toJSON())).not.toContain(DIGEST);
  await act(async () => renderer.unmount());
});

test.each(['sending', 'failed', 'cancelled'] as const)(
  'projects %s attempts without assistantMessageId into an activity-only row',
  status => {
    const attempt = conversation.attempts[0];
    const activityOnlyConversation: Conversation = {
      ...conversation,
      messages: [conversation.messages[0]],
      attempts: [{ ...attempt, status, assistantMessageId: null }],
    };
    const activityState: ChatState = {
      ...chatState,
      conversations: { [conversation.id]: activityOnlyConversation },
    };
    const messages = displayMessages(
      activityState.conversations[conversation.id],
      {},
      activityState.sessionEvents,
    );
    const activityRows = messages.filter(message => message.blocks !== undefined);
    expect(activityRows).toHaveLength(1);
    expect(activityRows[0].role).toBe('assistant');
    expect(activityRows[0].blocks?.some(block => block.type === 'tool-call')).toBe(true);
  },
);

test('moves the same activity row to the final assistant without duplicating tools', () => {
  const attempt = conversation.attempts[0];
  const activityOnlyConversation: Conversation = {
    ...conversation,
    messages: [conversation.messages[0]],
    attempts: [{ ...attempt, status: 'sending', assistantMessageId: null }],
  };
  const runningRows = displayMessages(activityOnlyConversation, {}, events);
  const finalRows = displayMessages(conversation, {}, events);
  const runningTools = runningRows.flatMap(row =>
    (row.blocks ?? []).filter(block => block.type === 'tool-call'),
  );
  const finalTools = finalRows.flatMap(row =>
    (row.blocks ?? []).filter(block => block.type === 'tool-call'),
  );
  expect(runningTools).toHaveLength(3);
  expect(finalTools).toHaveLength(3);
  expect(finalRows.filter(row => row.blocks !== undefined)).toHaveLength(1);
});

test('keeps activity-only rows isolated across attempts in the same turn history', () => {
  const secondAttempt = {
    ...conversation.attempts[0],
    attemptId: OTHER_ATTEMPT_ID,
    turnId: 'turn-1',
    status: 'sending' as const,
    visibleMessageIds: ['user-2'],
    assistantMessageId: null,
  };
  const multiAttempt: Conversation = {
    ...conversation,
    messages: [conversation.messages[0]],
    turns: [{ ...conversation.turns[0], attemptIds: [ATTEMPT_ID, OTHER_ATTEMPT_ID] }],
    attempts: [
      { ...conversation.attempts[0], assistantMessageId: null },
      secondAttempt,
    ],
  };
  const otherAttemptEvents: PersistedSessionEventV3[] = [];
  for (const sourceEvent of events) {
    if (sourceEvent.kind !== 'tool_call' && sourceEvent.kind !== 'tool_result') continue;
    otherAttemptEvents.push({
      ...sourceEvent,
      attempt_id: OTHER_ATTEMPT_ID,
      event_id: `other-${sourceEvent.event_id}`,
      call_id: sourceEvent.call_id === null ? null : `other-${sourceEvent.call_id}`,
    });
  }
  const rows = displayMessages(multiAttempt, {}, [...events, ...otherAttemptEvents]);
  const activityRows = rows.filter(row => row.blocks !== undefined);
  expect(activityRows).toHaveLength(2);
  expect(activityRows[0].blocks?.filter(block => block.type === 'tool-call').map(block => block.type === 'tool-call' && block.name)).toEqual(['read_file', 'write_file', 'read_file']);
  expect(activityRows[1].blocks?.filter(block => block.type === 'tool-call').map(block => block.type === 'tool-call' && block.name)).toEqual(['read_file', 'write_file', 'read_file']);
});

test('restores round prose around tools and keeps final output once without editing conversation', () => {
  const presentation = {
    schema_version: 1 as const, conversation_id: conversation.id, attempt_id: ATTEMPT_ID,
    rounds: [{ round_id: 'round-1', round_index: 1, kind: 'tool_batch' as const,
      text: 'Inspecting existing files.', reasoning: 'Provider supplied explanation.',
      assistant_text_sha256: '', reasoning_text_sha256: '',
    }, { round_id: 'round-3', round_index: 3, kind: 'final' as const,
      text: conversation.messages[1].text, reasoning: 'Final provider explanation.',
      assistant_text_sha256: '', reasoning_text_sha256: '',
    }],
  };
  const before = JSON.stringify(conversation);
  const first = displayMessages(conversation, {}, events, { [ATTEMPT_ID]: presentation });
  const restored = displayMessages(conversation, {}, events, JSON.parse(JSON.stringify({ [ATTEMPT_ID]: presentation })));
  expect(restored).toEqual(first);
  const blocks = first[1].blocks!;
  expect(blocks.slice(0, 4).map(block => block.type)).toEqual(['reasoning', 'text', 'tool-call', 'tool-call']);
  expect(blocks.filter(block => block.type === 'text' && block.text === conversation.messages[1].text)).toHaveLength(1);
  expect(JSON.stringify(conversation)).toBe(before);
});

test('reasoning preference stays hidden while provider body remains visible', async () => {
  const store = createPreferencesStore();
  const messages = [{ id: 'visible-prose', role: 'assistant' as const, text: '', blocks: [
    { id: 'r', type: 'reasoning' as const, text: 'Private display preference text' },
    { id: 't', type: 'text' as const, text: 'Visible provider body' },
  ] }];
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(<AppPresentationProvider store={store}><MessageList messages={messages} showReasoning={false} /></AppPresentationProvider>);
  });
  expect(JSON.stringify(renderer!.toJSON())).not.toContain('Private display preference text');
  expect(JSON.stringify(renderer!.toJSON())).toContain('Visible provider body');
  await act(async () => renderer!.unmount());
});

import {
  createAgentRoundPreviewState,
  reduceAgentRoundPreview,
  type AgentRoundPreviewState,
} from '../src/agent/AgentRoundPreview';
import type { AgentAttemptPresentation } from '../src/agent/AgentRoundPresentation';
import { projectRoundPreviews } from '../src/components/agentActivityProjection';
import { displayMessages } from '../src/screens/HomeScreen';
import type { Conversation, PersistedSessionEventV3 } from '../src/state/types';

const ATTEMPT = 'attempt-1';
const ROUND = '11111111-1111-4111-8111-111111111111';
const labels = { thinking: 'Thinking' };
const correlation = {
  taskId: 'turn-1',
  attemptId: ATTEMPT,
  roundId: ROUND,
  roundIndex: 0,
  operationId: 'op-1',
  providerRequestId: 'req-1',
  harnessId: 'dsh',
} as const;

function preview(...events: readonly Parameters<typeof reduceAgentRoundPreview>[1][]): AgentRoundPreviewState {
  return events.reduce(reduceAgentRoundPreview, createAgentRoundPreviewState(correlation));
}

const streaming = preview(
  { ...correlation, kind: 'delta', seq: 1, reasoning: 'Looking at the tree' },
  { ...correlation, kind: 'delta', seq: 2, text: 'I will read it.' },
  { ...correlation, kind: 'delta', seq: 3, toolCalls: [{ index: 0, id: 'call_1', name: 'read_file', arguments: '{"path":' }] },
  { ...correlation, kind: 'delta', seq: 4, toolCalls: [{ index: 0, arguments: '"a.txt"}' }] },
);

const inFlightConversation: Conversation = {
  id: 'conversation-1',
  projectId: null,
  workspaceId: null,
  runtimeContextId: null,
  projectContext: null,
  title: 'Preview',
  titleSource: 'auto',
  modelId: 'deepseek-v4-flash',
  thinkingMode: 'high',
  messages: [
    { id: 'user-1', role: 'user', text: 'Read a.txt', createdAt: '2026-09-13T00:00:00.000Z', attachments: [] },
  ],
  turns: [
    { schemaVersion: 1, turnId: 'turn-1', userMessageId: 'user-1', attemptIds: [ATTEMPT], createdAt: '2026-09-13T00:00:00.000Z' },
  ],
  attempts: [
    {
      schemaVersion: 1,
      attemptId: ATTEMPT,
      turnId: 'turn-1',
      status: 'sending',
      harnessId: 'dsh',
      visibleMessageIds: ['user-1'],
      visibleHistorySha256: null,
      attachmentIds: [],
      modelId: 'deepseek-v4-flash',
      thinkingMode: 'high',
      contextDisposition: 'unbound',
      contextProjectId: null,
      workspaceId: null,
      workspaceBindingRevision: null,
      projectContext: null,
      activeRound: null,
      rounds: [],
      assistantMessageId: null,
      failureCode: null,
      createdAt: '2026-09-13T00:00:00.000Z',
      updatedAt: '2026-09-13T00:00:00.000Z',
    },
  ],
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:00.000Z',
};

test('a streaming round projects reasoning, text and provisional tool cards in order', () => {
  const blocks = projectRoundPreviews({ [ROUND]: streaming }, ATTEMPT, [], undefined, labels);
  expect(blocks.map(block => block.type)).toEqual(['reasoning', 'text', 'tool-call']);
  expect(blocks[0]).toMatchObject({ text: 'Looking at the tree' });
  expect(blocks[1]).toMatchObject({ text: 'I will read it.', reveal: true });
  expect(blocks[2]).toMatchObject({ name: 'read_file', arguments: '{"path":"a.txt"}', status: 'pending' });
  expect(blocks.every(block => block.id.startsWith(`preview-${ATTEMPT}-${ROUND}`))).toBe(true);
});

test('an empty preview shows a thinking activity line, and other attempts are ignored', () => {
  const empty = createAgentRoundPreviewState(correlation);
  expect(projectRoundPreviews({ [ROUND]: empty }, ATTEMPT, [], undefined, labels)).toEqual([
    { id: `preview-${ATTEMPT}-${ROUND}-activity`, type: 'activity', label: 'Thinking' },
  ]);
  expect(projectRoundPreviews({ [ROUND]: empty }, 'other-attempt', [], undefined, labels)).toEqual([]);
});

test('a round vanishes from the preview once it is durable or failed', () => {
  const presentation: AgentAttemptPresentation = {
    schema_version: 1,
    conversation_id: 'conversation-1',
    attempt_id: ATTEMPT,
    rounds: [{
      round_id: ROUND, round_index: 0, kind: 'tool_batch', text: 'I will read it.', reasoning: '',
      assistant_text_sha256: 'a'.repeat(64), reasoning_text_sha256: 'b'.repeat(64),
    }],
  };
  // The presentation lands before the batch is persisted: the text yields
  // to it while the provisional tool cards stay until tool events exist.
  expect(projectRoundPreviews({ [ROUND]: streaming }, ATTEMPT, [], presentation, labels).map(block => block.type)).toEqual(['tool-call']);
  const event = {
    schema_version: 2, event_id: 'call-1', seq: 1, conversation_id: 'conversation-1', turn_id: 'turn-1',
    attempt_id: ATTEMPT, round_index: 0, kind: 'tool_call', call_id: 'call_1', status: 'running',
    safe_summary_key: 'agent.read_file', created_at: '2026-09-13T00:00:01.000Z',
  } as unknown as PersistedSessionEventV3;
  expect(projectRoundPreviews({ [ROUND]: streaming }, ATTEMPT, [event], undefined, labels).map(block => block.type)).toEqual(['reasoning', 'text']);
  expect(projectRoundPreviews({ [ROUND]: streaming }, ATTEMPT, [event], presentation, labels)).toEqual([]);
  // A second provisional call whose own event has not landed stays visible
  // next to the durable first one instead of vanishing with it.
  const twoCalls = reduceAgentRoundPreview(streaming, {
    ...correlation, kind: 'delta', seq: 5, toolCalls: [{ index: 1, id: 'call_2', name: 'list_dir', arguments: '{}' }],
  });
  expect(projectRoundPreviews({ [ROUND]: twoCalls }, ATTEMPT, [event], presentation, labels)).toEqual([
    { id: `preview-${ATTEMPT}-${ROUND}-call-1`, type: 'tool-call', name: 'list_dir', arguments: '{}', status: 'pending' },
  ]);
  // The begin-round launch marker exists before any delta arrives and must
  // not hide the preview.
  const launch = {
    ...event, event_id: 'round-0', kind: 'round', call_id: null, status: 'running', safe_summary_key: null,
  } as unknown as PersistedSessionEventV3;
  expect(projectRoundPreviews({ [ROUND]: streaming }, ATTEMPT, [launch], undefined, labels).length).toBe(3);
  const failed = reduceAgentRoundPreview(streaming, {
    ...correlation, kind: 'end', seq: 5, status: 'failed', failureCode: 'E_COMPLETION_TIMEOUT', truncated: false,
  });
  expect(projectRoundPreviews({ [ROUND]: failed }, ATTEMPT, [], undefined, labels)).toEqual([]);
});

test('displayMessages renders the preview under the user turn and a pending placeholder before it', () => {
  const rows = displayMessages(inFlightConversation, {}, [], {}, { [ROUND]: streaming });
  expect(rows.map(row => row.id)).toEqual(['user-1', `activity-${ATTEMPT}`]);
  expect(rows[1].blocks?.map(block => block.type)).toEqual(['reasoning', 'text', 'tool-call']);

  const pending = displayMessages(inFlightConversation, {}, [], {}, {}, ATTEMPT);
  expect(pending[1].blocks).toEqual([{ id: `pending-${ATTEMPT}`, type: 'activity', label: 'Thinking' }]);

  expect(displayMessages(inFlightConversation, {}, [], {}, {}, null).map(row => row.id)).toEqual(['user-1']);
});

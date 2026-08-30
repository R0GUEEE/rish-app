import { NativeModules } from 'react-native';

const stubWorkspace = {
  isAvailable: jest.fn(),
  listDirectory: jest.fn(),
  readText: jest.fn(),
  writeText: jest.fn().mockResolvedValue({
    created: true,
    file: { path: 'a', name: 'a', kind: 'file', size: 0 },
  }),
  capabilities: jest.fn(),
  createDirectory: jest.fn(),
  renameEntry: jest.fn(),
  trashEntry: jest.fn(),
  listTrash: jest.fn(),
  restoreFromTrash: jest.fn(),
  executePortableTool: jest.fn(),
};
const stubProjects = {
  isAvailable: jest.fn(),
  list: jest.fn(),
  create: jest.fn(),
  clone: jest.fn(),
  status: jest.fn(),
  diff: jest.fn(),
  stageAll: jest.fn(),
  commit: jest.fn(),
  setRemote: jest.fn(),
  credentialStatus: jest.fn(),
  presentCredentialPrompt: jest.fn(),
  clearCredential: jest.fn(),
  push: jest.fn(),
};
(NativeModules as Record<string, unknown>).LocalWorkspace = stubWorkspace;
(NativeModules as Record<string, unknown>).LocalProjects = stubProjects;

// Loaded via requireActual AFTER the native stubs are installed: the tool
// executor captures NativeModules.LocalWorkspace at module init, and static
// ESM imports would hoist above this assignment.
const { createAgentTurnService } = jest.requireActual(
  '../src/agent/AgentTurnService',
) as typeof import('../src/agent/AgentTurnService');
import { createAgentInteractionController } from '../src/agent/AgentInteractionController';
import {
  createSessionEventJournal,
  replayAssistantTurn,
  type SessionEventV1,
} from '../src/agent/SessionEvents';
import {
  unansweredApprovalRequests,
  unansweredQuestions,
} from '../src/agent/AgentApprovals';

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise<void>(resolve => {
      setTimeout(() => resolve(), 0);
    });
  }
  throw new Error('waitFor timeout');
}

function modelRounds(
  rounds: Array<{ text: string; tool_calls: Array<{ id: string; name: string; arguments: string }> }>,
) {
  let index = 0;
  const calls: jest.Mock = jest.fn(async () => {
    const round = rounds[Math.min(index, rounds.length - 1)];
    index += 1;
    return {
      text: round.text,
      finish_reason: round.tool_calls.length > 0 ? 'tool_calls' : 'stop',
      tool_calls: round.tool_calls,
    };
  });
  return { calls, history: () => calls.mock.calls.map(c => c[0]) };
}

let approvalCounter = 0;
let questionCounter = 0;

function makeService(options: { approvalTimeoutMs?: number } = {}) {
  const journal = createSessionEventJournal();
  const interactions = createAgentInteractionController({
    ...(options.approvalTimeoutMs !== undefined
      ? { approvalTimeoutMs: options.approvalTimeoutMs }
      : {}),
  });
  return { journal, interactions };
}

beforeEach(() => {
  jest.clearAllMocks();
  approvalCounter = 0;
  questionCounter = 0;
});

test('denied approvals never execute and replay in order after a restart', async () => {
  const { journal, interactions } = makeService();
  const model = modelRounds([
    {
      text: '',
      tool_calls: [
        { id: 'c1', name: 'write_file', arguments: '{"path":"a","content":"x"}' },
      ],
    },
    { text: 'Stopped, nothing written.', tool_calls: [] },
  ]);
  const serviceWithModel = createAgentTurnService({
    journal,
    interactions,
    modelCalls: model.calls as never,
    createApprovalId: () => 'ap-' + (++approvalCounter),
    createQuestionId: () => 'q-' + (++questionCounter),
  });

  const turn = serviceWithModel.start({
    projectId: 'proj-1',
    model: 'deepseek-v4-flash',
    thinkingMode: 'high',
    history: [{ role: 'user', content: 'write a' }],
    requestId: 'att-1',
  });
  await waitFor(() => interactions.getState().pendingApproval !== null);
  interactions.decideApproval('ap-1', {
    status: 'denied',
    approval_id: 'ap-1',
  });
  const result = await turn;

  expect(result.status).toBe('done');
  expect(stubWorkspace.writeText).not.toHaveBeenCalled();
  const rows = journal.snapshot();
  const kinds = rows.map(row => row.kind);
  expect(kinds).toEqual([
    'tool_call',
    'approval_request',
    'approval_response',
    'tool_result',
    'assistant_text',
  ]);
  expect(rows[1]).toMatchObject({
    approval_id: 'ap-1',
    tool_call_id: 'c1',
    tool_name: 'write_file',
    approval_scopes_json: '["once","conversation"]',
  });
  expect(rows[2]).toMatchObject({
    approval_id: 'ap-1',
    approval_decision: 'denied',
    approval_resolution: 'user',
  });
  expect(rows[3]).toMatchObject({ tool_call_id: 'c1', outcome: 'denied' });
  expect(unansweredApprovalRequests(rows, 'att-1')).toEqual([]);

  // Restart replay: serialize, restore into a fresh journal, replay.
  const serialized = JSON.parse(
    JSON.stringify({ session_events: rows }),
  ) as unknown;
  const restored = createSessionEventJournal(
    (serialized as { session_events: SessionEventV1[] }).session_events,
  );
  const replay = replayAssistantTurn(restored.snapshot(), 'att-1');
  expect(replay.map(row => row.kind)).toEqual([
    'tool_call',
    'approval_request',
    'approval_response',
    'tool_result',
    'assistant_text',
  ]);
  expect(replay.map(row => row.seq)).toEqual([0, 1, 2, 3, 4]);
});

test('conversation-scope approval executes the tool and grants the rest of the turn', async () => {
  const { journal, interactions } = makeService();
  const model = modelRounds([
    {
      text: '',
      tool_calls: [
        { id: 'c1', name: 'write_file', arguments: '{"path":"a","content":"x"}' },
        { id: 'c2', name: 'write_file', arguments: '{"path":"b","content":"y"}' },
      ],
    },
    { text: 'Both written.', tool_calls: [] },
  ]);
  const service = createAgentTurnService({
    journal,
    interactions,
    modelCalls: model.calls as never,
    createApprovalId: () => 'ap-' + (++approvalCounter),
    createQuestionId: () => 'q-' + (++questionCounter),
  });

  const turn = service.start({
    projectId: 'proj-1',
    model: 'deepseek-v4-flash',
    thinkingMode: 'high',
    history: [{ role: 'user', content: 'write both' }],
    requestId: 'att-1',
  });
  await waitFor(() => interactions.getState().pendingApproval !== null);
  interactions.decideApproval('ap-1', {
    status: 'approved',
    approval_id: 'ap-1',
    scope: 'conversation',
  });
  const result = await turn;

  expect(result.status).toBe('done');
  expect(stubWorkspace.writeText).toHaveBeenCalledTimes(2);
  const rows = journal.snapshot();
  expect(
    rows.filter(row => row.kind === 'approval_request'),
  ).toHaveLength(1);
  expect(rows.find(row => row.kind === 'approval_response')).toMatchObject({
    approval_decision: 'approved',
    approval_scope: 'conversation',
  });
  const toolResults = rows.filter(row => row.kind === 'tool_result');
  expect(toolResults.map(row => row.outcome)).toEqual(['ok', 'ok']);
});

test('structured questions flow through the real service into the journal', async () => {
  const { journal, interactions } = makeService();
  const model = modelRounds([
    {
      text: '',
      tool_calls: [
        {
          id: 'q1',
          name: 'ask_user',
          arguments: JSON.stringify({
            question: 'Which file?',
            input_mode: 'options',
            options: [
              { id: 'a', label: 'notes.md' },
              { id: 'b', label: 'todo.md' },
            ],
          }),
        },
      ],
    },
    { text: 'Opening notes.md.', tool_calls: [] },
  ]);
  const service = createAgentTurnService({
    journal,
    interactions,
    modelCalls: model.calls as never,
    createApprovalId: () => 'ap-' + (++approvalCounter),
    createQuestionId: () => 'q-' + (++questionCounter),
  });

  const turn = service.start({
    projectId: 'proj-1',
    model: 'deepseek-v4-flash',
    thinkingMode: 'high',
    history: [{ role: 'user', content: 'open a file' }],
    requestId: 'att-1',
  });
  await waitFor(() => interactions.getState().pendingQuestion !== null);
  interactions.answerQuestion('q-1', 'a');
  const result = await turn;

  expect(result.status).toBe('done');
  const rows = journal.snapshot();
  expect(rows.map(row => row.kind)).toEqual([
    'tool_call',
    'question',
    'question_response',
    'tool_result',
    'assistant_text',
  ]);
  expect(rows[1]).toMatchObject({
    question_id: 'q-1',
    question_input_mode: 'options',
  });
  expect(rows[2]).toMatchObject({
    question_id: 'q-1',
    question_response_status: 'answered',
    answer: 'a',
  });
  expect(unansweredQuestions(rows, 'att-1')).toEqual([]);
  const followup = model.history()[1];
  const lastUser = followup.history[followup.history.length - 1];
  expect(lastUser.content).toContain('answered: a');
});

test('an unanswered approval times out fail-closed through the service', async () => {
  jest.useFakeTimers();
  try {
    const { journal, interactions } = makeService({
      approvalTimeoutMs: 1000,
    });
    const model = modelRounds([
      {
        text: '',
        tool_calls: [
          { id: 'c1', name: 'write_file', arguments: '{"path":"a","content":"x"}' },
        ],
      },
      { text: 'Stopped.', tool_calls: [] },
    ]);
    const serviceWithModel = createAgentTurnService({
      journal,
      interactions,
      modelCalls: model.calls as never,
      createApprovalId: () => 'ap-' + (++approvalCounter),
      createQuestionId: () => 'q-' + (++questionCounter),
      approvalTimeoutMs: 1000,
    });

    const turn = serviceWithModel.start({
      projectId: 'proj-1',
      model: 'deepseek-v4-flash',
      thinkingMode: 'high',
      history: [{ role: 'user', content: 'write a' }],
      requestId: 'att-1',
    });
    await jest.advanceTimersByTimeAsync(50);
    expect(interactions.getState().pendingApproval).not.toBeNull();
    await jest.advanceTimersByTimeAsync(2000);
    const result = await turn;

    expect(result.status).toBe('done');
    expect(stubWorkspace.writeText).not.toHaveBeenCalled();
    const rows = journal.snapshot();
    expect(rows.find(row => row.kind === 'approval_response')).toMatchObject({
      approval_decision: 'denied',
      approval_resolution: 'timeout',
    });
    expect(rows.find(row => row.kind === 'tool_result')).toMatchObject({
      outcome: 'denied',
    });
    expect(interactions.getState().pendingApproval).toBeNull();
    // service.isRunning settled back.
    expect(serviceWithModel.isRunning()).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test('cancel while awaiting settles fail-closed and ends the turn', async () => {
  const { journal, interactions } = makeService();
  const model = modelRounds([
    {
      text: '',
      tool_calls: [
        { id: 'c1', name: 'write_file', arguments: '{"path":"a","content":"x"}' },
      ],
    },
    { text: 'unused', tool_calls: [] },
  ]);
  const service = createAgentTurnService({
    journal,
    interactions,
    modelCalls: model.calls as never,
    createApprovalId: () => 'ap-' + (++approvalCounter),
    createQuestionId: () => 'q-' + (++questionCounter),
  });

  const turn = service.start({
    projectId: 'proj-1',
    model: 'deepseek-v4-flash',
    thinkingMode: 'high',
    history: [{ role: 'user', content: 'write a' }],
    requestId: 'att-1',
  });
  await waitFor(() => interactions.getState().pendingApproval !== null);
  service.cancel();
  const result = await turn;

  expect(result.status).toBe('cancelled');
  expect(stubWorkspace.writeText).not.toHaveBeenCalled();
  const rows = journal.snapshot();
  expect(rows.find(row => row.kind === 'approval_response')).toMatchObject({
    approval_decision: 'denied',
    approval_resolution: 'cancelled',
  });
});

test('a second concurrent start is refused with a busy failure', async () => {
  const { journal, interactions } = makeService();
  const model = modelRounds([
    {
      text: '',
      tool_calls: [
        { id: 'c1', name: 'write_file', arguments: '{"path":"a","content":"x"}' },
      ],
    },
    { text: 'done', tool_calls: [] },
  ]);
  const service = createAgentTurnService({
    journal,
    interactions,
    modelCalls: model.calls as never,
    createApprovalId: () => 'ap-' + (++approvalCounter),
    createQuestionId: () => 'q-' + (++questionCounter),
  });

  const turnA = service.start({
    projectId: 'proj-1',
    model: 'deepseek-v4-flash',
    thinkingMode: 'high',
    history: [{ role: 'user', content: 'write a' }],
    requestId: 'att-1',
  });
  await waitFor(() => interactions.getState().pendingApproval !== null);
  const busy = await service.start({
    projectId: 'proj-1',
    model: 'deepseek-v4-flash',
    thinkingMode: 'high',
    history: [{ role: 'user', content: 'write a' }],
    requestId: 'att-2',
  });
  expect(busy.status).toBe('failed');
  expect(busy.failure?.code).toBe('E_AGENT_TURN_BUSY');
  service.cancel();
  const result = await turnA;
  expect(result.status).toBe('cancelled');
});

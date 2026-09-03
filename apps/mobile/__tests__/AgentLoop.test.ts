import {
  MAX_AGENT_ROUNDS,
  agentLoopReduce,
  agentToolAccess,
  type AgentLoopCommand,
  type AgentLoopEvent,
  type AgentLoopState,
} from '../src/agent/AgentLoop';

const BASE_HISTORY = [
  { role: 'user' as const, content: 'Add X to README and push' },
];

const TOOL_DEFS = [
  { name: 'list_dir', parameters: {} },
  { name: 'read_file', parameters: {} },
  { name: 'write_file', parameters: {} },
  { name: 'git_commit', parameters: {} },
  { name: 'git_push', parameters: {} },
];

type RunOutcome = {
  state: AgentLoopState | null;
  commands: readonly AgentLoopCommand[];
};

function start(): RunOutcome {
  return run(null, { kind: 'started', history: BASE_HISTORY, tools: TOOL_DEFS });
}

function run(state: AgentLoopState | null, event: AgentLoopEvent): RunOutcome {
  return agentLoopReduce(state, event);
}

describe('agent tool policies', () => {
  test('read-only tools are automatic', () => {
    expect(agentToolAccess('list_dir')).toBe('auto');
    expect(agentToolAccess('read_file')).toBe('auto');
    expect(agentToolAccess('git_status')).toBe('auto');
  });
  test('mutations and push confirm per conversation', () => {
    expect(agentToolAccess('write_file')).toBe('conversation_confirm');
    expect(agentToolAccess('git_commit')).toBe('conversation_confirm');
    expect(agentToolAccess('git_push')).toBe('conversation_confirm');
  });
  test('unknown names fail safe behind confirmation', () => {
    expect(agentToolAccess('deploy_prod')).toBe('confirm_once');
  });
});

describe('agent loop reduce', () => {
  test('starting a fresh turn requests a completion round with tools', () => {
    const { state, commands } = start();
    expect(state?.phase).toBe('awaiting_model');
    expect(state?.round).toBe(0);
    expect(commands).toEqual([
      {
        kind: 'request_round',
        round: 0,
        baseHistory: BASE_HISTORY,
        feedbackRows: [],
        tools: TOOL_DEFS,
      },
    ]);
  });

  test('a plain answer finishes the loop with the final text', () => {
    const started = start();
    const { state, commands } = run(started.state, {
      kind: 'model_result',
      text: 'Done planning.',
      toolCalls: [],
    });
    expect(state?.phase).toBe('done');
    expect(state?.finalText).toBe('Done planning.');
    expect(commands).toEqual([]);
  });

  test('read-only tool calls execute immediately and feed the next round', () => {
    const started = start();
    const first = run(started.state, {
      kind: 'model_result',
      text: '',
      toolCalls: [
        { id: 'c1', name: 'list_dir', arguments: '{"path":"."}' },
        { id: 'c2', name: 'read_file', arguments: '{"path":"README.md"}' },
      ],
    });
    // Only the first call executes; the second waits its turn.
    expect(first.commands).toEqual([
      {
        kind: 'execute_tool',
        round: 1,
        call: { id: 'c1', name: 'list_dir', arguments: '{"path":"."}' },
      },
    ]);
    expect(first.state?.phase).toBe('executing_tool');

    const done1 = run(first.state, {
      kind: 'tool_outcome',
      callId: 'c1',
      ok: true,
      outputDigest: 'sha:abc1',
    });
    expect(done1.state?.phase).toBe('executing_tool');
    expect(done1.commands).toEqual([
      {
        kind: 'execute_tool',
        round: 1,
        call: { id: 'c2', name: 'read_file', arguments: '{"path":"README.md"}' },
      },
    ]);

    const done2 = run(done1.state, {
      kind: 'tool_outcome',
      callId: 'c2',
      ok: true,
      outputDigest: 'sha:def2',
    });
    // Both outcomes collected → model gets one follow-up round carrying them.
    expect(done2.state?.phase).toBe('awaiting_model');
    expect(done2.state?.round).toBe(1);
    expect(done2.commands).toHaveLength(1);
    expect(done2.commands[0]).toMatchObject({
      kind: 'request_round',
      round: 1,
      feedbackRows: [
        {
          callId: 'c1',
          name: 'list_dir',
          arguments: '{"path":"."}',
          ok: true,
          outputDigest: 'sha:abc1',
        },
        {
          callId: 'c2',
          name: 'read_file',
          arguments: '{"path":"README.md"}',
          ok: true,
          outputDigest: 'sha:def2',
        },
      ],
    });
  });

  test('mutating tools park the loop until approval is granted', () => {
    const started = start();
    const asked = run(started.state, {
      kind: 'model_result',
      text: '',
      toolCalls: [{ id: 'w1', name: 'write_file', arguments: '{}' }],
    });
    expect(asked.state?.phase).toBe('awaiting_approval');
    expect(asked.commands).toEqual([]);

    const granted = run(asked.state, { kind: 'approval_decision', approved: true });
    expect(granted.state?.phase).toBe('executing_tool');
    expect(granted.commands[0]).toMatchObject({ kind: 'execute_tool', call: { id: 'w1', name: 'write_file' } });

    const executed = run(granted.state, {
      kind: 'tool_outcome',
      callId: 'w1',
      ok: true,
      outputDigest: 'bytes:12',
    });
    expect(executed.state?.phase).toBe('awaiting_model');
    expect(executed.state?.traces[0]?.approved).toBe(true);
  });

  test('denied tools are recorded as blocked and still reported back to the model', () => {
    const started = start();
    const asked = run(started.state, {
      kind: 'model_result',
      text: '',
      toolCalls: [{ id: 'p1', name: 'git_push', arguments: '{}' }],
    });
    expect(asked.state?.phase).toBe('awaiting_approval');

    const denied = run(asked.state, { kind: 'approval_decision', approved: false });
    expect(denied.state?.phase).toBe('awaiting_model');
    expect(denied.state?.traces[0]).toMatchObject({
      callId: 'p1',
      name: 'git_push',
      approved: false,
      ok: false,
    });
    expect(denied.commands[0]).toMatchObject({
      kind: 'request_round',
      round: 1,
      feedbackRows: [
        { callId: 'p1', name: 'git_push', ok: false, blocked: 'denied_by_user' },
      ],
    });
  });

  test('mixed batches execute the automatic ones and park on the first gated call', () => {
    const started = start();
    const mixed = run(started.state, {
      kind: 'model_result',
      text: '',
      toolCalls: [
        { id: 'r1', name: 'read_file', arguments: '{"path":"a"}' },
        { id: 'w1', name: 'git_commit', arguments: '{}' },
        { id: 'r2', name: 'list_dir', arguments: '{}' },
      ],
    });
    expect(mixed.state?.phase).toBe('awaiting_approval');
    expect((mixed.state as AgentLoopState).pendingCalls.map(c => c.id)).toEqual([
      'r1',
      'w1',
      'r2',
    ]);
    expect(mixed.commands).toEqual([]);
  });

  test('a failing tool fails the loop with the structured reason', () => {
    const started = start();
    const asked = run(started.state, {
      kind: 'model_result',
      text: '',
      toolCalls: [{ id: 'r1', name: 'read_file', arguments: '{}' }],
    });
    const failed = run(asked.state, {
      kind: 'tool_outcome',
      callId: 'r1',
      ok: false,
      detail: 'E_WORKSPACE_REVOKED',
    });
    expect(failed.state?.phase).toBe('failed');
    expect(failed.state?.failure).toMatchObject({ code: 'E_WORKSPACE_REVOKED' });
  });

  test('the eighth completed round is the last: further tool demands end honestly', () => {
    let state: AgentLoopState | null = null;
    // Drive the loop through MAX_AGENT_ROUNDS read-only single-call turns.
    state = run(state, { kind: 'started', history: BASE_HISTORY, tools: TOOL_DEFS }).state;
    for (let i = 0; i < MAX_AGENT_ROUNDS; ++i) {
      state = run(state, {
        kind: 'model_result',
        text: '',
        toolCalls: [{ id: `c${i}`, name: 'list_dir', arguments: '{}' }],
      }).state;
      state = run(state, {
        kind: 'tool_outcome',
        callId: `c${i}`,
        ok: true,
        outputDigest: `d${i}`,
      }).state;
    }
    expect(state?.round).toBe(MAX_AGENT_ROUNDS);

    // One more demand cannot start another round: the loop ends honestly.
    const refused = run(state, {
      kind: 'model_result',
      text: '',
      toolCalls: [{ id: 'overflow', name: 'list_dir', arguments: '{}' }],
    });
    expect(refused.state?.phase).toBe('done');
    expect(refused.state?.exhausted).toBe(true);
    expect(refused.commands).toEqual([]);
  });

  test('cancel stops any live phase and is ignored once settled', () => {
    const started = start();
    const cancelledEarly = run(started.state, { kind: 'cancel' });
    expect(cancelledEarly.state?.phase).toBe('cancelled');

    // Restart a new loop and settle it; cancelling afterwards must not move it.
    const again = start();
    const settled = run(again.state, {
      kind: 'model_result',
      text: 'final',
      toolCalls: [],
    });
    const ignored = run(settled.state, { kind: 'cancel' });
    expect(ignored.state).toBe(settled.state);
    expect(ignored.commands).toEqual([]);
  });

  test('events that contradict the phase are ignored without side effects', () => {
    const started = start();
    const bogus = run(started.state, { kind: 'approval_decision', approved: true });
    expect(bogus.state).toBe(started.state);
    expect(bogus.commands).toEqual([]);
  });

  test('model failures mark the loop failed and preserve the reason', () => {
    const started = start();
    const failed = run(started.state, {
      kind: 'model_failed',
      message: 'E_TRANSPORT_TIMEOUT',
    });
    expect(failed.state?.phase).toBe('failed');
    expect(failed.state?.failure).toEqual({ code: 'E_TRANSPORT_TIMEOUT' });
  });
});

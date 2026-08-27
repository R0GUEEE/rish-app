import { MAX_AGENT_ROUNDS } from '../src/agent/AgentLoop';
import { runAgentTurn } from '../src/agent/runAgentTurn';

type Deps = Parameters<typeof runAgentTurn>[0]['deps'];

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    modelCalls: jest.fn(),
    executeTool: jest.fn(async () => ({
      ok: true,
      outputDigest: 'bytes:1',
    })),
    requestApproval: jest.fn(async () => true),
    onTrace: jest.fn(),
    ...overrides,
  };
}

const BASE = { projectId: 'proj-1', model: 'deepseek-v4-flash' as const,
  thinkingMode: 'high' as const };

const TOOLS = [{ name: 'read_file', parameters: {} }];

test('a turn with no tool demands makes exactly one model call and finishes', async () => {
  const deps = makeDeps({
    modelCalls: jest.fn().mockResolvedValueOnce({
      text: 'All set.',
      finish_reason: 'stop',
      tool_calls: [],
    }),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'status?' }],
    tools: TOOLS,
    deps,
  });

  expect(result.status).toBe('done');
  expect(result.finalText).toBe('All set.');
  expect(result.traces).toHaveLength(0);
  expect(deps.modelCalls).toHaveBeenCalledTimes(1);
  const firstCall = (deps.modelCalls as jest.Mock).mock.calls[0][0];
  expect(
    firstCall.history[firstCall.history.length - 1],
  ).toEqual({ role: 'user', content: 'status?' });
  expect(firstCall.tools).toEqual(TOOLS);
});

test('executes read-only tools then reports outcomes back in the follow-up round', async () => {
  const deps = makeDeps({
    modelCalls: jest.fn()
      .mockResolvedValueOnce({
        text: '',
        finish_reason: 'tool_calls',
        tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }],
      })
      .mockResolvedValueOnce({
        text: 'Read it.',
        finish_reason: 'stop',
        tool_calls: [],
      }),
    executeTool: jest.fn().mockResolvedValueOnce({
      ok: true,
      outputDigest: 'bytes:12:sha1:92380ee3',
    }),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'read a' }],
    tools: TOOLS,
    deps,
  });

  expect(result.status).toBe('done');
  expect(result.finalText).toBe('Read it.');
  expect(result.traces).toEqual([
    { callId: 'c1', name: 'read_file', arguments: '{"path":"a"}',
      approved: true, ok: true, outputDigest: 'bytes:12:sha1:92380ee3' },
  ]);
  expect(deps.modelCalls).toHaveBeenCalledTimes(2);
  const followupCall = (deps.modelCalls as jest.Mock).mock.calls[1][0];
  const lastUser = followupCall.history[followupCall.history.length - 1];
  expect(lastUser.role).toBe('user');
  expect(lastUser.content).toContain('read_file');
  expect(lastUser.content).toContain('bytes:12:sha1:92380ee3');
});

test('gated calls surface through requestApproval before executing', async () => {
  const deps = makeDeps({
    modelCalls: jest.fn()
      .mockResolvedValueOnce({
        text: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          { id: 'w1', name: 'write_file', arguments: '{"path":"n","content":"x"}' },
        ],
      })
      .mockResolvedValueOnce({
        text: 'Wrote it.',
        finish_reason: 'stop',
        tool_calls: [],
      }),
    executeTool: jest.fn().mockResolvedValueOnce({
      ok: true,
      outputDigest: 'bytes:1',
    }),
    requestApproval: jest.fn().mockResolvedValueOnce(true),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'write n' }],
    tools: [{ name: 'write_file', parameters: {} }],
    deps,
  });

  expect(deps.requestApproval).toHaveBeenCalledWith(
    expect.objectContaining({ callId: 'w1', name: 'write_file' }),
  );
  expect(deps.executeTool).toHaveBeenCalledTimes(1);
  expect(result.status).toBe('done');
  expect(result.finalText).toBe('Wrote it.');
});

test('denied gated calls skip execution and still close the loop', async () => {
  const deps = makeDeps({
    modelCalls: jest.fn()
      .mockResolvedValueOnce({
        text: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          { id: 'p1', name: 'git_push', arguments: '{}' },
        ],
      })
      .mockResolvedValueOnce({
        text: 'Understood, staying local.',
        finish_reason: 'stop',
        tool_calls: [],
      }),
    executeTool: jest.fn(),
    requestApproval: jest.fn().mockResolvedValueOnce(false),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'push please' }],
    tools: [{ name: 'git_push', parameters: {} }],
    deps,
  });

  expect(deps.executeTool).not.toHaveBeenCalled();
  expect(result.status).toBe('done');
  expect(result.traces[0]).toMatchObject({
    callId: 'p1', approved: false, ok: false, blocked: 'denied_by_user',
  });
});

test('tool failures fail the turn with the structured code', async () => {
  const deps = makeDeps({
    modelCalls: jest.fn().mockResolvedValueOnce({
      text: '',
      finish_reason: 'tool_calls',
      tool_calls: [{ id: 'r1', name: 'read_file', arguments: '{}' }],
    }),
    executeTool: jest.fn().mockResolvedValueOnce({
      ok: false,
      outputDigest: '',
      detail: 'E_AGENT_BAD_PATH',
    }),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'go' }],
    tools: TOOLS,
    deps,
  });

  expect(result.status).toBe('failed');
  expect(result.failure?.code).toBe('E_AGENT_BAD_PATH');
});

test('the hard round budget stops further tool demands honestly', async () => {
  let round = 0;
  const deps = makeDeps({
    modelCalls: jest.fn(() => {
      round += 1;
      // Keep demanding tools forever; the loop must cut us off at the cap.
      return Promise.resolve({
        text: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          { id: `c${round}`, name: 'read_file', arguments: '{}' },
        ],
      });
    }),
    executeTool: jest.fn(async (_ctx, _name, _args) => ({
      ok: true,
      outputDigest: `d${round}`,
    })),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'loop forever' }],
    tools: TOOLS,
    deps,
  });

  expect(result.status).toBe('done');
  expect(result.exhausted).toBe(true);
  expect(deps.executeTool).toHaveBeenCalledTimes(MAX_AGENT_ROUNDS);
});

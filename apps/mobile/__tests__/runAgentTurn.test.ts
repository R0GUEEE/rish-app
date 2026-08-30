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
    requestApproval: jest.fn(async (spec: { approvalId: string }) => ({
      status: 'approved',
      approval_id: spec.approvalId,
      scope: 'once',
    })),
    askQuestion: jest.fn(async (spec: { questionId: string }) => ({
      status: 'answered',
      question_id: spec.questionId,
      answer: 'the answer',
    })),
    createApprovalId: jest.fn(() => 'ap-1'),
    createQuestionId: jest.fn(() => 'q-1'),
    onTrace: jest.fn(),
    recordTrace: jest.fn(),
    emitSessionEvent: jest.fn(),
    ...overrides,
  };
}

function emittedKinds(deps: Deps): string[] {
  return (deps.emitSessionEvent as jest.Mock).mock.calls.map(
    call => (call[0] as { kind: string }).kind,
  );
}

function emittedRows(deps: Deps): Array<Record<string, unknown>> {
  return (deps.emitSessionEvent as jest.Mock).mock.calls.map(
    call => call[0] as Record<string, unknown>,
  );
}

const BASE = {
  projectId: 'proj-1',
  model: 'deepseek-v4-flash' as const,
  thinkingMode: 'high' as const,
};

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
  expect(deps.recordTrace).toHaveBeenCalledWith([
    { name: 'read_file', arguments_sha256: expect.any(String),
      outcome: 'ok' },
  ]);
  // SessionEvent trajectory: tool_call before tool_result, then text.
  const kinds = emittedKinds(deps);
  expect(kinds).toEqual(
    expect.arrayContaining(['tool_call', 'tool_result', 'assistant_text']),
  );
  const callRow = emittedRows(deps).find(
    row => row.kind === 'tool_call',
  );
  expect(callRow?.schema_version).toBe(1);
  expect(callRow?.tool_call_id).toBe('c1');
  expect(callRow?.tool_name).toBe('read_file');
  expect(callRow?.arguments_json).toBe('{"path":"a"}');
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
    requestApproval: jest.fn(async (spec: { approvalId: string }) => ({
      status: 'approved',
      approval_id: spec.approvalId,
      scope: 'once',
    })),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'write n' }],
    tools: [{ name: 'write_file', parameters: {} }],
    deps,
  });

  expect(deps.requestApproval).toHaveBeenCalledWith(
    expect.objectContaining({ toolCallId: 'w1', toolName: 'write_file' }),
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
    requestApproval: jest.fn(async (spec: { approvalId: string }) => ({
      status: 'denied',
      approval_id: spec.approvalId,
    })),
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
  expect(deps.recordTrace).toHaveBeenCalledWith([
    { name: 'git_push', arguments_sha256: expect.any(String),
      outcome: 'denied' },
  ]);
  // The denial is a settled tool_result row, never a failed execution.
  const deniedRow = emittedRows(deps).find(
    row => row.kind === 'tool_result' && row.tool_call_id === 'p1',
  );
  expect(deniedRow?.outcome).toBe('denied');
  // Trajectory order: approval_request → approval_response → tool_result.
  const kinds = emittedKinds(deps);
  expect(kinds.indexOf('approval_request')).toBeLessThan(
    kinds.indexOf('approval_response'),
  );
  expect(kinds.indexOf('approval_response')).toBeLessThan(
    kinds.indexOf('tool_result'),
  );
  const responseRow = emittedRows(deps).find(
    row => row.kind === 'approval_response',
  );
  expect(responseRow).toMatchObject({
    approval_id: 'ap-1',
    approval_decision: 'denied',
    approval_resolution: 'user',
  });
});

test('conversation scope grants the tool for the rest of the turn', async () => {
  const deps = makeDeps({
    modelCalls: jest.fn()
      .mockResolvedValueOnce({
        text: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          { id: 'w1', name: 'write_file', arguments: '{"path":"a"}' },
          { id: 'w2', name: 'write_file', arguments: '{"path":"b"}' },
        ],
      })
      .mockResolvedValueOnce({
        text: 'Both written.',
        finish_reason: 'stop',
        tool_calls: [],
      }),
    executeTool: jest.fn(async () => ({ ok: true, outputDigest: 'bytes:1' })),
    requestApproval: jest.fn(async (spec: { approvalId: string }) => ({
      status: 'approved',
      approval_id: spec.approvalId,
      scope: 'conversation',
    })),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'write both' }],
    tools: [{ name: 'write_file', parameters: {} }],
    deps,
  });

  expect(result.status).toBe('done');
  // One approval for the first gated call; the grant covers the second.
  expect(deps.requestApproval).toHaveBeenCalledTimes(1);
  expect(deps.executeTool).toHaveBeenCalledTimes(2);
  const responseRow = emittedRows(deps).find(
    row => row.kind === 'approval_response',
  );
  expect(responseRow).toMatchObject({
    approval_decision: 'approved',
    approval_scope: 'conversation',
    approval_resolution: 'user',
  });
});

test('once scope grants only the approved call', async () => {
  const deps = makeDeps({
    modelCalls: jest.fn()
      .mockResolvedValueOnce({
        text: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          { id: 'w1', name: 'write_file', arguments: '{"path":"a"}' },
          { id: 'w2', name: 'write_file', arguments: '{"path":"b"}' },
        ],
      })
      .mockResolvedValueOnce({
        text: 'Both written.',
        finish_reason: 'stop',
        tool_calls: [],
      }),
    executeTool: jest.fn(async () => ({ ok: true, outputDigest: 'bytes:1' })),
    requestApproval: jest.fn(async (spec: { approvalId: string }) => ({
      status: 'approved',
      approval_id: spec.approvalId,
      scope: 'once',
    })),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'write both' }],
    tools: [{ name: 'write_file', parameters: {} }],
    deps,
  });

  expect(result.status).toBe('done');
  expect(deps.requestApproval).toHaveBeenCalledTimes(2);
  expect(deps.executeTool).toHaveBeenCalledTimes(2);
});

test('a missing approval answer fails closed to denied', async () => {
  const deps = makeDeps({
    modelCalls: jest.fn()
      .mockResolvedValueOnce({
        text: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          { id: 'w1', name: 'write_file', arguments: '{"path":"a"}' },
        ],
      })
      .mockResolvedValueOnce({
        text: 'Stopped.',
        finish_reason: 'stop',
        tool_calls: [],
      }),
    executeTool: jest.fn(),
    requestApproval: jest.fn(async () => undefined),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'write a' }],
    tools: [{ name: 'write_file', parameters: {} }],
    deps,
  });

  expect(deps.executeTool).not.toHaveBeenCalled();
  const responseRow = emittedRows(deps).find(
    row => row.kind === 'approval_response',
  );
  expect(responseRow).toMatchObject({
    approval_decision: 'denied',
    approval_resolution: 'missing',
  });
  expect(result.status).toBe('done');
});

test('a corrupt approval answer fails closed to denied', async () => {
  const deps = makeDeps({
    modelCalls: jest.fn()
      .mockResolvedValueOnce({
        text: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          { id: 'w1', name: 'write_file', arguments: '{"path":"a"}' },
        ],
      })
      .mockResolvedValueOnce({
        text: 'Stopped.',
        finish_reason: 'stop',
        tool_calls: [],
      }),
    executeTool: jest.fn(),
    // Well-formed shape but the scope is not one of the offered scopes.
    requestApproval: jest.fn(async (spec: { approvalId: string }) => ({
      status: 'approved',
      approval_id: spec.approvalId,
      scope: 'forever',
    })),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'write a' }],
    tools: [{ name: 'write_file', parameters: {} }],
    deps,
  });

  expect(deps.executeTool).not.toHaveBeenCalled();
  const responseRow = emittedRows(deps).find(
    row => row.kind === 'approval_response',
  );
  expect(responseRow).toMatchObject({
    approval_decision: 'denied',
    approval_resolution: 'invalid',
  });
  expect(result.status).toBe('done');
});

test('an approval for a different request id fails closed to denied', async () => {
  const deps = makeDeps({
    modelCalls: jest.fn()
      .mockResolvedValueOnce({
        text: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          { id: 'w1', name: 'write_file', arguments: '{"path":"a"}' },
        ],
      })
      .mockResolvedValueOnce({
        text: 'Stopped.',
        finish_reason: 'stop',
        tool_calls: [],
      }),
    executeTool: jest.fn(),
    requestApproval: jest.fn(async () => ({
      status: 'approved',
      approval_id: 'someone-else',
      scope: 'once',
    })),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'write a' }],
    tools: [{ name: 'write_file', parameters: {} }],
    deps,
  });

  expect(deps.executeTool).not.toHaveBeenCalled();
  const responseRow = emittedRows(deps).find(
    row => row.kind === 'approval_response',
  );
  expect(responseRow?.approval_resolution).toBe('invalid');
  expect(result.status).toBe('done');
});

test('an approval timeout fails closed to denied without executing', async () => {
  jest.useFakeTimers();
  try {
    const deps = makeDeps({
      modelCalls: jest.fn()
        .mockResolvedValueOnce({
          text: '',
          finish_reason: 'tool_calls',
          tool_calls: [
            { id: 'w1', name: 'write_file', arguments: '{"path":"a"}' },
          ],
        })
        .mockResolvedValueOnce({
          text: 'Stopped.',
          finish_reason: 'stop',
          tool_calls: [],
        }),
      executeTool: jest.fn(),
      requestApproval: jest.fn(async () => new Promise(() => undefined)),
    });

    const turn = runAgentTurn({
      ...BASE,
      history: [{ role: 'user', content: 'write a' }],
      tools: [{ name: 'write_file', parameters: {} }],
      approvalTimeoutMs: 1000,
      deps,
    });
    await jest.advanceTimersByTimeAsync(1100);
    const result = await turn;

    expect(deps.executeTool).not.toHaveBeenCalled();
    const responseRow = emittedRows(deps).find(
      row => row.kind === 'approval_response',
    );
    expect(responseRow).toMatchObject({
      approval_decision: 'denied',
      approval_resolution: 'timeout',
    });
    expect(result.status).toBe('done');
  } finally {
    jest.useRealTimers();
  }
});

test('cancelling while an approval is pending records cancelled and stops', async () => {
  let cancelNow = false;
  const deps = makeDeps({
    modelCalls: jest.fn().mockResolvedValueOnce({
      text: '',
      finish_reason: 'tool_calls',
      tool_calls: [
        { id: 'w1', name: 'write_file', arguments: '{"path":"a"}' },
      ],
    }),
    executeTool: jest.fn(),
    requestApproval: jest.fn(async () => {
      cancelNow = true;
      return { status: 'approved', approval_id: 'ap-1', scope: 'once' };
    }),
    shouldCancel: jest.fn(() => cancelNow),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'write a' }],
    tools: [{ name: 'write_file', parameters: {} }],
    deps,
  });

  expect(deps.executeTool).not.toHaveBeenCalled();
  expect(result.status).toBe('cancelled');
  const responseRow = emittedRows(deps).find(
    row => row.kind === 'approval_response',
  );
  expect(responseRow).toMatchObject({
    approval_decision: 'denied',
    approval_resolution: 'cancelled',
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

test('an options question records question → response → tool_result and delivers the answer', async () => {
  const deps = makeDeps({
    modelCalls: jest.fn()
      .mockResolvedValueOnce({
        text: '',
        finish_reason: 'tool_calls',
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
      })
      .mockResolvedValueOnce({
        text: 'Opening notes.md.',
        finish_reason: 'stop',
        tool_calls: [],
      }),
    askQuestion: jest.fn(async (spec: { questionId: string }) => ({
      status: 'answered',
      question_id: spec.questionId,
      answer: 'a',
    })),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'open a file' }],
    tools: [{ name: 'ask_user', parameters: {} }],
    deps,
  });

  expect(result.status).toBe('done');
  const kinds = emittedKinds(deps);
  const toolCallIdx = kinds.indexOf('tool_call');
  const questionIdx = kinds.indexOf('question');
  const responseIdx = kinds.indexOf('question_response');
  const resultIdx = kinds.lastIndexOf('tool_result');
  expect(toolCallIdx).toBeLessThan(questionIdx);
  expect(questionIdx).toBeLessThan(responseIdx);
  expect(responseIdx).toBeLessThan(resultIdx);
  const questionRow = emittedRows(deps).find(row => row.kind === 'question');
  expect(questionRow).toMatchObject({
    question_id: 'q-1',
    text: 'Which file?',
    question_input_mode: 'options',
  });
  const responseRow = emittedRows(deps).find(
    row => row.kind === 'question_response',
  );
  expect(responseRow).toMatchObject({
    question_id: 'q-1',
    question_response_status: 'answered',
    answer: 'a',
  });
  const toolResultRow = emittedRows(deps).find(
    row => row.kind === 'tool_result' && row.tool_call_id === 'q1',
  );
  expect(toolResultRow?.outcome).toBe('ok');
  // The answer itself reaches the model through the follow-up history.
  const followupCall = (deps.modelCalls as jest.Mock).mock.calls[1][0];
  const lastUser = followupCall.history[followupCall.history.length - 1];
  expect(lastUser.content).toContain('answered: a');
});

test('a cancelled optional question records cancelled and lets the loop adapt', async () => {
  const deps = makeDeps({
    modelCalls: jest.fn()
      .mockResolvedValueOnce({
        text: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          {
            id: 'q1',
            name: 'ask_user',
            arguments: JSON.stringify({
              question: 'Optional: which theme?',
              input_mode: 'free_text',
            }),
          },
        ],
      })
      .mockResolvedValueOnce({
        text: 'Keeping the default theme.',
        finish_reason: 'stop',
        tool_calls: [],
      }),
    askQuestion: jest.fn(async (spec: { questionId: string }) => ({
      status: 'cancelled',
      question_id: spec.questionId,
    })),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'pick a theme' }],
    tools: [{ name: 'ask_user', parameters: {} }],
    deps,
  });

  expect(result.status).toBe('done');
  const responseRow = emittedRows(deps).find(
    row => row.kind === 'question_response',
  );
  expect(responseRow?.question_response_status).toBe('cancelled');
  const toolResultRow = emittedRows(deps).find(
    row => row.kind === 'tool_result' && row.tool_call_id === 'q1',
  );
  expect(toolResultRow?.outcome).toBe('ok');
  expect(toolResultRow?.output_digest).toBe('cancelled');
  const followupCall = (deps.modelCalls as jest.Mock).mock.calls[1][0];
  const lastUser = followupCall.history[followupCall.history.length - 1];
  expect(lastUser.content).toContain('cancelled (no answer)');
});

test('a required question that is dismissed fails the turn', async () => {
  const deps = makeDeps({
    modelCalls: jest.fn().mockResolvedValueOnce({
      text: '',
      finish_reason: 'tool_calls',
      tool_calls: [
        {
          id: 'q1',
          name: 'ask_user',
          arguments: JSON.stringify({
            question: 'Required: which file?',
            input_mode: 'options',
            options: [{ id: 'a', label: 'notes.md' }],
            required: true,
          }),
        },
      ],
    }),
    askQuestion: jest.fn(async (spec: { questionId: string }) => ({
      status: 'cancelled',
      question_id: spec.questionId,
    })),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'open a file' }],
    tools: [{ name: 'ask_user', parameters: {} }],
    deps,
  });

  expect(result.status).toBe('failed');
  expect(result.failure?.code).toBe('E_AGENT_QUESTION_UNANSWERED');
});

test('an out-of-set option answer is rejected fail-closed', async () => {
  const deps = makeDeps({
    modelCalls: jest.fn()
      .mockResolvedValueOnce({
        text: '',
        finish_reason: 'tool_calls',
        tool_calls: [
          {
            id: 'q1',
            name: 'ask_user',
            arguments: JSON.stringify({
              question: 'Which file?',
              input_mode: 'options',
              options: [{ id: 'a', label: 'notes.md' }],
            }),
          },
        ],
      })
      .mockResolvedValueOnce({
        text: 'Keeping the default.',
        finish_reason: 'stop',
        tool_calls: [],
      }),
    askQuestion: jest.fn(async (spec: { questionId: string }) => ({
      status: 'answered',
      question_id: spec.questionId,
      answer: 'not-offered',
    })),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'pick a file' }],
    tools: [{ name: 'ask_user', parameters: {} }],
    deps,
  });

  expect(result.status).toBe('done');
  const responseRow = emittedRows(deps).find(
    row => row.kind === 'question_response',
  );
  // The invalid answer is recorded as such and treated like a dismissal.
  expect(responseRow?.question_response_status).toBe('invalid');
  const toolResultRow = emittedRows(deps).find(
    row => row.kind === 'tool_result' && row.tool_call_id === 'q1',
  );
  expect(toolResultRow?.outcome).toBe('ok');
  expect(toolResultRow?.output_digest).toBe('cancelled');
});

test('a malformed ask_user call fails the turn honestly', async () => {
  const deps = makeDeps({
    modelCalls: jest.fn().mockResolvedValueOnce({
      text: '',
      finish_reason: 'tool_calls',
      tool_calls: [
        { id: 'q1', name: 'ask_user', arguments: '{"input_mode":"nope"}' },
      ],
    }),
  });

  const result = await runAgentTurn({
    ...BASE,
    history: [{ role: 'user', content: 'ask something' }],
    tools: [{ name: 'ask_user', parameters: {} }],
    deps,
  });

  expect(result.status).toBe('failed');
  expect(result.failure?.code).toBe('E_AGENT_BAD_QUESTION');
  expect(deps.askQuestion).not.toHaveBeenCalled();
});

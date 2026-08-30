import {
  MAX_SESSION_EVENT_LOG_SIZE,
  SESSION_EVENTS_SNAPSHOT_KEY,
  SESSION_EVENT_SCHEMA_VERSION,
  appendSessionEventBounded,
  attachSessionEventsToSnapshot,
  createSessionEventJournal,
  extractSessionEventsFromSnapshot,
  hydrateSessionEvents,
  recordSessionEvent,
  replayAssistantTurn,
  type SessionEventV1,
} from '../src/agent/SessionEvents';

const T = '2026-08-29T12:00:00.000Z';

function baseAttemptEvent(
  overrides: Partial<SessionEventV1> = {},
): SessionEventV1 {
  return {
    schema_version: SESSION_EVENT_SCHEMA_VERSION,
    event_id: 'e1',
    attempt_id: 'att-1',
    seq: 0,
    kind: 'assistant_reasoning',
    text: 'thinking…',
    created_at: T,
    ...overrides,
  };
}

test('appends events with strictly increasing per-attempt sequence', () => {
  const first = recordSessionEvent([], baseAttemptEvent());
  const second = recordSessionEvent(first, {
    ...baseAttemptEvent({
      event_id: 'e2',
      seq: 1,
      kind: 'tool_call',
      tool_call_id: 'c1',
      tool_name: 'read_file',
    }),
  });
  expect(second).toHaveLength(2);
  expect(second[1]?.seq).toBe(1);

  // Out-of-order sequence numbers are rejected fail-closed.
  // Sequence regressions are rejected fail-closed (gaps are allowed).
  expect(() =>
    recordSessionEvent(
      second,
      baseAttemptEvent({ event_id: 'e3', seq: 0 }),
    ),
  ).toThrow(/seq/);
});

test('rejects duplicate event ids and mismatched attempt ids', () => {
  const log = [baseAttemptEvent()];
  expect(() =>
    recordSessionEvent(log, baseAttemptEvent({ seq: 1, kind: 'assistant_text', text: 'x' })),
  ).toThrow(/event_id/);
  expect(() =>
    recordSessionEvent(
      log,
      baseAttemptEvent({
        event_id: 'e-other',
        seq: 1,
        attempt_id: 'att-2',
        kind: 'assistant_text',
        text: 'x',
      }),
    ),
  ).toThrow(/attempt/);
});

test('hydration rejects malformed logs instead of dropping rows silently', () => {
  expect(() =>
    hydrateSessionEvents([
      baseAttemptEvent({ kind: 'not-a-kind' as never }),
    ]),
  ).toThrow(/kind/);

  expect(() =>
    hydrateSessionEvents([baseAttemptEvent({ seq: -1 })]),
  ).toThrow(/seq/);
});

test('replay preserves the reasoning → tool_call → tool_result ordering', () => {
  const log: SessionEventV1[] = [];
  let autoSeq = 0;
  const add = (e: Partial<SessionEventV1>) => {
    const next = recordSessionEvent(
      log,
      baseAttemptEvent({ seq: autoSeq, ...e }),
    );
    autoSeq = next.length;
    log.length = 0;
    log.push(...next);
  };

  add({ event_id: 'e1', kind: 'assistant_reasoning', text: 'need file' });
  add({ event_id: 'e2', kind: 'tool_call', tool_name: 'read_file', tool_call_id: 'c1', arguments_json: '{"path":"a"}' });
  add({ event_id: 'e3', kind: 'tool_result', tool_call_id: 'c1', outcome: 'ok', output_digest: 'bytes:2' });
  add({ event_id: 'e4', kind: 'assistant_text', text: 'Done — file read.' });

  const replay = replayAssistantTurn(log, 'att-1');
  expect(replay.map(e => e.kind)).toEqual([
    'assistant_reasoning',
    'tool_call',
    'tool_result',
    'assistant_text',
  ]);
  expect(replay[1]?.tool_name).toBe('read_file');
  expect(replay[2]?.outcome).toBe('ok');
});

test('replay filters to one attempt across a mixed log', () => {
  const log = [
    baseAttemptEvent({ event_id: 'a1' }),
    baseAttemptEvent({
      event_id: 'a2',
      seq: 1,
      kind: 'tool_call',
      tool_call_id: 'c9',
      tool_name: 'list_dir',
    }),
    // A row from another attempt that was archived into the same store.
    {
      ...baseAttemptEvent({
        event_id: 'b1',
        attempt_id: 'att-2',
        kind: 'assistant_text',
        text: 'older turn',
      }),
      seq: 0,
    } as SessionEventV1,
  ];
  const replay = replayAssistantTurn(log, 'att-1');
  expect(replay).toHaveLength(2);
  expect(replay.every(e => e.attempt_id === 'att-1')).toBe(true);
});

test('tool rows require their ids; reasoning rows tolerate empty text', () => {
  expect(() =>
    hydrateSessionEvents([
      baseAttemptEvent({ kind: 'tool_call', tool_call_id: undefined as never }),
    ]),
  ).toThrow(/tool_call_id/);
  expect(() =>
    hydrateSessionEvents([
      baseAttemptEvent({ kind: 'tool_result', tool_call_id: 'c1' }),
    ]),
  ).toThrow(/outcome/);
});
test('hydration rejects rows that lost their schema_version', () => {
  const row = baseAttemptEvent() as Record<string, unknown>;
  delete row.schema_version;
  expect(() => hydrateSessionEvents([row])).toThrow(/schema_version/);
});

test('bounded append caps the log at the newest events in order', () => {
  let log: readonly SessionEventV1[] = [];
  const total = MAX_SESSION_EVENT_LOG_SIZE + 7;
  for (let index = 0; index < total; index += 1) {
    log = appendSessionEventBounded(log, {
      ...baseAttemptEvent({ event_id: 'e' + index, seq: index }),
    });
  }
  expect(log).toHaveLength(MAX_SESSION_EVENT_LOG_SIZE);
  expect(log[0]?.event_id).toBe('e7');
  expect(log[log.length - 1]?.event_id).toBe('e' + (total - 1));
  expect(log.every((event, index) => event.seq === index + 7)).toBe(true);
});

test('bounded append validates the row and rejects a bad cap', () => {
  expect(() =>
    appendSessionEventBounded(
      [],
      baseAttemptEvent({ kind: 'not-a-kind' as never }),
    ),
  ).toThrow(/kind/);
  expect(() =>
    appendSessionEventBounded([], baseAttemptEvent(), 0),
  ).toThrow(/maxEvents/);
});

test('snapshot attach/extract round-trips through the session document', () => {
  const snapshot: Record<string, unknown> = { chats: 'payload' };
  const events: SessionEventV1[] = [
    baseAttemptEvent(),
    baseAttemptEvent({
      event_id: 'e2',
      seq: 1,
      kind: 'assistant_text',
      text: 'answer',
    }),
  ];
  const attached = attachSessionEventsToSnapshot(snapshot, events);
  const serialized = JSON.parse(JSON.stringify(attached)) as unknown;
  const recovered = extractSessionEventsFromSnapshot(serialized);
  expect(recovered).toEqual(events);
  expect(attached[SESSION_EVENTS_SNAPSHOT_KEY]).toHaveLength(2);
});

test('attach omits an invalid log instead of blocking session persistence', () => {
  const snapshot: Record<string, unknown> = { chats: 'payload' };
  const bad = [
    baseAttemptEvent({
      kind: 'tool_call',
      tool_call_id: undefined as never,
    }),
  ];
  const attached = attachSessionEventsToSnapshot(
    snapshot,
    bad as unknown as SessionEventV1[],
  );
  expect(attached).toBe(snapshot);
});

test('extract trims an oversized stored log to the newest cap rows', () => {
  const total = MAX_SESSION_EVENT_LOG_SIZE + 7;
  const stored: SessionEventV1[] = [];
  for (let index = 0; index < total; index += 1) {
    stored.push(
      baseAttemptEvent({ event_id: 'e' + index, seq: index }),
    );
  }
  const serialized = JSON.parse(
    JSON.stringify({ session_events: stored }),
  ) as unknown;
  const recovered = extractSessionEventsFromSnapshot(serialized);
  expect(recovered).not.toBeNull();
  expect(recovered).toHaveLength(MAX_SESSION_EVENT_LOG_SIZE);
  expect(recovered?.[0]?.event_id).toBe('e7');
  expect(recovered?.[recovered.length - 1]?.event_id).toBe(
    'e' + (total - 1),
  );
  expect(
    recovered?.every((event, index) => event.seq === index + 7),
  ).toBe(true);
});

test('attach trims an oversized in-memory log to the newest cap rows', () => {
  const snapshot: Record<string, unknown> = { chats: 'payload' };
  const total = MAX_SESSION_EVENT_LOG_SIZE + 7;
  const log: SessionEventV1[] = [];
  for (let index = 0; index < total; index += 1) {
    log.push(baseAttemptEvent({ event_id: 'e' + index, seq: index }));
  }
  const attached = attachSessionEventsToSnapshot(snapshot, log);
  const rows = attached[SESSION_EVENTS_SNAPSHOT_KEY] as
    | SessionEventV1[]
    | undefined;
  expect(rows).toBeDefined();
  expect(rows).toHaveLength(MAX_SESSION_EVENT_LOG_SIZE);
  expect(rows?.[0]?.event_id).toBe('e7');
  expect(rows?.[rows.length - 1]?.event_id).toBe('e' + (total - 1));
});


describe('approval / question protocol rows', () => {
  const approvalRequestRow = (): Record<string, unknown> => ({
    schema_version: 1,
    event_id: 'e1',
    attempt_id: 'att-1',
    seq: 0,
    kind: 'approval_request',
    created_at: '2026-08-29T12:00:00.000Z',
    approval_id: 'ap-1',
    tool_call_id: 'c1',
    tool_name: 'write_file',
    arguments_json: '{"path":"a"}',
    approval_scopes_json: '["once","conversation"]',
  });

  test('well-formed approval rows hydrate and validate', () => {
    expect(
      hydrateSessionEvents([approvalRequestRow()]),
    ).toHaveLength(1);
    expect(
      hydrateSessionEvents([
        {
          ...approvalRequestRow(),
          event_id: 'e2',
          seq: 1,
          kind: 'approval_response',
          approval_decision: 'approved',
          approval_scope: 'once',
          approval_resolution: 'user',
        },
      ]),
    ).toHaveLength(1);
    expect(
      hydrateSessionEvents([
        {
          ...approvalRequestRow(),
          event_id: 'e3',
          seq: 2,
          kind: 'approval_response',
          approval_decision: 'denied',
          approval_resolution: 'timeout',
        },
      ]),
    ).toHaveLength(1);
  });

  test('approval rows reject malformed scope lists and resolutions', () => {
    expect(() =>
      hydrateSessionEvents([
        {
          ...approvalRequestRow(),
          approval_scopes_json: '["forever"]',
        },
      ]),
    ).toThrow(/scope/);
    expect(() =>
      hydrateSessionEvents([
        {
          ...approvalRequestRow(),
          approval_scopes_json: '[]',
        },
      ]),
    ).toThrow(/scope/);
    expect(() =>
      hydrateSessionEvents([
        {
          ...approvalRequestRow(),
          kind: 'approval_response',
          approval_decision: 'approved',
          approval_scope: 'once',
          approval_resolution: 'timeout',
        },
      ]),
    ).toThrow(/approved/);
    expect(() =>
      hydrateSessionEvents([
        {
          ...approvalRequestRow(),
          kind: 'approval_response',
          approval_decision: 'denied',
          approval_scope: 'once',
          approval_resolution: 'user',
        },
      ]),
    ).toThrow(/denied/);
    expect(() =>
      hydrateSessionEvents([
        {
          ...approvalRequestRow(),
          kind: 'approval_response',
          approval_decision: 'maybe',
          approval_resolution: 'user',
        },
      ]),
    ).toThrow(/approval_decision/);
  });

  test('question rows validate options and free-text modes strictly', () => {
    const questionRow = (): Record<string, unknown> => ({
      schema_version: 1,
      event_id: 'e1',
      attempt_id: 'att-1',
      seq: 0,
      kind: 'question',
      created_at: '2026-08-29T12:00:00.000Z',
      question_id: 'q-1',
      text: 'Which file?',
      question_input_mode: 'options',
      question_options_json: '[{"id":"a","label":"notes.md"}]',
    });
    expect(hydrateSessionEvents([questionRow()])).toHaveLength(1);
    expect(
      hydrateSessionEvents([
        {
          ...questionRow(),
          question_input_mode: 'free_text',
          question_options_json: undefined,
        },
      ]),
    ).toHaveLength(1);
    // Free-text rows carrying options are schema violations.
    expect(() =>
      hydrateSessionEvents([
        {
          ...questionRow(),
          question_input_mode: 'free_text',
        },
      ]),
    ).toThrow(/options/);
    // Options-mode rows need a non-empty, unique, labelled option list.
    expect(() =>
      hydrateSessionEvents([
        { ...questionRow(), question_options_json: '[]' },
      ]),
    ).toThrow(/options/);
    expect(() =>
      hydrateSessionEvents([
        {
          ...questionRow(),
          question_options_json: '[{"id":"a","label":"x"},{"id":"a","label":"y"}]',
        },
      ]),
    ).toThrow(/options/);
  });

  test('question_response rows enforce answered/unanswered shapes', () => {
    const base = (): Record<string, unknown> => ({
      schema_version: 1,
      event_id: 'e1',
      attempt_id: 'att-1',
      seq: 0,
      kind: 'question_response',
      created_at: '2026-08-29T12:00:00.000Z',
      question_id: 'q-1',
      question_response_status: 'answered',
      answer: 'a',
    });
    expect(hydrateSessionEvents([base()])).toHaveLength(1);
    expect(() =>
      hydrateSessionEvents([
        { ...base(), question_response_status: 'cancelled', answer: 'a' },
      ]),
    ).toThrow(/answer/);
    expect(() =>
      hydrateSessionEvents([
        { ...base(), answer: undefined },
      ]),
    ).toThrow(/answer/);
    expect(
      hydrateSessionEvents([
        { ...base(), question_response_status: 'cancelled', answer: undefined },
      ]),
    ).toHaveLength(1);
  });

  test('tool_result rows already accept the denied outcome', () => {
    expect(
      hydrateSessionEvents([
        {
          schema_version: 1,
          event_id: 'e1',
          attempt_id: 'att-1',
          seq: 0,
          kind: 'tool_result',
          created_at: '2026-08-29T12:00:00.000Z',
          tool_call_id: 'c1',
          outcome: 'denied',
          output_digest: '',
        },
      ]),
    ).toHaveLength(1);
  });
});

describe('session event journal', () => {
  test('allocates strictly increasing per-attempt seq and unique event ids', () => {
    const journal = createSessionEventJournal();
    const first = journal.append({
      schema_version: 1,
      attempt_id: 'att-1',
      kind: 'assistant_reasoning',
      text: 'think',
    });
    expect(first.seq).toBe(0);
    expect(first.event_id).toBe('att-1-0');
    const second = journal.append({
      schema_version: 1,
      attempt_id: 'att-1',
      kind: 'assistant_text',
      text: 'answer',
    });
    expect(second.seq).toBe(1);
    expect(second.event_id).toBe('att-1-1');
    // A second attempt starts its own namespace at 0 without colliding.
    const other = journal.append({
      schema_version: 1,
      attempt_id: 'att-2',
      kind: 'assistant_text',
      text: 'other',
    });
    expect(other.seq).toBe(0);
    expect(other.event_id).toBe('att-2-0');
    // Back on the first attempt, allocation resumes past its high-water mark.
    const third = journal.append({
      schema_version: 1,
      attempt_id: 'att-1',
      kind: 'tool_call',
      tool_call_id: 'c1',
      tool_name: 'read_file',
    });
    expect(third.seq).toBe(2);
    expect(third.event_id).toBe('att-1-2');
  });

  test('two emitters sharing one journal never collide on one attempt', () => {
    // The completion controller and the agent turn driver both hand drafts
    // to the same journal for the same attempt — the structural fix for the
    // dual-emitter event_id/seq namespace hazard.
    const journal = createSessionEventJournal();
    const completionEmitter = (seq: number) =>
      journal.append({
        schema_version: 1,
        attempt_id: 'att-1',
        kind: 'assistant_reasoning',
        text: 'reason-' + seq,
      });
    const agentEmitter = (seq: number) =>
      journal.append({
        schema_version: 1,
        attempt_id: 'att-1',
        kind: 'tool_call',
        tool_call_id: 'c' + seq,
        tool_name: 'read_file',
      });
    const rows = [
      completionEmitter(0),
      agentEmitter(0),
      completionEmitter(1),
      agentEmitter(1),
    ];
    expect(rows.map(row => row.seq)).toEqual([0, 1, 2, 3]);
    const ids = rows.map(row => row.event_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['att-1-0', 'att-1-1', 'att-1-2', 'att-1-3']);
    // Replay keeps recorded order and sorts by seq without ties.
    const replay = replayAssistantTurn(journal.snapshot(), 'att-1');
    expect(replay.map(row => row.seq)).toEqual([0, 1, 2, 3]);
  });

  test('restore reseeds allocation and discards corrupt rows fail-closed', () => {
    const journal = createSessionEventJournal();
    journal.append({
      schema_version: 1,
      attempt_id: 'att-1',
      kind: 'assistant_text',
      text: 'pre-restart',
    });
    const restored = journal.snapshot();
    const fresh = createSessionEventJournal(restored);
    // Allocation resumes past the restored high-water mark instead of
    // restarting at 0 and colliding with persisted event ids.
    const next = fresh.append({
      schema_version: 1,
      attempt_id: 'att-1',
      kind: 'assistant_text',
      text: 'post-restart',
    });
    expect(next.seq).toBe(1);
    expect(next.event_id).toBe('att-1-1');
    // Corrupt restore input is discarded fail-closed, never re-appended.
    const corrupt = createSessionEventJournal([
      { schema_version: 1, event_id: '', attempt_id: 'att-1', seq: 0 } as never,
    ]);
    expect(corrupt.snapshot()).toEqual([]);
    expect(
      corrupt.append({
        schema_version: 1,
        attempt_id: 'att-1',
        kind: 'assistant_text',
        text: 'clean start',
      }).seq,
    ).toBe(0);
  });

  test('journal append keeps the 512-row cap', () => {
    const journal = createSessionEventJournal();
    const total = MAX_SESSION_EVENT_LOG_SIZE + 7;
    for (let index = 0; index < total; index += 1) {
      journal.append({
        schema_version: 1,
        attempt_id: 'att-1',
        kind: 'assistant_text',
        text: 'row-' + index,
      });
    }
    const rows = journal.snapshot();
    expect(rows).toHaveLength(MAX_SESSION_EVENT_LOG_SIZE);
    expect(rows[0]?.seq).toBe(7);
    expect(rows[rows.length - 1]?.seq).toBe(total - 1);
  });

  test('journal rejects invalid drafts instead of storing them', () => {
    const journal = createSessionEventJournal();
    expect(() =>
      journal.append({
        schema_version: 1,
        attempt_id: 'att-1',
        kind: 'approval_request',
        approval_scopes_json: '[]',
      } as never),
    ).toThrow();
    expect(journal.snapshot()).toEqual([]);
  });
});

test('extract discards absent or corrupted trajectory data fail-closed', () => {
  expect(extractSessionEventsFromSnapshot(null)).toBeNull();
  expect(extractSessionEventsFromSnapshot('nope')).toBeNull();
  expect(extractSessionEventsFromSnapshot([1, 2])).toBeNull();
  expect(extractSessionEventsFromSnapshot({})).toBeNull();
  expect(
    extractSessionEventsFromSnapshot({
      session_events: 'not-an-array',
    }),
  ).toBeNull();
  const malformed = JSON.parse(
    JSON.stringify([{ schema_version: 1, event_id: '' }]),
  ) as unknown;
  expect(
    extractSessionEventsFromSnapshot({ session_events: malformed }),
  ).toBeNull();
});


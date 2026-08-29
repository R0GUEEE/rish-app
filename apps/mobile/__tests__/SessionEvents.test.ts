import {
  SESSION_EVENT_SCHEMA_VERSION,
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

/**
 * SessionEvent trajectory log — the DSH parity surface for agent turns.
 *
 * Every observable step of one completion attempt (assistant reasoning,
 * tool calls, tool results, final text) is appended as an immutable event
 * with a per-attempt monotonic sequence. Replay restores the exact order,
 * which is what makes trajectories durable across restarts instead of
 * living only in the transient agent loop state.
 */

export const SESSION_EVENT_SCHEMA_VERSION = 1 as const;

export type SessionEventKind =
  | 'assistant_reasoning'
  | 'assistant_text'
  | 'tool_call'
  | 'tool_result';

export type SessionEventOutcome = 'ok' | 'failed' | 'denied';

export type SessionEventV1 = {
  readonly schema_version: typeof SESSION_EVENT_SCHEMA_VERSION;
  readonly event_id: string;
  readonly attempt_id: string;
  /** Strictly increasing per attempt_id; gaps are allowed, regressions are not. */
  readonly seq: number;
  readonly kind: SessionEventKind;
  readonly created_at: string;
  /** assistant_reasoning / assistant_text payload. */
  readonly text?: string;
  /** tool_call / tool_result rows. */
  readonly tool_call_id?: string;
  readonly tool_name?: string;
  readonly arguments_json?: string;
  readonly outcome?: SessionEventOutcome;
  readonly output_digest?: string;
};

export class SessionEventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionEventValidationError';
  }
}

const KINDS: ReadonlySet<string> = new Set([
  'assistant_reasoning',
  'assistant_text',
  'tool_call',
  'tool_result',
]);
const OUTCOMES: ReadonlySet<string> = new Set(['ok', 'failed', 'denied']);

function validTimestamp(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function validate(event: SessionEventV1): void {
  if (event.schema_version !== SESSION_EVENT_SCHEMA_VERSION) {
    throw new SessionEventValidationError('schema_version must equal 1');
  }
  if (typeof event.event_id !== 'string' || event.event_id.length === 0) {
    throw new SessionEventValidationError('event_id must be a non-empty string');
  }
  if (
    typeof event.attempt_id !== 'string' ||
    event.attempt_id.length === 0
  ) {
    throw new SessionEventValidationError(
      'attempt_id must be a non-empty string',
    );
  }
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
    throw new SessionEventValidationError('seq must be a safe non-negative integer');
  }
  if (!KINDS.has(event.kind)) {
    throw new SessionEventValidationError(`unsupported event kind: ${String(event.kind)}`);
  }
  if (!validTimestamp(event.created_at)) {
    throw new SessionEventValidationError('created_at must be a valid timestamp');
  }
  if (event.kind === 'tool_call' || event.kind === 'tool_result') {
    if (typeof event.tool_call_id !== 'string' || event.tool_call_id.length === 0) {
      throw new SessionEventValidationError(
        `${event.kind} rows require tool_call_id`,
      );
    }
  }
  if (event.kind === 'tool_call' && !event.tool_name) {
    throw new SessionEventValidationError('tool_call rows require tool_name');
  }
  if (event.kind === 'tool_result') {
    if (!event.outcome || !OUTCOMES.has(event.outcome)) {
      throw new SessionEventValidationError('tool_result rows require an outcome');
    }
  }
}

/** Validates a row loaded from persistence without appending semantics. */
export function hydrateSessionEvents(
  rows: readonly unknown[],
): readonly SessionEventV1[] {
  const events = rows.map(row => {
    if (typeof row !== 'object' || row === null) {
      throw new SessionEventValidationError('event rows must be objects');
    }
    return row as SessionEventV1;
  });
  events.forEach(validate);
  return events;
}

/** Fails closed: rejects regressions, duplicate ids, and cross-attempt mixing. */
export function recordSessionEvent(
  log: readonly SessionEventV1[],
  event: SessionEventV1,
): readonly SessionEventV1[] {
  validate(event);
  if (log.some(row => row.event_id === event.event_id)) {
    throw new SessionEventValidationError(
      `duplicate event_id: ${event.event_id}`,
    );
  }
  const prior = log.at(-1);
  if (prior !== undefined) {
    if (prior.attempt_id !== event.attempt_id) {
      throw new SessionEventValidationError(
        'append must stay within one attempt; start a new log instead',
      );
    }
    if (event.seq <= prior.seq) {
      throw new SessionEventValidationError(
        `seq must be strictly increasing (prior ${prior.seq}, got ${event.seq})`,
      );
    }
  } else if (event.seq !== 0) {
    throw new SessionEventValidationError('the first event must have seq 0');
  }
  return [...log, event];
}

/** Restores one attempt's trajectory in recorded order. */
export function replayAssistantTurn(
  log: readonly SessionEventV1[],
  attemptId: string,
): readonly SessionEventV1[] {
  return log
    .filter(event => event.attempt_id === attemptId)
    .slice()
    .sort((left, right) => left.seq - right.seq);
}

/**
 * Upper bound for one session's trajectory log. The log rides the session
 * document (16 MiB budget), so it must stay bounded instead of growing
 * with every completed round.
 */
export const MAX_SESSION_EVENT_LOG_SIZE = 512 as const;

export const SESSION_EVENTS_SNAPSHOT_KEY = 'session_events' as const;

/**
 * Appends one validated event and drops the oldest rows beyond the cap.
 * Unlike recordSessionEvent, the session-wide log intentionally mixes
 * attempts (one log per session, replay filters by attempt_id), so only
 * per-row validation applies here — not per-attempt sequencing.
 */
export function appendSessionEventBounded(
  log: readonly SessionEventV1[],
  event: SessionEventV1,
  maxEvents: number = MAX_SESSION_EVENT_LOG_SIZE,
): readonly SessionEventV1[] {
  validate(event);
  if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0) {
    throw new SessionEventValidationError(
      'maxEvents must be a positive safe integer',
    );
  }
  const next = [...log, event];
  if (next.length <= maxEvents) return next;
  return next.slice(next.length - maxEvents);
}

/**
 * Attaches the trajectory log to a session snapshot for persistence.
 * Fail-closed: an invalid in-memory log is silently omitted so a broken
 * trajectory can never block the session document from being saved.
 */
export function attachSessionEventsToSnapshot(
  snapshot: Record<string, unknown>,
  log: readonly SessionEventV1[],
): Record<string, unknown> {
  try {
    hydrateSessionEvents(log);
  } catch {
    return snapshot;
  }
  return { ...snapshot, [SESSION_EVENTS_SNAPSHOT_KEY]: log };
}

/**
 * Recovers the trajectory log from a persisted snapshot.
 * Returns null when the key is absent or the stored rows are malformed —
 * corrupted trajectory data is discarded fail-closed instead of throwing
 * during app startup.
 */
export function extractSessionEventsFromSnapshot(
  snapshot: unknown,
): readonly SessionEventV1[] | null {
  if (typeof snapshot !== 'object' || snapshot === null) return null;
  if (Array.isArray(snapshot)) return null;
  const raw = (snapshot as Record<string, unknown>)[
    SESSION_EVENTS_SNAPSHOT_KEY
  ];
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) return null;
  try {
    return hydrateSessionEvents(raw);
  } catch {
    return null;
  }
}

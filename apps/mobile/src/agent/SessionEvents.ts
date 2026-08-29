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

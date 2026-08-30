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
  | 'tool_result'
  | 'approval_request'
  | 'approval_response'
  | 'question'
  | 'question_response';

export type SessionEventOutcome = 'ok' | 'failed' | 'denied';

export const APPROVAL_SCOPE_VALUES = ['once', 'conversation'] as const;
export type ApprovalScopeValue = (typeof APPROVAL_SCOPE_VALUES)[number];

export const APPROVAL_RESOLUTION_VALUES = [
  'user',
  'timeout',
  'missing',
  'invalid',
  'cancelled',
] as const;
export type ApprovalResolutionValue = (typeof APPROVAL_RESOLUTION_VALUES)[number];

export const QUESTION_INPUT_MODE_VALUES = ['options', 'free_text'] as const;
export type QuestionInputModeValue = (typeof QUESTION_INPUT_MODE_VALUES)[number];

export const QUESTION_RESPONSE_STATUS_VALUES = [
  'answered',
  'cancelled',
  'invalid',
] as const;
export type QuestionResponseStatusValue =
  (typeof QUESTION_RESPONSE_STATUS_VALUES)[number];

export type SessionEventV1 = {
  readonly schema_version: typeof SESSION_EVENT_SCHEMA_VERSION;
  readonly event_id: string;
  readonly attempt_id: string;
  /** Strictly increasing per attempt_id; gaps are allowed, regressions are not. */
  readonly seq: number;
  readonly kind: SessionEventKind;
  readonly created_at: string;
  /** assistant_reasoning / assistant_text payload; also the question text. */
  readonly text?: string;
  /** tool_call / tool_result rows. */
  readonly tool_call_id?: string;
  readonly tool_name?: string;
  readonly arguments_json?: string;
  readonly outcome?: SessionEventOutcome;
  readonly output_digest?: string;
  /** approval_request / approval_response rows. */
  readonly approval_id?: string;
  readonly approval_scopes_json?: string;
  readonly approval_decision?: 'approved' | 'denied';
  readonly approval_scope?: ApprovalScopeValue;
  readonly approval_resolution?: ApprovalResolutionValue;
  /** question / question_response rows. */
  readonly question_id?: string;
  readonly question_input_mode?: QuestionInputModeValue;
  readonly question_options_json?: string;
  readonly question_required?: boolean;
  readonly question_response_status?: QuestionResponseStatusValue;
  readonly answer?: string;
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
  'approval_request',
  'approval_response',
  'question',
  'question_response',
]);
const OUTCOMES: ReadonlySet<string> = new Set(['ok', 'failed', 'denied']);
const APPROVAL_SCOPES: ReadonlySet<string> = new Set(APPROVAL_SCOPE_VALUES);
const APPROVAL_RESOLUTIONS: ReadonlySet<string> = new Set(
  APPROVAL_RESOLUTION_VALUES,
);
const QUESTION_INPUT_MODES: ReadonlySet<string> = new Set(
  QUESTION_INPUT_MODE_VALUES,
);
const QUESTION_RESPONSE_STATUSES: ReadonlySet<string> = new Set(
  QUESTION_RESPONSE_STATUS_VALUES,
);

/** Strictly parses an approval-scope offer list: non-empty, unique, known scopes. */
function validApprovalScopesJson(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  const seen = new Set<string>();
  for (const scope of parsed) {
    if (typeof scope !== 'string' || !APPROVAL_SCOPES.has(scope)) {
      return false;
    }
    if (seen.has(scope)) return false;
    seen.add(scope);
  }
  return true;
}

/** Strictly parses question options: non-empty, unique ids, labelled. */
function validQuestionOptionsJson(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  const seen = new Set<string>();
  for (const option of parsed) {
    if (typeof option !== 'object' || option === null || Array.isArray(option)) {
      return false;
    }
    const record = option as Record<string, unknown>;
    if (
      typeof record.id !== 'string' ||
      record.id.length === 0 ||
      typeof record.label !== 'string' ||
      record.label.length === 0
    ) {
      return false;
    }
    if (seen.has(record.id)) return false;
    seen.add(record.id);
  }
  return true;
}

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
  if (event.kind === 'approval_request') {
    if (
      typeof event.approval_id !== 'string' ||
      event.approval_id.length === 0
    ) {
      throw new SessionEventValidationError(
        'approval_request rows require approval_id',
      );
    }
    if (
      typeof event.tool_call_id !== 'string' ||
      event.tool_call_id.length === 0 ||
      typeof event.tool_name !== 'string' ||
      event.tool_name.length === 0 ||
      typeof event.arguments_json !== 'string'
    ) {
      throw new SessionEventValidationError(
        'approval_request rows require tool_call_id, tool_name, and arguments_json',
      );
    }
    if (!validApprovalScopesJson(event.approval_scopes_json)) {
      throw new SessionEventValidationError(
        'approval_request rows require a non-empty known-scope list',
      );
    }
  }
  if (event.kind === 'approval_response') {
    if (
      typeof event.approval_id !== 'string' ||
      event.approval_id.length === 0
    ) {
      throw new SessionEventValidationError(
        'approval_response rows require approval_id',
      );
    }
    if (
      event.approval_decision !== 'approved' &&
      event.approval_decision !== 'denied'
    ) {
      throw new SessionEventValidationError(
        'approval_response rows require approval_decision',
      );
    }
    if (
      event.approval_resolution === undefined ||
      !APPROVAL_RESOLUTIONS.has(event.approval_resolution)
    ) {
      throw new SessionEventValidationError(
        'approval_response rows require a known approval_resolution',
      );
    }
    if (event.approval_decision === 'approved') {
      if (
        event.approval_scope === undefined ||
        !APPROVAL_SCOPES.has(event.approval_scope) ||
        event.approval_resolution !== 'user'
      ) {
        throw new SessionEventValidationError(
          'approved rows require a known scope and user resolution',
        );
      }
    } else if (event.approval_scope !== undefined) {
      throw new SessionEventValidationError(
        'denied rows must not carry an approval_scope',
      );
    }
  }
  if (event.kind === 'question') {
    if (
      typeof event.question_id !== 'string' ||
      event.question_id.length === 0
    ) {
      throw new SessionEventValidationError('question rows require question_id');
    }
    if (typeof event.text !== 'string' || event.text.trim().length === 0) {
      throw new SessionEventValidationError(
        'question rows require non-empty text',
      );
    }
    if (
      event.question_input_mode === undefined ||
      !QUESTION_INPUT_MODES.has(event.question_input_mode)
    ) {
      throw new SessionEventValidationError(
        'question rows require a known input mode',
      );
    }
    if (event.question_input_mode === 'options') {
      if (!validQuestionOptionsJson(event.question_options_json)) {
        throw new SessionEventValidationError(
          'options-mode question rows require valid options',
        );
      }
    } else if (event.question_options_json !== undefined) {
      throw new SessionEventValidationError(
        'free-text question rows must not carry options',
      );
    }
    if (
      event.question_required !== undefined &&
      typeof event.question_required !== 'boolean'
    ) {
      throw new SessionEventValidationError(
        'question_required must be a boolean when present',
      );
    }
  }
  if (event.kind === 'question_response') {
    if (
      typeof event.question_id !== 'string' ||
      event.question_id.length === 0
    ) {
      throw new SessionEventValidationError(
        'question_response rows require question_id',
      );
    }
    if (
      event.question_response_status === undefined ||
      !QUESTION_RESPONSE_STATUSES.has(event.question_response_status)
    ) {
      throw new SessionEventValidationError(
        'question_response rows require a known status',
      );
    }
    if (event.question_response_status === 'answered') {
      if (typeof event.answer !== 'string' || event.answer.length === 0) {
        throw new SessionEventValidationError(
          'answered rows require a non-empty answer',
        );
      }
    } else if (event.answer !== undefined) {
      throw new SessionEventValidationError(
        'unanswered rows must not carry an answer',
      );
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
 * Drops the oldest rows of a session-wide log beyond the cap, keeping the
 * newest events in recorded order. One shared trim for append, attach, and
 * extract so the 512-row promise holds on every path.
 */
export function trimSessionEventsToCap(
  log: readonly SessionEventV1[],
  maxEvents: number = MAX_SESSION_EVENT_LOG_SIZE,
): readonly SessionEventV1[] {
  if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0) {
    throw new SessionEventValidationError(
      'maxEvents must be a positive safe integer',
    );
  }
  if (log.length <= maxEvents) return log;
  return log.slice(log.length - maxEvents);
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
  // Enforce the same cap as appendSessionEventBounded so an oversized
  // in-memory log can never be persisted past the 512-row promise.
  return {
    ...snapshot,
    [SESSION_EVENTS_SNAPSHOT_KEY]: trimSessionEventsToCap(log),
  };
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
    // Enforce the same cap as appendSessionEventBounded: oversized data on
    // disk is trimmed to the newest rows instead of being hydrated in full
    // and written back past the 512-row promise.
    return trimSessionEventsToCap(hydrateSessionEvents(raw));
  } catch {
    return null;
  }
}

/**
 * A row as emitters provide it — everything except the fields the journal
 * owns (event_id, seq, created_at). Emitters still set schema_version and
 * attempt_id explicitly so protocol rows stay self-describing at the edge.
 */
export type SessionEventDraft = Omit<
  SessionEventV1,
  'schema_version' | 'event_id' | 'attempt_id' | 'seq' | 'created_at'
>;

export type SessionEventEmission = SessionEventDraft & {
  readonly schema_version: typeof SESSION_EVENT_SCHEMA_VERSION;
  readonly attempt_id: string;
};

/**
 * Next seq for one attempt in a session-wide log: one past the highest seq
 * already recorded for that attempt, or 0 for a fresh attempt. This is the
 * single allocation point that keeps `seq` strictly increasing per attempt
 * even when several emitters (completion controller, agent turn driver)
 * write into the same log for the same attempt.
 */
export function nextSessionEventSeq(
  log: readonly SessionEventV1[],
  attemptId: string,
): number {
  let max = -1;
  for (const event of log) {
    if (event.attempt_id === attemptId && event.seq > max) max = event.seq;
  }
  return max + 1;
}

export type SessionEventJournal = {
  /** Immutable view of the current bounded log. */
  readonly snapshot: () => readonly SessionEventV1[];
  /**
   * Allocates event_id/seq/created_at synchronously and appends the row
   * under the 512-row cap. Allocation and append happen in one synchronous
   * step, so two emitters sharing a journal can never collide on
   * event_id (`${attemptId}-${seq}`) or regress seq — the structural fix
   * for the dual-emitter namespace hazard.
   */
  readonly append: (event: SessionEventEmission) => SessionEventV1;
  /**
   * Replaces the log with restored rows (e.g. after a restart). null resets
   * to an empty log; malformed rows are discarded fail-closed instead of
   * being appended later as if they never happened.
   */
  readonly restore: (log: readonly SessionEventV1[] | null) => void;
};

export function createSessionEventJournal(
  initial: readonly SessionEventV1[] | null = null,
): SessionEventJournal {
  let log: readonly SessionEventV1[] = [];
  const restore = (rows: readonly SessionEventV1[] | null): void => {
    if (rows === null) {
      log = [];
      return;
    }
    try {
      log = trimSessionEventsToCap(hydrateSessionEvents(rows));
    } catch {
      // Fail closed: corrupted restored rows leave an empty log; nothing
      // invalid is ever appended later on top of a broken trajectory.
      log = [];
    }
  };
  restore(initial);
  return {
    snapshot: () => log,
    append: event => {
      const seq = nextSessionEventSeq(log, event.attempt_id);
      const row: SessionEventV1 = {
        ...event,
        event_id: `${event.attempt_id}-${seq}`,
        seq,
        created_at: new Date().toISOString(),
      };
      log = appendSessionEventBounded(log, row);
      return row;
    },
    restore,
  };
}

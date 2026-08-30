import type {
  QuestionInputModeValue,
  SessionEventDraft,
} from './SessionEvents';

/**
 * DSH-style structured question protocol for agent turns.
 *
 * The agent can ask the user a question (the 'ask_user' tool): either a
 * closed choice between options or free text. Question and response are
 * recorded in the same SessionEvent trajectory as everything else, so a
 * Q&A replays in order across restarts. Answers are validated strictly —
 * option answers must be one of the offered ids, free text must be
 * non-empty and bounded, required questions cannot be dismissed — and
 * anything else is rejected fail-closed instead of being fed to the model.
 */

export const QUESTION_INPUT_MODES: readonly QuestionInputModeValue[] = [
  'options',
  'free_text',
];

export const MAX_QUESTION_OPTIONS = 8 as const;
export const MAX_FREE_TEXT_ANSWER_LENGTH = 4000 as const;
export const MAX_QUESTION_TEXT_LENGTH = 2000 as const;
export const DEFAULT_QUESTION_TIMEOUT_MS = 120_000 as const;

export type QuestionOption = {
  readonly id: string;
  readonly label: string;
};

export type QuestionSpec = {
  readonly questionId: string;
  readonly text: string;
  readonly inputMode: QuestionInputModeValue;
  /** Required for options mode; must be empty for free text. */
  readonly options: readonly QuestionOption[];
  readonly required: boolean;
};

export type QuestionAnswer =
  | { readonly status: 'answered'; readonly answer: string }
  | { readonly status: 'cancelled' }
  | { readonly status: 'invalid'; readonly reason: string };

export type RawQuestionAnswer = unknown;

/** Builds a valid spec from a parsed tool argument payload. */
export function parseQuestionSpec(
  questionId: string,
  text: unknown,
  inputMode: unknown,
  options: unknown,
  required: unknown,
): QuestionSpec | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  if (text.length > MAX_QUESTION_TEXT_LENGTH) return null;
  if (inputMode !== 'options' && inputMode !== 'free_text') return null;
  const parsedOptions: QuestionOption[] = [];
  if (inputMode === 'options') {
    if (!Array.isArray(options) || options.length === 0) return null;
    if (options.length > MAX_QUESTION_OPTIONS) return null;
    const seen = new Set<string>();
    for (const value of options) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
      }
      const record = value as Record<string, unknown>;
      if (
        typeof record.id !== 'string' ||
        record.id.length === 0 ||
        record.id.length > 64 ||
        typeof record.label !== 'string' ||
        record.label.length === 0 ||
        record.label.length > 200
      ) {
        return null;
      }
      if (seen.has(record.id)) return null;
      seen.add(record.id);
      parsedOptions.push({ id: record.id, label: record.label });
    }
  } else if (options !== undefined && options !== null) {
    return null;
  }
  const requiredFlag = required === true;
  return {
    questionId,
    text: text.trim(),
    inputMode,
    options: parsedOptions,
    required: requiredFlag,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a raw answer against the question spec. Fail-closed: unknown
 * question ids, malformed payloads, out-of-set option ids, oversize or
 * empty free text, and dismissal of a required question all resolve to
 * invalid — never to a fabricated answer.
 */
export function resolveQuestionAnswer(
  spec: QuestionSpec,
  raw: RawQuestionAnswer,
): QuestionAnswer {
  if (!isRecord(raw) || raw.question_id !== spec.questionId) {
    return { status: 'invalid', reason: 'mismatched question_id' };
  }
  if (raw.status === 'cancelled') {
    if (spec.required) {
      return { status: 'invalid', reason: 'required question cannot be cancelled' };
    }
    return { status: 'cancelled' };
  }
  if (raw.status !== 'answered') {
    return { status: 'invalid', reason: 'unknown status' };
  }
  if (typeof raw.answer !== 'string') {
    return { status: 'invalid', reason: 'answer must be a string' };
  }
  const answer = raw.answer.trim();
  if (answer.length === 0) {
    return { status: 'invalid', reason: 'answer must not be empty' };
  }
  if (answer.length > MAX_FREE_TEXT_ANSWER_LENGTH) {
    return { status: 'invalid', reason: 'answer too long' };
  }
  if (spec.inputMode === 'options') {
    if (!spec.options.some(option => option.id === answer)) {
      return { status: 'invalid', reason: 'answer is not an offered option' };
    }
  }
  return { status: 'answered', answer };
}

export function questionDraft(spec: QuestionSpec): SessionEventDraft {
  return {
    kind: 'question',
    question_id: spec.questionId,
    text: spec.text,
    question_input_mode: spec.inputMode,
    ...(spec.inputMode === 'options'
      ? { question_options_json: JSON.stringify(spec.options) }
      : {}),
    ...(spec.required ? { question_required: true } : {}),
  };
}

export function questionResponseDraft(
  spec: QuestionSpec,
  answer: QuestionAnswer,
): SessionEventDraft {
  if (answer.status === 'answered') {
    return {
      kind: 'question_response',
      question_id: spec.questionId,
      question_response_status: 'answered',
      answer: answer.answer,
    };
  }
  return {
    kind: 'question_response',
    question_id: spec.questionId,
    question_response_status:
      answer.status === 'cancelled' ? 'cancelled' : 'invalid',
  };
}

/** The option whose id matches a recorded answer, for replay rendering. */
export function optionLabelForAnswer(
  spec: QuestionSpec,
  answer: string,
): string | null {
  const match = spec.options.find(option => option.id === answer);
  return match === undefined ? null : match.label;
}
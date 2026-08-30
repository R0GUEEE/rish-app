import {
  MAX_FREE_TEXT_ANSWER_LENGTH,
  MAX_QUESTION_OPTIONS,
  optionLabelForAnswer,
  parseQuestionSpec,
  questionDraft,
  questionResponseDraft,
  resolveQuestionAnswer,
  type QuestionSpec,
} from '../src/agent/AgentQuestions';
import {
  createSessionEventJournal,
  type SessionEventEmission,
} from '../src/agent/SessionEvents';

const optionsSpec = (overrides: Partial<QuestionSpec> = {}): QuestionSpec => ({
  questionId: 'q-1',
  text: 'Which file?',
  inputMode: 'options',
  options: [
    { id: 'a', label: 'notes.md' },
    { id: 'b', label: 'todo.md' },
  ],
  required: false,
  ...overrides,
});

const freeTextSpec = (overrides: Partial<QuestionSpec> = {}): QuestionSpec => ({
  questionId: 'q-1',
  text: 'What should it be called?',
  inputMode: 'free_text',
  options: [],
  required: false,
  ...overrides,
});

test('parseQuestionSpec accepts well-formed options and free-text payloads', () => {
  expect(
    parseQuestionSpec(
      'q-1',
      'Which file?',
      'options',
      [{ id: 'a', label: 'notes.md' }],
      false,
    ),
  ).toEqual(optionsSpec({ options: [{ id: 'a', label: 'notes.md' }] }));
  expect(
    parseQuestionSpec('q-1', 'Name it', 'free_text', undefined, true),
  ).toEqual({
    questionId: 'q-1',
    text: 'Name it',
    inputMode: 'free_text',
    options: [],
    required: true,
  });
});

test('parseQuestionSpec rejects malformed payloads', () => {
  expect(parseQuestionSpec('q-1', '', 'free_text', undefined, false)).toBeNull();
  expect(parseQuestionSpec('q-1', 'x', 'typed', undefined, false)).toBeNull();
  // Options mode with no options, duplicate ids, or oversize lists.
  expect(parseQuestionSpec('q-1', 'x', 'options', [], false)).toBeNull();
  expect(
    parseQuestionSpec('q-1', 'x', 'options', [
      { id: 'a', label: 'x' },
      { id: 'a', label: 'y' },
    ], false),
  ).toBeNull();
  const many = Array.from({ length: MAX_QUESTION_OPTIONS + 1 }, (_, i) => ({
    id: 'o' + i,
    label: 'option ' + i,
  }));
  expect(parseQuestionSpec('q-1', 'x', 'options', many, false)).toBeNull();
  // Free-text rows must not smuggle an option list.
  expect(
    parseQuestionSpec('q-1', 'x', 'free_text', [{ id: 'a', label: 'x' }], false),
  ).toBeNull();
});

test('answers validate against the spec fail-closed', () => {
  // Valid option answer.
  expect(
    resolveQuestionAnswer(optionsSpec(), {
      status: 'answered',
      question_id: 'q-1',
      answer: 'a',
    }),
  ).toEqual({ status: 'answered', answer: 'a' });
  // Free text is trimmed and bounded.
  expect(
    resolveQuestionAnswer(freeTextSpec(), {
      status: 'answered',
      question_id: 'q-1',
      answer: '  hello  ',
    }),
  ).toEqual({ status: 'answered', answer: 'hello' });
  // Out-of-set option id.
  expect(
    resolveQuestionAnswer(optionsSpec(), {
      status: 'answered',
      question_id: 'q-1',
      answer: 'zzz',
    }),
  ).toEqual({ status: 'invalid', reason: 'answer is not an offered option' });
  // Wrong question id.
  expect(
    resolveQuestionAnswer(optionsSpec(), {
      status: 'answered',
      question_id: 'other',
      answer: 'a',
    }),
  ).toEqual({ status: 'invalid', reason: 'mismatched question_id' });
  // Malformed payloads.
  expect(resolveQuestionAnswer(optionsSpec(), 'a')).toEqual({
    status: 'invalid',
    reason: 'mismatched question_id',
  });
  expect(
    resolveQuestionAnswer(optionsSpec(), { status: 'answered', question_id: 'q-1' }),
  ).toEqual({ status: 'invalid', reason: 'answer must be a string' });
  expect(
    resolveQuestionAnswer(optionsSpec(), {
      status: 'answered',
      question_id: 'q-1',
      answer: '   ',
    }),
  ).toEqual({ status: 'invalid', reason: 'answer must not be empty' });
  expect(
    resolveQuestionAnswer(freeTextSpec(), {
      status: 'answered',
      question_id: 'q-1',
      answer: 'x'.repeat(MAX_FREE_TEXT_ANSWER_LENGTH + 1),
    }),
  ).toEqual({ status: 'invalid', reason: 'answer too long' });
  expect(
    resolveQuestionAnswer(optionsSpec(), { status: 'weird', question_id: 'q-1' }),
  ).toEqual({ status: 'invalid', reason: 'unknown status' });
});

test('cancellation is allowed for optional questions and rejected for required ones', () => {
  expect(
    resolveQuestionAnswer(optionsSpec(), {
      status: 'cancelled',
      question_id: 'q-1',
    }),
  ).toEqual({ status: 'cancelled' });
  expect(
    resolveQuestionAnswer(
      optionsSpec({ required: true }),
      { status: 'cancelled', question_id: 'q-1' },
    ),
  ).toEqual({ status: 'invalid', reason: 'required question cannot be cancelled' });
});

test('question drafts produce schema-valid rows that hydrate and replay', () => {
  const journal = createSessionEventJournal();
  const spec = optionsSpec();
  journal.append({
    schema_version: 1,
    attempt_id: 'att-1',
    ...questionDraft(spec),
  } as SessionEventEmission);
  journal.append({
    schema_version: 1,
    attempt_id: 'att-1',
    ...questionResponseDraft(spec, { status: 'answered', answer: 'a' }),
  } as SessionEventEmission);
  const rows = journal.snapshot();
  expect(rows.map(row => row.kind)).toEqual(['question', 'question_response']);
  expect(rows[0]).toMatchObject({
    question_id: 'q-1',
    text: 'Which file?',
    question_input_mode: 'options',
  });
  expect(rows[1]).toMatchObject({
    question_id: 'q-1',
    question_response_status: 'answered',
    answer: 'a',
  });
  // A serialized round-trip keeps the ordering intact for restart replay.
  const serialized = JSON.parse(JSON.stringify(rows)) as unknown;
  const restored = createSessionEventJournal(
    serialized as never,
  );
  expect(restored.snapshot().map(row => row.kind)).toEqual([
    'question',
    'question_response',
  ]);
  expect(optionLabelForAnswer(spec, 'a')).toBe('notes.md');
  expect(optionLabelForAnswer(spec, 'zzz')).toBeNull();
});

test('cancelled and invalid responses keep the schema-valid shape', () => {
  const journal = createSessionEventJournal();
  const spec = freeTextSpec();
  journal.append({
    schema_version: 1,
    attempt_id: 'att-1',
    ...questionDraft(spec),
  } as SessionEventEmission);
  journal.append({
    schema_version: 1,
    attempt_id: 'att-1',
    ...questionResponseDraft(spec, { status: 'cancelled' }),
  } as SessionEventEmission);
  journal.append({
    schema_version: 1,
    attempt_id: 'att-1',
    ...questionResponseDraft(spec, { status: 'invalid', reason: 'unknown status' }),
  } as SessionEventEmission);
  expect(journal.snapshot().map(row => row.question_response_status)).toEqual([
    undefined,
    'cancelled',
    'invalid',
  ]);
});

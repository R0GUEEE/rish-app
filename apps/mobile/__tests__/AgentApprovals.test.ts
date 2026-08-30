import {
  approvalRequestDraft,
  approvalResponseDraft,
  approvalScopeValues,
  resolveApprovalDecision,
  unansweredApprovalRequests,
  unansweredQuestions,
  type ApprovalRequestSpec,
} from '../src/agent/AgentApprovals';
import {
  createSessionEventJournal,
  type SessionEventEmission,
} from '../src/agent/SessionEvents';
import { questionDraft, questionResponseDraft } from '../src/agent/AgentQuestions';

const spec = (overrides: Partial<ApprovalRequestSpec> = {}): ApprovalRequestSpec => ({
  approvalId: 'ap-1',
  toolCallId: 'c1',
  toolName: 'write_file',
  argumentsJson: '{"path":"a"}',
  scopes: ['once', 'conversation'],
  expiresAtMs: Date.now() + 60_000,
  ...overrides,
});

test('a well-formed approved answer resolves to approved with its scope', () => {
  expect(
    resolveApprovalDecision(
      spec(),
      { status: 'approved', approval_id: 'ap-1', scope: 'once' },
      500,
    ),
  ).toEqual({ status: 'approved', scope: 'once' });
  expect(
    resolveApprovalDecision(
      spec(),
      { status: 'approved', approval_id: 'ap-1', scope: 'conversation' },
      500,
    ),
  ).toEqual({ status: 'approved', scope: 'conversation' });
});

test('an explicit user denial resolves to denied with user resolution', () => {
  expect(
    resolveApprovalDecision(
      spec(),
      { status: 'denied', approval_id: 'ap-1' },
      500,
    ),
  ).toEqual({ status: 'denied', resolution: 'user' });
});

test('fail-closed branches: expiry, missing, malformed, mismatched, bad scope', () => {
  const now = Date.now();
  const live = spec({ expiresAtMs: now + 60_000 });
  const expired = spec({ expiresAtMs: now });
  // Expired deadline wins even over a well-formed approval.
  expect(
    resolveApprovalDecision(
      expired,
      { status: 'approved', approval_id: 'ap-1', scope: 'once' },
      now,
    ),
  ).toEqual({ status: 'denied', resolution: 'timeout' });
  expect(
    resolveApprovalDecision(
      expired,
      { status: 'approved', approval_id: 'ap-1', scope: 'once' },
      now + 1,
    ),
  ).toEqual({ status: 'denied', resolution: 'timeout' });
  // Missing answer.
  expect(resolveApprovalDecision(live, undefined, now)).toEqual({
    status: 'denied',
    resolution: 'missing',
  });
  expect(resolveApprovalDecision(live, null, now)).toEqual({
    status: 'denied',
    resolution: 'missing',
  });
  // Malformed answer shapes.
  expect(resolveApprovalDecision(live, 'approved', now)).toEqual({
    status: 'denied',
    resolution: 'invalid',
  });
  expect(resolveApprovalDecision(live, 42, now)).toEqual({
    status: 'denied',
    resolution: 'invalid',
  });
  expect(
    resolveApprovalDecision(live, { status: 'maybe' }, now),
  ).toEqual({ status: 'denied', resolution: 'invalid' });
  // Wrong approval id is a schema mismatch — never an approval.
  expect(
    resolveApprovalDecision(
      live,
      { status: 'approved', approval_id: 'other', scope: 'once' },
      now,
    ),
  ).toEqual({ status: 'denied', resolution: 'invalid' });
  // Scope outside the offered set is a schema mismatch.
  expect(
    resolveApprovalDecision(
      live,
      { status: 'approved', approval_id: 'ap-1', scope: 'forever' },
      now,
    ),
  ).toEqual({ status: 'denied', resolution: 'invalid' });
  expect(
    resolveApprovalDecision(
      live,
      { status: 'approved', approval_id: 'ap-1' },
      now,
    ),
  ).toEqual({ status: 'denied', resolution: 'invalid' });
  // A scope the request did not offer can never be granted.
  expect(
    resolveApprovalDecision(
      spec({ scopes: ['once'], expiresAtMs: now + 60_000 }),
      { status: 'approved', approval_id: 'ap-1', scope: 'conversation' },
      now,
    ),
  ).toEqual({ status: 'denied', resolution: 'invalid' });
});

test('drafts produce schema-valid rows that hydrate', () => {
  const journal = createSessionEventJournal();
  journal.append({
    schema_version: 1,
    attempt_id: 'att-1',
    ...approvalRequestDraft(spec()),
  } as SessionEventEmission);
  journal.append({
    schema_version: 1,
    attempt_id: 'att-1',
    ...approvalResponseDraft(spec(), { status: 'approved', scope: 'once' }),
  } as SessionEventEmission);
  const denied = spec({ approvalId: 'ap-2' });
  journal.append({
    schema_version: 1,
    attempt_id: 'att-1',
    ...approvalRequestDraft(denied),
  } as SessionEventEmission);
  journal.append({
    schema_version: 1,
    attempt_id: 'att-1',
    ...approvalResponseDraft(denied, {
      status: 'denied',
      resolution: 'timeout',
    }),
  } as SessionEventEmission);
  const rows = journal.snapshot();
  expect(rows.map(row => row.kind)).toEqual([
    'approval_request',
    'approval_response',
    'approval_request',
    'approval_response',
  ]);
  expect(rows[1]).toMatchObject({
    approval_decision: 'approved',
    approval_scope: 'once',
    approval_resolution: 'user',
  });
  expect(rows[3]).toMatchObject({
    approval_decision: 'denied',
    approval_resolution: 'timeout',
  });
});

test('scope list parsing is strict', () => {
  expect(approvalScopeValues('["once","conversation"]')).toEqual([
    'once',
    'conversation',
  ]);
  expect(approvalScopeValues('["once"]')).toEqual(['once']);
  expect(approvalScopeValues('[]')).toBeNull();
  expect(approvalScopeValues('["once","once"]')).toBeNull();
  expect(approvalScopeValues('["forever"]')).toBeNull();
  expect(approvalScopeValues('not-json')).toBeNull();
  expect(approvalScopeValues('"once"')).toBeNull();
});

test('restart replay: unanswered approval requests are surfaced, answered ones are not', () => {
  const journal = createSessionEventJournal();
  const answered = spec({ approvalId: 'ap-answered' });
  const open = spec({ approvalId: 'ap-open' });
  journal.append({
    schema_version: 1,
    attempt_id: 'att-1',
    ...approvalRequestDraft(answered),
  } as SessionEventEmission);
  journal.append({
    schema_version: 1,
    attempt_id: 'att-1',
    ...approvalResponseDraft(answered, { status: 'denied', resolution: 'user' }),
  } as SessionEventEmission);
  journal.append({
    schema_version: 1,
    attempt_id: 'att-1',
    ...approvalRequestDraft(open),
  } as SessionEventEmission);
  journal.append({
    schema_version: 1,
    attempt_id: 'other',
    ...approvalRequestDraft(spec({ approvalId: 'ap-other' })),
  } as SessionEventEmission);

  const openRows = unansweredApprovalRequests(journal.snapshot(), 'att-1');
  expect(openRows.map(row => row.approval_id)).toEqual(['ap-open']);
  // Whatever resumes this attempt must treat 'ap-open' as denied.
  expect(
    resolveApprovalDecision(open, undefined, Date.now()),
  ).toEqual({ status: 'denied', resolution: 'missing' });
});

test('restart replay: unanswered questions are surfaced per attempt', () => {
  const journal = createSessionEventJournal();
  const answered = {
    questionId: 'q-answered',
    text: 'Which file?',
    inputMode: 'options' as const,
    options: [{ id: 'a', label: 'notes.md' }],
    required: false,
  };
  const open = { ...answered, questionId: 'q-open' };
  journal.append({
    schema_version: 1,
    attempt_id: 'att-1',
    ...questionDraft(answered),
  } as SessionEventEmission);
  journal.append({
    schema_version: 1,
    attempt_id: 'att-1',
    ...questionResponseDraft(answered, { status: 'answered', answer: 'a' }),
  } as SessionEventEmission);
  journal.append({
    schema_version: 1,
    attempt_id: 'att-1',
    ...questionDraft(open),
  } as SessionEventEmission);

  expect(
    unansweredQuestions(journal.snapshot(), 'att-1').map(row => row.question_id),
  ).toEqual(['q-open']);
});

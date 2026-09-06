import { createAgentInteractionController } from '../src/agent/AgentInteractionController';
import {
  resolveApprovalDecision,
  type ApprovalRequestSpec,
} from '../src/agent/AgentApprovals';
import type { QuestionSpec } from '../src/agent/AgentQuestions';

const approvalSpec: ApprovalRequestSpec = {
  approvalId: 'ap-1',
  toolCallId: 'c1',
  toolName: 'write_file',
  argumentsJson: '{"path":"a"}',
  preview: null,
  scopes: ['once', 'conversation'],
  expiresAtMs: Date.now() + 120_000,
};

const questionSpec: QuestionSpec = {
  questionId: 'q-1',
  text: 'Which file?',
  inputMode: 'options',
  options: [{ id: 'a', label: 'notes.md' }],
  required: false,
};

test('requestApproval publishes the pending card and settles on decide', async () => {
  const controller = createAgentInteractionController();
  const seen: ApprovalRequestSpec[][] = [];
  controller.subscribe(state => seen.push([...state.pendingApprovals]));

  const decisionPromise = controller.requestApproval(approvalSpec);
  expect(controller.getState().pendingApprovals).toEqual([approvalSpec]);
  expect(seen.at(-1)).toEqual([approvalSpec]);

  controller.decideApproval('ap-1', {
    status: 'approved',
    approval_id: 'ap-1',
    scope: 'once',
  });
  await expect(decisionPromise).resolves.toEqual({
    status: 'approved',
    approval_id: 'ap-1',
    scope: 'once',
  });
  expect(controller.getState().pendingApprovals).toEqual([]);
  expect(seen.at(-1)).toEqual([]);
});

test('the broker adds the matched approval id to a UI allow decision', async () => {
  const controller = createAgentInteractionController();
  const decisionPromise = controller.requestApproval(approvalSpec);

  // ApprovalComposer sends status + scope; the broker owns the protocol id.
  controller.decideApproval('ap-1', {
    status: 'approved',
    scope: 'once',
  });

  const rawDecision = await decisionPromise;
  expect(rawDecision).toEqual({
    status: 'approved',
    approval_id: 'ap-1',
    scope: 'once',
  });
  expect(resolveApprovalDecision(approvalSpec, rawDecision, Date.now())).toEqual({
    status: 'approved',
    scope: 'once',
  });
});

test('git_push follows the git_commit pattern and accepts conversation scope', async () => {
  const controller = createAgentInteractionController();
  const conversationSpec: ApprovalRequestSpec = {
    ...approvalSpec,
    approvalId: 'ap-push-conversation',
    toolCallId: 'push-conversation',
    toolName: 'git_push',
  };
  const conversationDecision = controller.requestApproval(conversationSpec);

  controller.decideApproval('ap-push-conversation', {
    status: 'approved',
    scope: 'conversation',
  });

  await expect(conversationDecision).resolves.toEqual({
    status: 'approved',
    approval_id: 'ap-push-conversation',
    scope: 'conversation',
  });

  const onceSpec: ApprovalRequestSpec = {
    ...conversationSpec,
    approvalId: 'ap-push-once',
    toolCallId: 'push-once',
  };
  const onceDecision = controller.requestApproval(onceSpec);
  controller.decideApproval('ap-push-once', {
    status: 'approved',
    scope: 'once',
  });

  await expect(onceDecision).resolves.toEqual({
    status: 'approved',
    approval_id: 'ap-push-once',
    scope: 'once',
  });
});

test('decisions for unknown ids are ignored', async () => {
  const controller = createAgentInteractionController();
  const decisionPromise = controller.requestApproval(approvalSpec);
  controller.decideApproval('someone-else', { status: 'denied' });
  expect(controller.getState().pendingApprovals).toEqual([approvalSpec]);
  controller.decideApproval('ap-1', { status: 'denied' });
  await expect(decisionPromise).resolves.toEqual({
    status: 'denied',
    approval_id: 'ap-1',
  });
});

test('an unanswered approval clears its card after the timeout', async () => {
  jest.useFakeTimers();
  try {
    const controller = createAgentInteractionController({
      approvalTimeoutMs: 1000,
    });
    const decisionPromise = controller.requestApproval(approvalSpec);
    expect(controller.getState().pendingApprovals).toEqual([approvalSpec]);
    await jest.advanceTimersByTimeAsync(1100);
    await expect(decisionPromise).resolves.toBeUndefined();
    expect(controller.getState().pendingApprovals).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});

test('a late decision for an expired approval id is ignored', async () => {
  jest.useFakeTimers();
  try {
    const controller = createAgentInteractionController({
      approvalTimeoutMs: 1000,
    });
    const decisionPromise = controller.requestApproval({
      ...approvalSpec,
      expiresAtMs: Date.now() + 1000,
    });
    await jest.advanceTimersByTimeAsync(1100);

    controller.decideApproval('ap-1', {
      status: 'approved',
      scope: 'once',
    });
    await expect(decisionPromise).resolves.toBeUndefined();
    expect(controller.getState().pendingApprovals).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});

test('a second approval request settles the first fail-closed', async () => {
  const controller = createAgentInteractionController();
  const first = controller.requestApproval(approvalSpec);
  const secondSpec = { ...approvalSpec, approvalId: 'ap-2' };
  const second = controller.requestApproval(secondSpec);
  await expect(first).resolves.toBeUndefined();
  expect(controller.getState().pendingApprovals).toEqual([secondSpec]);
  controller.decideApproval('ap-2', { status: 'denied', approval_id: 'ap-2' });
  await expect(second).resolves.toEqual({
    status: 'denied',
    approval_id: 'ap-2',
  });
});

test('askQuestion publishes the composer and settles on answer or cancel', async () => {
  const controller = createAgentInteractionController();
  const seen: (QuestionSpec | null)[] = [];
  controller.subscribe(state => seen.push(state.pendingQuestion));

  const answerPromise = controller.askQuestion(questionSpec);
  expect(controller.getState().pendingQuestion).toEqual(questionSpec);
  controller.answerQuestion('q-1', 'a');
  await expect(answerPromise).resolves.toEqual({
    status: 'answered',
    question_id: 'q-1',
    answer: 'a',
  });
  expect(controller.getState().pendingQuestion).toBeNull();

  const cancelPromise = controller.askQuestion(questionSpec);
  expect(controller.getState().pendingQuestion).toEqual(questionSpec);
  controller.cancelQuestion('q-1');
  await expect(cancelPromise).resolves.toEqual({
    status: 'cancelled',
    question_id: 'q-1',
  });
  expect(controller.getState().pendingQuestion).toBeNull();
});

test('an unanswered question clears its composer after the timeout', async () => {
  jest.useFakeTimers();
  try {
    const controller = createAgentInteractionController({
      questionTimeoutMs: 1000,
    });
    const answerPromise = controller.askQuestion(questionSpec);
    expect(controller.getState().pendingQuestion).toEqual(questionSpec);
    await jest.advanceTimersByTimeAsync(1100);
    await expect(answerPromise).resolves.toBeUndefined();
    expect(controller.getState().pendingQuestion).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});


test('requestBatchApprovals presents every item and settles one decision list', async () => {
  const controller = createAgentInteractionController();
  const secondSpec: ApprovalRequestSpec = {
    ...approvalSpec,
    approvalId: 'ap-2',
    toolCallId: 'c2',
    toolName: 'git_commit',
    preview: null,
  };
  const batch = controller.requestBatchApprovals([approvalSpec, secondSpec]);
  expect(controller.getState().pendingApprovals).toEqual([
    approvalSpec,
    secondSpec,
  ]);
  controller.decideBatchApprovals([
    { approvalId: 'ap-1', decision: { status: 'approved', scope: 'once' } },
    {
      approvalId: 'ap-2',
      decision: { status: 'denied', message: 'no commits today' },
    },
  ]);
  await expect(batch).resolves.toEqual([
    { status: 'approved', approval_id: 'ap-1', scope: 'once' },
    { status: 'denied', approval_id: 'ap-2', message: 'no commits today' },
  ]);
  expect(controller.getState().pendingApprovals).toEqual([]);
});

test('a batch decision for an unknown id fails closed for that item', async () => {
  const controller = createAgentInteractionController();
  const secondSpec: ApprovalRequestSpec = {
    ...approvalSpec,
    approvalId: 'ap-2',
    toolCallId: 'c2',
    toolName: 'git_commit',
    preview: null,
  };
  const batch = controller.requestBatchApprovals([approvalSpec, secondSpec]);
  controller.decideBatchApprovals([
    { approvalId: 'someone-else', decision: { status: 'approved', scope: 'once' } },
  ]);
  await expect(batch).resolves.toEqual([undefined, undefined]);
  expect(controller.getState().pendingApprovals).toEqual([]);
});

test('an unanswered batch clears every card after the timeout', async () => {
  jest.useFakeTimers();
  try {
    const controller = createAgentInteractionController({
      approvalTimeoutMs: 1000,
    });
    const secondSpec: ApprovalRequestSpec = {
      ...approvalSpec,
      approvalId: 'ap-2',
      toolCallId: 'c2',
      toolName: 'git_commit',
      preview: null,
    };
    const batch = controller.requestBatchApprovals([approvalSpec, secondSpec]);
    expect(controller.getState().pendingApprovals).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(1100);
    await expect(batch).resolves.toEqual([undefined, undefined]);
    expect(controller.getState().pendingApprovals).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});

test('a deny message is carried through the batch broker', async () => {
  const controller = createAgentInteractionController();
  const batch = controller.requestBatchApprovals([approvalSpec]);
  controller.decideBatchApprovals([
    { approvalId: 'ap-1', decision: { status: 'denied', message: 'leave it' } },
  ]);
  await expect(batch).resolves.toEqual([
    { status: 'denied', approval_id: 'ap-1', message: 'leave it' },
  ]);
});

test('an oversized reason keeps the batch pending until it is corrected', async () => {
  const controller = createAgentInteractionController();
  const batch = controller.requestBatchApprovals([approvalSpec]);
  let settled = false;
  batch.then(() => { settled = true; });
  controller.decideBatchApprovals([{ approvalId: 'ap-1', decision: { status: 'denied', message: '拒'.repeat(667) } }]);
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(controller.getState().pendingApprovals).toEqual([approvalSpec]);
  const message = '拒'.repeat(666) + 'ab';
  controller.decideBatchApprovals([{ approvalId: 'ap-1', decision: { status: 'denied', message } }]);
  await expect(batch).resolves.toEqual([{ status: 'denied', approval_id: 'ap-1', message }]);
});

test('invalid Unicode cannot silently become a reasonless single denial', async () => {
  const controller = createAgentInteractionController();
  const pending = controller.requestApproval(approvalSpec);
  controller.decideApproval('ap-1', { status: 'denied', message: '\ud800' });
  expect(controller.getState().pendingApprovals).toEqual([approvalSpec]);
  const message = '😀'.repeat(500);
  controller.decideApproval('ap-1', { status: 'denied', message });
  await expect(pending).resolves.toEqual({ status: 'denied', approval_id: 'ap-1', message });
});

test('one invalid batch reason prevents partial approval settlement', async () => {
  const controller = createAgentInteractionController();
  const second = { ...approvalSpec, approvalId: 'ap-2', toolCallId: 'c2' };
  const pending = controller.requestBatchApprovals([approvalSpec, second]);
  controller.decideBatchApprovals([
    { approvalId: 'ap-1', decision: { status: 'approved', scope: 'once' } },
    { approvalId: 'ap-2', decision: { status: 'denied', message: 'x'.repeat(2001) } },
  ]);
  expect(controller.getState().pendingApprovals).toHaveLength(2);
  controller.cancelPending();
  await expect(pending).resolves.toEqual([undefined, undefined]);
});

test('invalid reasons do not extend the fail-closed deadline', async () => {
  jest.useFakeTimers();
  try {
    const controller = createAgentInteractionController({ approvalTimeoutMs: 100 });
    const pending = controller.requestApproval(approvalSpec);
    jest.advanceTimersByTime(90);
    controller.decideApproval('ap-1', { status: 'denied', message: 'x'.repeat(2001) });
    jest.advanceTimersByTime(10);
    await expect(pending).resolves.toBeUndefined();
    expect(controller.getState().pendingApprovals).toHaveLength(0);
  } finally { jest.useRealTimers(); }
});

test('cancelPending settles every open wait without fabricating answers', async () => {
  const controller = createAgentInteractionController();
  const approval = controller.requestApproval(approvalSpec);
  const question = controller.askQuestion(questionSpec);
  controller.cancelPending();
  await expect(approval).resolves.toBeUndefined();
  await expect(question).resolves.toBeUndefined();
  expect(controller.getState()).toEqual({
    pendingApprovals: [],
    pendingQuestion: null,
  });
});
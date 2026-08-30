import type { ApprovalRequestSpec } from './AgentApprovals';
import { DEFAULT_APPROVAL_TIMEOUT_MS } from './AgentApprovals';
import type { QuestionSpec } from './AgentQuestions';
import { DEFAULT_QUESTION_TIMEOUT_MS } from './AgentQuestions';

/**
 * Broker between the agent-turn driver's wait states and the UI composers.
 *
 * The driver calls requestApproval / askQuestion and awaits. The controller
 * publishes the pending request to subscribers (the composers), settles the
 * promise when the user answers, and clears the pending UI when the request
 * expires so a stale card can never outlive its fail-closed deadline.
 * Settlement is synchronous from the user's tap, so cancellation semantics
 * elsewhere (native transport promises, turn cancel) stay untouched.
 */

export type AgentInteractionState = {
  readonly pendingApproval: ApprovalRequestSpec | null;
  readonly pendingQuestion: QuestionSpec | null;
};

export type AgentInteractionController = {
  getState(): AgentInteractionState;
  subscribe(listener: (state: AgentInteractionState) => void): () => void;
  /** Driver-side dep: presents the request and awaits a raw answer. */
  requestApproval(spec: ApprovalRequestSpec): Promise<unknown>;
  /** Driver-side dep: presents the question and awaits a raw answer. */
  askQuestion(spec: QuestionSpec): Promise<unknown>;
  /** UI action: allow with one of the offered scopes, or deny. */
  decideApproval(approvalId: string, decision: unknown): void;
  /** UI action: submit a validated answer. */
  answerQuestion(questionId: string, answer: string): void;
  /** UI action: dismiss an optional question. */
  cancelQuestion(questionId: string): void;
  /** Settles every pending wait as denied/cancelled (turn teardown). */
  cancelPending(): void;
};

export function createAgentInteractionController(options: {
  readonly approvalTimeoutMs?: number;
  readonly questionTimeoutMs?: number;
} = {}): AgentInteractionController {
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const questionTimeoutMs = options.questionTimeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS;
  let state: AgentInteractionState = {
    pendingApproval: null,
    pendingQuestion: null,
  };
  let approvalWait: {
    spec: ApprovalRequestSpec;
    settle: (value: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let questionWait: {
    spec: QuestionSpec;
    settle: (value: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  const listeners = new Set<(next: AgentInteractionState) => void>();

  const publish = (next: AgentInteractionState) => {
    state = next;
    listeners.forEach(listener => {
      try {
        listener(state);
      } catch {
        // UI listeners cannot affect settlement.
      }
    });
  };

  const clearApproval = () => {
    const pending = approvalWait;
    if (pending === null) return;
    approvalWait = null;
    clearTimeout(pending.timer);
    if (state.pendingApproval?.approvalId === pending.spec.approvalId) {
      publish({ ...state, pendingApproval: null });
    }
  };

  const clearQuestion = () => {
    const pending = questionWait;
    if (pending === null) return;
    questionWait = null;
    clearTimeout(pending.timer);
    if (state.pendingQuestion?.questionId === pending.spec.questionId) {
      publish({ ...state, pendingQuestion: null });
    }
  };

  return {
    getState: () => state,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestApproval: spec =>
      new Promise<unknown>(resolve => {
        const existing = approvalWait;
        if (existing !== null && existing.spec.approvalId !== spec.approvalId) {
          // One pending approval at a time; the older one fails closed.
          existing.settle(undefined);
        }
        clearApproval();
        const timer = setTimeout(() => {
          // UI expiry: hide the card; the driver's own deadline check
          // (expiresAtMs) decides the actual resolution fail-closed.
          const wait = approvalWait;
          if (wait !== null && wait.spec.approvalId === spec.approvalId) {
            wait.settle(undefined);
          }
          clearApproval();
        }, approvalTimeoutMs);
        approvalWait = { spec, settle: resolve, timer };
        publish({ ...state, pendingApproval: spec });
      }),
    askQuestion: spec =>
      new Promise<unknown>(resolve => {
        const existing = questionWait;
        if (existing !== null && existing.spec.questionId !== spec.questionId) {
          existing.settle(undefined);
        }
        clearQuestion();
        const timer = setTimeout(() => {
          const wait = questionWait;
          if (wait !== null && wait.spec.questionId === spec.questionId) {
            wait.settle(undefined);
          }
          clearQuestion();
        }, questionTimeoutMs);
        questionWait = { spec, settle: resolve, timer };
        publish({ ...state, pendingQuestion: spec });
      }),
    decideApproval: (approvalId, decision) => {
      const wait = approvalWait;
      if (wait === null || wait.spec.approvalId !== approvalId) return;
      clearApproval();
      wait.settle(decision);
    },
    answerQuestion: (questionId, answer) => {
      const wait = questionWait;
      if (wait === null || wait.spec.questionId !== questionId) return;
      clearQuestion();
      wait.settle({ status: 'answered', question_id: questionId, answer });
    },
    cancelQuestion: questionId => {
      const wait = questionWait;
      if (wait === null || wait.spec.questionId !== questionId) return;
      clearQuestion();
      wait.settle({ status: 'cancelled', question_id: questionId });
    },
    cancelPending: () => {
      const approval = approvalWait;
      if (approval !== null) {
        clearApproval();
        approval.settle(undefined);
      }
      const question = questionWait;
      if (question !== null) {
        clearQuestion();
        question.settle(undefined);
      }
    },
  };
}
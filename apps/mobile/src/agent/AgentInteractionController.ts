import type { ApprovalRequestSpec } from './AgentApprovals';
import { DEFAULT_APPROVAL_TIMEOUT_MS } from './AgentApprovals';
import type { QuestionSpec } from './AgentQuestions';
import { DEFAULT_QUESTION_TIMEOUT_MS } from './AgentQuestions';

/**
 * Broker between the agent-turn driver's wait states and the UI composers.
 *
 * The driver calls requestApproval / requestBatchApprovals / askQuestion and
 * awaits. The controller publishes the pending requests to subscribers (the
 * composers), settles the promise when the user answers, and clears the
 * pending UI when the request expires so a stale card can never outlive its
 * fail-closed deadline. A batch is presented as one list: every wait is
 * registered before the first paint, and the batch promise resolves only when
 * every item settled, so the driver can never advance a partially decided
 * batch. Settlement is synchronous from the user's tap, so cancellation
 * semantics elsewhere (native transport promises, turn cancel) stay
 * untouched.
 */

export type AgentInteractionState = {
  readonly pendingApprovals: readonly ApprovalRequestSpec[];
  readonly pendingQuestion: QuestionSpec | null;
};

export type AgentApprovalDecisionInput =
  | { readonly status: 'approved'; readonly scope: 'once' | 'conversation' }
  | { readonly status: 'denied'; readonly message?: string };

export type AgentInteractionController = {
  getState(): AgentInteractionState;
  subscribe(listener: (state: AgentInteractionState) => void): () => void;
  /** Driver-side dep: presents the request and awaits a raw answer. */
  requestApproval(spec: ApprovalRequestSpec): Promise<unknown>;
  /** Driver-side dep: presents several requests as one list; resolves with
   * one raw answer per request, in order, once every item settled. */
  requestBatchApprovals(
    specs: readonly ApprovalRequestSpec[],
  ): Promise<unknown[]>;
  /** Driver-side dep: presents the question and awaits a raw answer. */
  askQuestion(spec: QuestionSpec): Promise<unknown>;
  /** UI action: allow with one of the offered scopes, or deny. */
  decideApproval(approvalId: string, decision: unknown): void;
  /** UI action: settle every item of the presented batch at once. */
  decideBatchApprovals(
    decisions: readonly { approvalId: string; decision: unknown }[],
  ): void;
  /** UI action: submit a validated answer. */
  answerQuestion(questionId: string, answer: string): void;
  /** UI action: dismiss an optional question. */
  cancelQuestion(questionId: string): void;
  /** Settles every pending wait as denied/cancelled (turn teardown). */
  cancelPending(): void;
};

function isDecisionRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedMessage(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000) return false;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      bytes += 4;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    else bytes += 3;
    if (bytes > 2000) return false;
  }
  return true;
}

/**
 * UI actions carry the approval id out-of-band. Once the id matches the live
 * wait, the broker must be the source of truth for the protocol id rather
 * than trusting an id (or extra fields) in the UI payload.
 */
function exactApprovalDecision(
  spec: ApprovalRequestSpec,
  decision: unknown,
): unknown {
  if (!isDecisionRecord(decision)) return undefined;
  try {
    if (decision.status === 'denied') {
      const message =
        decision.message === undefined
          ? undefined
          : isBoundedMessage(decision.message)
            ? decision.message
            : undefined;
      return message === undefined
        ? { status: 'denied', approval_id: spec.approvalId }
        : { status: 'denied', approval_id: spec.approvalId, message };
    }
    if (
      decision.status !== 'approved' ||
      (decision.scope !== 'once' && decision.scope !== 'conversation') ||
      !spec.scopes.includes(decision.scope)
    ) {
      return undefined;
    }
    return {
      status: 'approved',
      approval_id: spec.approvalId,
      scope: decision.scope,
    };
  } catch {
    // Hostile/malformed UI values never become an approval.
    return undefined;
  }
}

export function createAgentInteractionController(options: {
  readonly approvalTimeoutMs?: number;
  readonly questionTimeoutMs?: number;
} = {}): AgentInteractionController {
  const approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const questionTimeoutMs = options.questionTimeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS;
  let state: AgentInteractionState = {
    pendingApprovals: [],
    pendingQuestion: null,
  };
  let approvalWaits: {
    spec: ApprovalRequestSpec;
    settle: (value: unknown) => void;
  }[] = [];
  let approvalTimer: ReturnType<typeof setTimeout> | null = null;
  let batchResolve: ((values: readonly unknown[]) => void) | null = null;
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

  const pendingSpecs = (): readonly ApprovalRequestSpec[] =>
    approvalWaits.map(wait => wait.spec);

  const settleAllApprovals = (raw: readonly unknown[]) => {
    const waits = approvalWaits;
    approvalWaits = [];
    if (approvalTimer !== null) {
      clearTimeout(approvalTimer);
      approvalTimer = null;
    }
    const resolve = batchResolve;
    batchResolve = null;
    waits.forEach((wait, index) => wait.settle(raw[index]));
    if (resolve !== null) resolve(raw);
    publish({ ...state, pendingApprovals: [] });
  };

  const clearApprovals = () => {
    if (approvalTimer !== null) {
      clearTimeout(approvalTimer);
      approvalTimer = null;
    }
    if (batchResolve !== null) {
      const resolve = batchResolve;
      batchResolve = null;
      resolve(approvalWaits.map(() => undefined));
    }
    const waits = approvalWaits;
    approvalWaits = [];
    waits.forEach(wait => wait.settle(undefined));
    if (state.pendingApprovals.length > 0) {
      publish({ ...state, pendingApprovals: [] });
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

  const registerApprovals = (
    specs: readonly ApprovalRequestSpec[],
  ): {
    batch: Promise<unknown[]>;
    perItem: readonly Promise<unknown>[];
  } | null => {
    if (approvalWaits.length > 0) {
      // One presented approval batch at a time; the older one fails closed.
      settleAllApprovals(approvalWaits.map(() => undefined));
    }
    if (specs.length === 0) return null;
    const results: unknown[] = new Array<unknown>(specs.length).fill(undefined);
    const batch = new Promise<unknown[]>(resolve => {
      batchResolve = values => resolve([...values]);
    });
    const perItem: Promise<unknown>[] = [];
    approvalWaits = specs.map((spec, index) => {
      let settle: (value: unknown) => void = () => undefined;
      const promise = new Promise<unknown>(resolve => {
        settle = resolve;
      });
      perItem.push(promise);
      return {
        spec,
        settle: (value: unknown) => {
          results[index] = value;
          settle(value);
        },
      };
    });
    if (approvalTimer !== null) clearTimeout(approvalTimer);
    approvalTimer = setTimeout(() => {
      // UI expiry: hide the batch; the driver's own deadline check
      // (expiresAtMs) decides the actual resolution fail-closed.
      settleAllApprovals(results.slice());
    }, approvalTimeoutMs);
    publish({ ...state, pendingApprovals: specs });
    return { batch, perItem };
  };

  return {
    getState: () => state,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    requestApproval: spec => {
      const registered = registerApprovals([spec]);
      return registered?.perItem[0] ?? Promise.resolve(undefined);
    },
    requestBatchApprovals: specs => {
      const registered = registerApprovals(specs);
      return registered?.batch ?? Promise.resolve([]);
    },
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
      const wait = approvalWaits.find(candidate => candidate.spec.approvalId === approvalId);
      if (wait === undefined) return;
      const exactDecision = exactApprovalDecision(wait.spec, decision);
      if (exactDecision === undefined) {
        // A malformed UI decision fails closed: the whole presented list
        // settles as absent answers, which the driver resolves to denials.
        settleAllApprovals(pendingSpecs().map(() => undefined));
        return;
      }
      // Single-item settlement: the whole presented list settles at once so
      // the driver always observes a complete batch.
      settleAllApprovals(
        pendingSpecs().map(spec =>
          spec.approvalId === approvalId ? exactDecision : undefined,
        ),
      );
    },
    decideBatchApprovals: decisions => {
      const settled: unknown[] = pendingSpecs().map(spec => {
        const entry = decisions.find(candidate => candidate.approvalId === spec.approvalId);
        if (entry === undefined) return undefined;
        const exact = exactApprovalDecision(spec, entry.decision);
        return exact === undefined ? { status: 'denied', approval_id: spec.approvalId } : exact;
      });
      settleAllApprovals(settled);
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
      clearApprovals();
      const question = questionWait;
      if (question !== null) {
        clearQuestion();
        question.settle(undefined);
      }
    },
  };
}

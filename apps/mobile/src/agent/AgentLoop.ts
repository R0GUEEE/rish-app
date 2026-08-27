import type { CompletionMessage } from '../native/LocalRuntime';

/**
 * AgentLoop v0 — a pure command-emitting state machine for one agent turn.
 *
 * The reducer never performs effects. Every observable step is an input
 * event (model result, tool outcome, approval decision, cancel) and every
 * required action is an output command (`request_round`, `execute_tool`)
 * that a thin driver executes against `LocalRuntime.completeV2` and the
 * native tool bridge. This keeps the whole safety policy testable without
 * any simulator, network, or file system.
 */

export const MAX_AGENT_ROUNDS = 8;

export type AgentToolAccess =
  | 'auto'
  | 'conversation_confirm'
  | 'confirm_once';

const AUTO_TOOLS: ReadonlySet<string> = new Set([
  'list_dir',
  'read_file',
  'git_status',
]);
const CONVERSATION_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'git_commit',
]);

/** Fail-safe classification: anything unknown requires confirmation once. */
export function agentToolAccess(name: string): AgentToolAccess {
  if (AUTO_TOOLS.has(name)) return 'auto';
  if (CONVERSATION_TOOLS.has(name)) return 'conversation_confirm';
  return 'confirm_once';
}

export type AgentLoopPhase =
  | 'awaiting_model'
  | 'awaiting_approval'
  | 'executing_tool'
  | 'done'
  | 'cancelled'
  | 'failed';

export type AgentCallRef = {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
};

export type AgentTraceRow = {
  readonly callId: string;
  readonly name: string;
  readonly arguments: string;
  readonly approved?: boolean;
  readonly ok?: boolean;
  readonly outputDigest?: string;
  readonly blocked?: string;
  readonly detail?: string;
};

export type AgentFeedbackRow = {
  callId: string;
  name: string;
  arguments: string;
  ok: boolean;
  outputDigest?: string;
  blocked?: string;
};

export type AgentLoopFailure = {
  code: string;
  detail?: string;
};

export type AgentLoopState = {
  readonly phase: AgentLoopPhase;
  readonly round: number;
  readonly maxRounds: number;
  readonly baseHistory: readonly CompletionMessage[];
  readonly tools: readonly unknown[];
  readonly pendingCalls: readonly AgentCallRef[];
  readonly currentCallId: string | null;
  readonly traces: readonly AgentTraceRow[];
  readonly feedbackRows: readonly AgentFeedbackRow[];
  readonly finalText: string | null;
  readonly exhausted: boolean;
  readonly failure: AgentLoopFailure | null;
  /** Tool names the user has allowed for the rest of this conversation. */
  readonly conversationAllowed: readonly string[];
  /** Ids of gated calls the user approved within this batch. */
  readonly approvedCallIds: readonly string[];
};

export type AgentLoopCommand =
  | {
      kind: 'request_round';
      round: number;
      baseHistory: readonly CompletionMessage[];
      feedbackRows: readonly AgentFeedbackRow[];
      tools: readonly unknown[];
    }
  | {
      kind: 'execute_tool';
      round: number;
      call: AgentCallRef;
    };

export type AgentLoopEvent =
  | {
      kind: 'started';
      history: readonly CompletionMessage[];
      tools: readonly unknown[];
    }
  | { kind: 'model_result'; text: string; toolCalls: readonly AgentCallRef[] }
  | { kind: 'model_failed'; message: string }
  | { kind: 'approval_decision'; approved: boolean }
  | {
      kind: 'tool_outcome';
      callId: string;
      ok: boolean;
      outputDigest?: string;
      detail?: string;
    }
  | { kind: 'cancel' };

export type AgentLoopOutcome = {
  state: AgentLoopState | null;
  commands: readonly AgentLoopCommand[];
};

const LIVE_PHASES: ReadonlySet<AgentLoopPhase> = new Set([
  'awaiting_model',
  'awaiting_approval',
  'executing_tool',
]);
function isLive(state: AgentLoopState): boolean {
  return LIVE_PHASES.has(state.phase);
}

function unchanged(
  state: AgentLoopState,
): AgentLoopOutcome {
  return { state, commands: [] };
}

function freshStarted(history: readonly CompletionMessage[], tools: readonly unknown[]): AgentLoopState {
  return {
    phase: 'awaiting_model',
    round: 0,
    maxRounds: MAX_AGENT_ROUNDS,
    baseHistory: history,
    tools,
    pendingCalls: [],
    currentCallId: null,
    traces: [],
    feedbackRows: [],
    finalText: null,
    exhausted: false,
    failure: null,
    conversationAllowed: [],
    approvedCallIds: [],
  };
}

/** Effective classification for a tool against the current loop state. */
function gateFor(state: AgentLoopState, name: string): AgentToolAccess {
  const access = agentToolAccess(name);
  if (access === 'conversation_confirm' &&
      state.conversationAllowed.includes(name)) {
    return 'auto';
  }
  return access;
}

/**
 * Decide what happens after the pending queue changes. A batch that contains
 * any gated call is frozen until that call is approved — read-only calls in
 * front of it wait their turn behind the confirmation.
 */
function scheduleNext(
  state: AgentLoopState,
): AgentLoopOutcome {
  const [head] = state.pendingCalls;
  if (head === undefined) {
    const advanced: AgentLoopState = {
      ...state,
      phase: 'awaiting_model',
      round: state.round + 1,
    };
    return {
      state: advanced,
      commands: [
        {
          kind: 'request_round',
          round: advanced.round,
          baseHistory: advanced.baseHistory,
          feedbackRows: advanced.feedbackRows,
          tools: advanced.tools,
        },
      ],
    };
  }
  const firstGated = state.pendingCalls.find(
    call => gateFor(state, call.name) !== 'auto' &&
      !state.approvedCallIds.includes(call.id),
  );
  if (firstGated !== undefined) {
    return {
      state: {
        ...state,
        phase: 'awaiting_approval',
        currentCallId: firstGated.id,
      },
      commands: [],
    };
  }
  return {
    state: { ...state, phase: 'executing_tool', currentCallId: head.id },
    commands: [
      { kind: 'execute_tool', round: state.round + 1, call: head },
    ],
  };
}

export function agentLoopReduce(
  state: AgentLoopState | null,
  event: AgentLoopEvent,
): AgentLoopOutcome {
  if (event.kind === 'started') {
    // Only a fresh loop can start; drivers start a new turn with a new
    // reducer instance.
    if (state !== null) return unchanged(state);
    const fresh = freshStarted(event.history, event.tools);
    return {
      state: fresh,
      commands: [
        {
          kind: 'request_round',
          round: 0,
          baseHistory: fresh.baseHistory,
          feedbackRows: [],
          tools: fresh.tools,
        },
      ],
    };
  }

  if (state === null) return { state: null, commands: [] };

  switch (event.kind) {
    case 'model_result': {
      if (state.phase !== 'awaiting_model' || !isLive(state)) {
        return unchanged(state);
      }
      if (event.toolCalls.length === 0) {
        if (event.text.trim().length === 0) {
          return {
            state: {
              ...state,
              phase: 'failed',
              failure: { code: 'E_AGENT_EMPTY_RESPONSE' },
            },
            commands: [],
          };
        }
        return {
          state: {
            ...state,
            phase: 'done',
            finalText: event.text,
          },
          commands: [],
        };
      }
      if (state.round >= state.maxRounds) {
        // Budget exhausted: end honestly instead of silently continuing.
        return {
          state: {
            ...state,
            phase: 'done',
            exhausted: true,
            finalText: event.text.trim().length > 0 ? event.text : null,
          },
          commands: [],
        };
      }
      const parked: AgentLoopState = {
        ...state,
        pendingCalls: event.toolCalls,
        currentCallId: null,
      };
      return scheduleNext(parked);
    }

    case 'model_failed': {
      if (!isLive(state)) return unchanged(state);
      return {
        state: {
          ...state,
          phase: 'failed',
          failure: { code: event.message || 'E_AGENT_MODEL_FAILED' },
        },
        commands: [],
      };
    }

    case 'approval_decision': {
      if (state.phase !== 'awaiting_approval') return unchanged(state);
      const approved = state.currentCallId;
      if (approved === null) return unchanged(state);
      const call = state.pendingCalls.find(c => c.id === approved);
      if (call === undefined) return unchanged(state);

      const trace: AgentTraceRow = event.approved
        ? { callId: call.id, name: call.name, arguments: call.arguments, approved: true }
        : {
            callId: call.id,
            name: call.name,
            arguments: call.arguments,
            approved: false,
            ok: false,
            blocked: 'denied_by_user',
          };
      const withTrace: AgentLoopState = {
        ...state,
        traces: [...state.traces, trace],
      };
      if (!event.approved) {
        const deniedRow: AgentFeedbackRow = {
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
          ok: false,
          blocked: 'denied_by_user',
        };
        const partial: AgentLoopState = {
          ...withTrace,
          feedbackRows: [...withTrace.feedbackRows, deniedRow],
        };
        return scheduleNext({
          ...partial,
          pendingCalls: state.pendingCalls.filter(c => c.id !== call.id),
        });
      }
      // Approved: mark the call, allow its family for the conversation when
      // applicable, and resume driving the queue from the head.
      const allowed =
        agentToolAccess(call.name) === 'conversation_confirm'
          ? [...withTrace.conversationAllowed, call.name]
          : withTrace.conversationAllowed;
      const resuming: AgentLoopState = {
        ...withTrace,
        conversationAllowed: allowed,
        approvedCallIds: [...withTrace.approvedCallIds, call.id],
        currentCallId: null,
      };
      return scheduleNext(resuming);
    }

    case 'tool_outcome': {
      if (state.phase !== 'executing_tool') return unchanged(state);
      if (state.currentCallId !== event.callId) return unchanged(state);
      const call = state.pendingCalls.find(c => c.id === event.callId);
      if (call === undefined) return unchanged(state);

      if (!event.ok) {
        return {
          state: {
            ...state,
            phase: 'failed',
            failure: {
              code: event.detail || 'E_AGENT_TOOL_FAILED',
            },
            traces: [
              ...state.traces,
              {
                callId: event.callId,
                name: call.name,
                arguments: call.arguments,
                ok: false,
                detail: event.detail,
              },
            ],
          },
          commands: [],
        };
      }
      const outcomeRow: AgentFeedbackRow = {
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
        ok: true,
        outputDigest: event.outputDigest,
      };
      const settled: AgentLoopState = {
        ...state,
        pendingCalls: state.pendingCalls.filter(c => c.id !== call.id),
        currentCallId: null,
        traces: [
          ...state.traces,
          {
            callId: call.id,
            name: call.name,
            arguments: call.arguments,
            approved: true,
            ok: true,
            outputDigest: event.outputDigest,
          },
        ],
        feedbackRows: [...state.feedbackRows, outcomeRow],
      };
      return scheduleNext(settled);
    }

    case 'cancel': {
      if (!isLive(state)) return unchanged(state);
      return {
        state: { ...state, phase: 'cancelled', currentCallId: null },
        commands: [{ kind: 'aborted_transport' } as never].filter(() => false),
      };
    }

    default:
      return unchanged(state);
  }
}

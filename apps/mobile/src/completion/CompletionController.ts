import type {
  CompleteRoundV2Request,
  CompleteRoundV2Result,
  CompleteRoundV3Request,
  CompleteRoundV3Result,
  CompletionVisibleMessageV2,
} from './types';
import type { SessionDurabilityResult } from './SessionPersistence';
import {
  ATTEMPT_FAILURE_CODES,
  type AttemptFailureCode,
  type ChatAttachment,
  type ChatStore,
  type CompletionRoundReceiptV1,
  type PreparedTurnTransaction,
  type TurnAttemptV1,
} from '../state';

export type CompletionControllerPhase =
  | 'idle'
  | 'preparing'
  | 'persistence_pending'
  | 'starting'
  | 'sending'
  | 'cancelling'
  | 'finalizing'
  | 'retryable'
  | 'resume_available'
  | 'commit_pending'
  | 'blocked';

export type CompletionControllerState = {
  readonly phase: CompletionControllerPhase;
  readonly epoch: number;
  readonly conversationId: string | null;
  readonly turnId: string | null;
  readonly attemptId: string | null;
  readonly roundId: string | null;
  readonly transportSchemaVersion: 2 | 3 | null;
  readonly failureCode: AttemptFailureCode | null;
};

export type CompletionControllerInput = {
  readonly conversationId: string;
  readonly text: string;
  readonly attachments: readonly ChatAttachment[];
  readonly sendWithoutProjectContext?: boolean;
};

export type CompletionControllerEvents = {
  readonly onPreparedDurable?: (prepared: {
    readonly conversationId: string;
    readonly turnId: string;
    readonly attemptId: string;
    readonly userMessageId: string;
  }) => void;
  readonly onCommitted?: (completed: {
    readonly conversationId: string;
    readonly turnId: string;
    readonly attemptId: string;
  }) => void;
};

export type CompletionControllerOutcome = {
  readonly status:
    | 'completed'
    | 'blocked'
    | 'persistence_pending'
    | 'retryable'
    | 'commit_pending'
    | 'cancelled';
  readonly conversationId: string | null;
  readonly turnId: string | null;
  readonly attemptId: string | null;
  readonly code: AttemptFailureCode | null;
};

export type CompletionControllerDependencies = {
  readonly chat: ChatStore;
  readonly persistCurrent: () => Promise<SessionDurabilityResult>;
  readonly completeRoundV2: (
    request: CompleteRoundV2Request,
  ) => Promise<CompleteRoundV2Result>;
  readonly completeRoundV3: (
    request: CompleteRoundV3Request,
  ) => Promise<CompleteRoundV3Result>;
  readonly cancelRoundV2: (roundId: string) => Promise<unknown>;
  readonly cancelRoundV3: (roundId: string) => Promise<unknown>;
  readonly createRoundId: () => string;
};

export type CompletionController = {
  getState(): CompletionControllerState;
  subscribe(listener: (state: CompletionControllerState) => void): () => void;
  send(
    input: CompletionControllerInput,
    events?: CompletionControllerEvents,
  ): Promise<CompletionControllerOutcome>;
  retry(
    conversationId: string,
    attemptId: string,
    events?: CompletionControllerEvents,
  ): Promise<CompletionControllerOutcome>;
  resume(
    conversationId: string,
    attemptId: string,
    events?: CompletionControllerEvents,
  ): Promise<CompletionControllerOutcome>;
  retryPersistence(): Promise<CompletionControllerOutcome>;
  retryCommit(): Promise<CompletionControllerOutcome>;
  cancel(): Promise<void>;
  beforeConversationChange(conversationId: string): Promise<boolean>;
  beforeConversationDelete(conversationId: string): Promise<boolean>;
  reconcileHydrated(conversationId: string): CompletionControllerState;
};

type ActiveRun = {
  readonly epoch: number;
  readonly conversationId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly roundId: string;
  readonly transportSchemaVersion: 2 | 3;
  readonly events: CompletionControllerEvents;
};

type PendingPreparation = {
  readonly epoch: number;
  readonly transaction: PreparedTurnTransaction;
  readonly conversationId: string;
  readonly events: CompletionControllerEvents;
  readonly durability: 'session_only' | 'unknown' | null;
};

type PendingCommit = {
  readonly conversationId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly events: CompletionControllerEvents;
};

type PendingTerminalPersistence = {
  readonly conversationId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly successStatus: 'retryable' | 'cancelled';
  readonly failureCode: AttemptFailureCode | null;
  readonly preparedNotification: {
    readonly events: CompletionControllerEvents;
    readonly transaction: PreparedTurnTransaction;
  } | null;
};

const FAILURE_CODES: ReadonlySet<string> = new Set(ATTEMPT_FAILURE_CODES);

const IDLE: CompletionControllerState = {
  phase: 'idle',
  epoch: 0,
  conversationId: null,
  turnId: null,
  attemptId: null,
  roundId: null,
  transportSchemaVersion: null,
  failureCode: null,
};

function errorCode(error: unknown): AttemptFailureCode {
  try {
    if (typeof error !== 'object' || error === null) {
      return 'E_COMPLETION_NATIVE';
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (
      descriptor !== undefined &&
      Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
      typeof descriptor.value === 'string' &&
      FAILURE_CODES.has(descriptor.value)
    ) {
      return descriptor.value as AttemptFailureCode;
    }
  } catch {
    // Hostile thrown values collapse to the stable native code.
  }
  return 'E_COMPLETION_NATIVE';
}

function visibleHistory(
  chat: ChatStore,
  conversationId: string,
  attempt: TurnAttemptV1,
): readonly CompletionVisibleMessageV2[] | null {
  const conversation = chat.getState().conversations[conversationId];
  if (conversation === undefined) return null;
  const messages = new Map(
    conversation.messages.map(message => [message.id, message] as const),
  );
  const projected: CompletionVisibleMessageV2[] = [];
  for (const messageId of attempt.visibleMessageIds) {
    const message = messages.get(messageId);
    if (message === undefined) return null;
    projected.push({
      role: message.role,
      content: message.text,
      attachments: message.attachments.map(attachment => ({
        schema_version: attachment.schema_version,
        id: attachment.id,
        kind: attachment.kind,
        name: attachment.name,
        mime_type: attachment.mime_type,
        size: attachment.size,
      })),
    });
  }
  return projected;
}

function receipt(
  result: CompleteRoundV2Result | CompleteRoundV3Result,
): CompletionRoundReceiptV1 {
  return {
    schemaVersion: 1,
    transportSchemaVersion: result.schema_version,
    turnId: result.turn_id,
    attemptId: result.attempt_id,
    roundId: result.round_id,
    roundIndex: result.round_index,
    providerRequestId: result.provider_request_id,
    providerResponseId: result.provider_response_id,
    requestedModel: result.requested_model,
    model: result.model,
    thinkingMode: result.thinking_mode,
    finishReason: result.finish_reason,
    latencyMs: result.latency_ms,
    visibleHistorySha256: result.visible_history_sha256,
    modelInputSha256: result.model_input_sha256,
    requestBodySha256: result.request_body_sha256,
    projectContextReceipt: result.project_context_receipt,
  };
}

function outcome(
  status: CompletionControllerOutcome['status'],
  state: CompletionControllerState,
): CompletionControllerOutcome {
  return {
    status,
    conversationId: state.conversationId,
    turnId: state.turnId,
    attemptId: state.attemptId,
    code: state.failureCode,
  };
}

export function createCompletionController(
  dependencies: CompletionControllerDependencies,
): CompletionController {
  let state = IDLE;
  let epoch = 0;
  let active: ActiveRun | null = null;
  let pendingPreparation: PendingPreparation | null = null;
  let pendingCommit: PendingCommit | null = null;
  let pendingTerminal: PendingTerminalPersistence | null = null;
  let retryPersistenceInFlight = false;
  let retryCommitInFlight = false;
  let lastCancellationCommitted = true;
  const listeners = new Set<(next: CompletionControllerState) => void>();

  const publish = (next: Omit<CompletionControllerState, 'epoch'>) => {
    state = { ...next, epoch };
    listeners.forEach(listener => {
      try {
        listener(state);
      } catch {
        // UI listeners cannot affect controller ownership.
      }
    });
  };

  const stateFor = (
    phase: CompletionControllerPhase,
    identity: {
      conversationId?: string | null;
      turnId?: string | null;
      attemptId?: string | null;
      roundId?: string | null;
      transportSchemaVersion?: 2 | 3 | null;
      failureCode?: AttemptFailureCode | null;
    } = {},
  ): Omit<CompletionControllerState, 'epoch'> => ({
    phase,
    conversationId: identity.conversationId ?? null,
    turnId: identity.turnId ?? null,
    attemptId: identity.attemptId ?? null,
    roundId: identity.roundId ?? null,
    transportSchemaVersion: identity.transportSchemaVersion ?? null,
    failureCode: identity.failureCode ?? null,
  });

  const safePersist = async (): Promise<SessionDurabilityResult> => {
    try {
      const result = await dependencies.persistCurrent();
      return result?.status === 'committed' ||
        result?.status === 'session_only' ||
        result?.status === 'not_committed' ||
        result?.status === 'unknown'
        ? result
        : { status: 'unknown' };
    } catch {
      return { status: 'unknown' };
    }
  };

  const busyOutcome = (
    conversationId: string | null = state.conversationId,
    attemptId: string | null = state.attemptId,
  ): CompletionControllerOutcome => ({
    status: 'blocked',
    conversationId,
    turnId: state.turnId,
    attemptId,
    code: 'E_COMPLETION_BUSY',
  });

  const destructiveJournalActive = (): boolean => {
    try {
      return (
        dependencies.chat.getState().projectContextDestructiveTransition !==
        null
      );
    } catch {
      return true;
    }
  };

  const notifyPrepared = (
    events: CompletionControllerEvents,
    transaction: PreparedTurnTransaction,
    conversationId: string,
  ) => {
    try {
      events.onPreparedDurable?.({
        conversationId,
        turnId: transaction.turnId,
        attemptId: transaction.attemptId,
        userMessageId: transaction.userMessageId,
      });
    } catch {
      // UI ownership notification cannot change the transaction.
    }
  };

  const notifyCommitted = (pending: PendingCommit) => {
    try {
      pending.events.onCommitted?.({
        conversationId: pending.conversationId,
        turnId: pending.turnId,
        attemptId: pending.attemptId,
      });
    } catch {
      // Proof/UI callbacks cannot affect durable state.
    }
  };

  const settleTerminalPersistence = (
    pending: PendingTerminalPersistence,
    durability: SessionDurabilityResult,
  ): CompletionControllerOutcome => {
    if (durability.status !== 'committed') {
      pendingTerminal = pending;
      if (pending.successStatus === 'cancelled') {
        lastCancellationCommitted = false;
      }
      publish(
        stateFor('persistence_pending', {
          conversationId: pending.conversationId,
          turnId: pending.turnId,
          attemptId: pending.attemptId,
          failureCode: 'E_ATTEMPT_PERSISTENCE',
        }),
      );
      return outcome('persistence_pending', state);
    }
    if (pendingTerminal === pending) pendingTerminal = null;
    if (pending.preparedNotification !== null) {
      notifyPrepared(
        pending.preparedNotification.events,
        pending.preparedNotification.transaction,
        pending.conversationId,
      );
    }
    if (pending.successStatus === 'cancelled') {
      lastCancellationCommitted = true;
    }
    publish(
      stateFor('retryable', {
        conversationId: pending.conversationId,
        turnId: pending.turnId,
        attemptId: pending.attemptId,
        failureCode: pending.failureCode,
      }),
    );
    return {
      status: pending.successStatus,
      conversationId: pending.conversationId,
      turnId: pending.turnId,
      attemptId: pending.attemptId,
      code:
        pending.successStatus === 'retryable' ? pending.failureCode : null,
    };
  };

  const persistTerminal = async (
    pending: PendingTerminalPersistence,
  ): Promise<CompletionControllerOutcome> => {
    pendingTerminal = pending;
    publish(
      stateFor('finalizing', {
        conversationId: pending.conversationId,
        turnId: pending.turnId,
        attemptId: pending.attemptId,
        failureCode: pending.failureCode,
      }),
    );
    return settleTerminalPersistence(pending, await safePersist());
  };

  const persistFailure = async (
    conversationId: string,
    attemptId: string,
    code: AttemptFailureCode,
  ) => {
    if (!dependencies.chat.failAttempt(conversationId, attemptId, code)) {
      publish(
        stateFor('blocked', {
          conversationId,
          attemptId,
          failureCode: 'E_COMPLETION_RESULT_CORRELATION',
        }),
      );
      return outcome('blocked', state);
    }
    const failedAttempt = dependencies.chat
      .getState()
      .conversations[conversationId]?.attempts.find(
        attempt => attempt.attemptId === attemptId,
      );
    if (failedAttempt === undefined) {
      publish(
        stateFor('blocked', {
          conversationId,
          attemptId,
          failureCode: 'E_COMPLETION_RESULT_CORRELATION',
        }),
      );
      return outcome('blocked', state);
    }
    return await persistTerminal({
      conversationId,
      turnId: failedAttempt.turnId,
      attemptId,
      successStatus: 'retryable',
      failureCode: code,
      preparedNotification: null,
    });
  };

  const runPrepared = async (
    conversationId: string,
    turnId: string,
    attemptId: string,
    events: CompletionControllerEvents,
    runEpoch: number,
  ): Promise<CompletionControllerOutcome> => {
    const conversation = dependencies.chat.getState().conversations[conversationId];
    const prepared = conversation?.attempts.find(
      candidate => candidate.attemptId === attemptId,
    );
    if (prepared === undefined || runEpoch !== epoch) {
      return outcome('cancelled', state);
    }
    const roundId = dependencies.createRoundId();
    const roundIndex = prepared.rounds.length;
    const transportSchemaVersion =
      prepared.contextDisposition === 'verified' ? 3 : 2;
    publish(
      stateFor('starting', {
        conversationId,
        turnId,
        attemptId,
        roundId,
        transportSchemaVersion,
      }),
    );
    if (
      !dependencies.chat.startAttemptRound(
        conversationId,
        attemptId,
        roundId,
        roundIndex,
      )
    ) {
      return await persistFailure(
        conversationId,
        attemptId,
        prepared.contextDisposition === 'verified'
          ? 'E_ATTEMPT_CONTEXT_REQUIRED'
          : 'E_COMPLETION_RESULT_CORRELATION',
      );
    }
    active = {
      epoch: runEpoch,
      conversationId,
      turnId,
      attemptId,
      roundId,
      transportSchemaVersion,
      events,
    };
    const sendingDurability = await safePersist();
    if (runEpoch !== epoch) return outcome('cancelled', state);
    if (sendingDurability.status !== 'committed') {
      active = null;
      return await persistFailure(
        conversationId,
        attemptId,
        'E_ATTEMPT_PERSISTENCE',
      );
    }
    const sendingConversation =
      dependencies.chat.getState().conversations[conversationId];
    const attempt = sendingConversation?.attempts.find(
      candidate => candidate.attemptId === attemptId,
    );
    const history =
      attempt === undefined
        ? null
        : visibleHistory(dependencies.chat, conversationId, attempt);
    if (
      attempt === undefined ||
      history === null ||
      attempt.activeRound?.roundId !== roundId
    ) {
      active = null;
      return await persistFailure(
        conversationId,
        attemptId,
        'E_COMPLETION_RESULT_CORRELATION',
      );
    }
    publish(
      stateFor('sending', {
        conversationId,
        turnId,
        attemptId,
        roundId,
        transportSchemaVersion,
      }),
    );
    let result: CompleteRoundV2Result | CompleteRoundV3Result;
    try {
      if (transportSchemaVersion === 3) {
        const binding = attempt.projectContext;
        if (binding === null) {
          throw { code: 'E_COMPLETION_CONTEXT_INVALID' };
        }
        result = await dependencies.completeRoundV3({
          schemaVersion: 3,
          turnId,
          attemptId,
          roundId,
          roundIndex,
          model: attempt.modelId,
          thinkingMode: attempt.thinkingMode,
          visibleHistory: history,
          roundTranscript: [],
          tools: [],
          projectContext: {
            schemaVersion: 1,
            snapshotId: binding.snapshotId,
            consentReceiptId: binding.consentReceiptId,
            conversationId: binding.runtimeContextId,
            projectId: binding.projectId,
            provider: binding.provider,
            policy: binding.policy,
          },
        });
      } else {
        result = await dependencies.completeRoundV2({
          schemaVersion: 2,
          turnId,
          attemptId,
          roundId,
          roundIndex,
          model: attempt.modelId,
          thinkingMode: attempt.thinkingMode,
          visibleHistory: history,
          roundTranscript: [],
          tools: [],
          projectContext: null,
        });
      }
    } catch (error) {
      if (runEpoch !== epoch) return outcome('cancelled', state);
      active = null;
      return await persistFailure(conversationId, attemptId, errorCode(error));
    }
    if (runEpoch !== epoch) return outcome('cancelled', state);
    active = null;
    if (!dependencies.chat.recordAttemptRound(conversationId, attemptId, receipt(result))) {
      return await persistFailure(
        conversationId,
        attemptId,
        'E_COMPLETION_RESULT_CORRELATION',
      );
    }
    if (
      result.finish_reason === 'tool_calls' ||
      result.finish_reason === 'content_filter' ||
      result.tool_calls.length > 0
    ) {
      return await persistFailure(
        conversationId,
        attemptId,
        'E_COMPLETION_FINISH_RELATION',
      );
    }
    if (result.text.trim().length === 0) {
      return await persistFailure(
        conversationId,
        attemptId,
        'E_COMPLETION_EMPTY_RESPONSE',
      );
    }
    const assistantId = dependencies.chat.completeAttempt(
      conversationId,
      attemptId,
      result.text,
      {
        metadata: {
          modelId: result.model,
          latencyMs: result.latency_ms,
          finishReason: result.finish_reason,
          ...(result.reasoning.length === 0
            ? {}
            : { reasoning: result.reasoning }),
        },
      },
    );
    if (assistantId === null) {
      return await persistFailure(
        conversationId,
        attemptId,
        'E_COMPLETION_RESULT_CORRELATION',
      );
    }
    pendingCommit = { conversationId, turnId, attemptId, events };
    publish(
      stateFor('finalizing', {
        conversationId,
        turnId,
        attemptId,
      }),
    );
    const finalDurability = await safePersist();
    if (runEpoch !== epoch) return outcome('cancelled', state);
    if (finalDurability.status !== 'committed') {
      publish(
        stateFor('commit_pending', {
          conversationId,
          turnId,
          attemptId,
          failureCode: 'E_ATTEMPT_PERSISTENCE',
        }),
      );
      return outcome('commit_pending', state);
    }
    const committed = pendingCommit;
    pendingCommit = null;
    publish(stateFor('idle'));
    if (committed !== null) notifyCommitted(committed);
    return {
      status: 'completed',
      conversationId,
      turnId,
      attemptId,
      code: null,
    };
  };

  const continuePreparation = async (
    transaction: PreparedTurnTransaction,
    conversationId: string,
    events: CompletionControllerEvents,
    runEpoch: number,
    durability: SessionDurabilityResult,
  ): Promise<CompletionControllerOutcome> => {
    if (runEpoch !== epoch) {
      pendingPreparation = null;
      if (durability.status === 'not_committed') {
        transaction.rollback();
        lastCancellationCommitted = true;
        publish(stateFor('idle'));
        return {
          status: 'cancelled',
          conversationId,
          turnId: transaction.turnId,
          attemptId: transaction.attemptId,
          code: null,
        };
      }
      transaction.commit();
      const preparedWasDurable = durability.status === 'committed';
      if (preparedWasDurable) {
        notifyPrepared(events, transaction, conversationId);
      }
      if (
        !dependencies.chat.cancelAttempt(
          conversationId,
          transaction.attemptId,
        )
      ) {
        lastCancellationCommitted = false;
        publish(
          stateFor('blocked', {
            conversationId,
            turnId: transaction.turnId,
            attemptId: transaction.attemptId,
            failureCode: 'E_COMPLETION_RESULT_CORRELATION',
          }),
        );
        return outcome('blocked', state);
      }
      return await persistTerminal({
        conversationId,
        turnId: transaction.turnId,
        attemptId: transaction.attemptId,
        successStatus: 'cancelled',
        failureCode: null,
        preparedNotification: preparedWasDurable
          ? null
          : { events, transaction },
      });
    }
    if (durability.status === 'not_committed') {
      pendingPreparation = null;
      transaction.rollback();
      publish(
        stateFor('blocked', {
          conversationId,
          turnId: transaction.turnId,
          attemptId: transaction.attemptId,
          failureCode: 'E_ATTEMPT_PERSISTENCE',
        }),
      );
      return outcome('blocked', state);
    }
    if (durability.status !== 'committed') {
      pendingPreparation = {
        epoch: runEpoch,
        transaction,
        conversationId,
        events,
        durability: durability.status,
      };
      publish(
        stateFor('persistence_pending', {
          conversationId,
          turnId: transaction.turnId,
          attemptId: transaction.attemptId,
          failureCode: 'E_ATTEMPT_PERSISTENCE',
        }),
      );
      return outcome('persistence_pending', state);
    }
    if (!transaction.commit()) {
      publish(
        stateFor('blocked', {
          conversationId,
          turnId: transaction.turnId,
          attemptId: transaction.attemptId,
          failureCode: 'E_ATTEMPT_PERSISTENCE',
        }),
      );
      return outcome('blocked', state);
    }
    pendingPreparation = null;
    notifyPrepared(events, transaction, conversationId);
    return await runPrepared(
      conversationId,
      transaction.turnId,
      transaction.attemptId,
      events,
      runEpoch,
    );
  };

  const beginTransaction = async (
    transaction: PreparedTurnTransaction,
    conversationId: string,
    events: CompletionControllerEvents,
    runEpoch: number,
  ) => {
    pendingPreparation = {
      epoch: runEpoch,
      transaction,
      conversationId,
      events,
      durability: null,
    };
    publish(
      stateFor('preparing', {
        conversationId,
        turnId: transaction.turnId,
        attemptId: transaction.attemptId,
      }),
    );
    return await continuePreparation(
      transaction,
      conversationId,
      events,
      runEpoch,
      await safePersist(),
    );
  };

  const controller: CompletionController = {
    getState: () => state,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: async (input, events = {}) => {
      if (destructiveJournalActive()) {
        return busyOutcome();
      }
      if (
        active !== null ||
        pendingPreparation !== null ||
        pendingCommit !== null ||
        pendingTerminal !== null ||
        retryPersistenceInFlight ||
        retryCommitInFlight ||
        state.phase === 'preparing' ||
        state.phase === 'starting' ||
        state.phase === 'sending' ||
        state.phase === 'cancelling' ||
        state.phase === 'resume_available'
      ) {
        return busyOutcome(input.conversationId, null);
      }
      epoch += 1;
      const runEpoch = epoch;
      const transaction = dependencies.chat.prepareTurnAttempt(
        input.conversationId,
        input.text,
        {
          attachments: input.attachments,
          sendWithoutProjectContext:
            input.sendWithoutProjectContext === true,
        },
      );
      if (transaction === null) {
        const conversation =
          dependencies.chat.getState().conversations[input.conversationId];
        const code: AttemptFailureCode =
          conversation?.projectId !== null &&
          input.sendWithoutProjectContext !== true
            ? 'E_ATTEMPT_CONTEXT_REQUIRED'
            : 'E_COMPLETION_HISTORY';
        publish(
          stateFor('blocked', {
            conversationId: input.conversationId,
            failureCode: code,
          }),
        );
        return outcome('blocked', state);
      }
      return await beginTransaction(
        transaction,
        input.conversationId,
        events,
        runEpoch,
      );
    },
    retry: async (conversationId, attemptId, events = {}) => {
      if (destructiveJournalActive()) {
        return busyOutcome(conversationId, attemptId);
      }
      if (
        active !== null ||
        pendingPreparation !== null ||
        pendingCommit !== null ||
        pendingTerminal !== null ||
        retryPersistenceInFlight ||
        retryCommitInFlight ||
        state.phase === 'cancelling'
      ) {
        return busyOutcome(conversationId, attemptId);
      }
      epoch += 1;
      const transaction = dependencies.chat.retryAttempt(
        conversationId,
        attemptId,
      );
      if (transaction === null) {
        publish(
          stateFor('blocked', {
            conversationId,
            attemptId,
            failureCode: 'E_COMPLETION_RESULT_CORRELATION',
          }),
        );
        return outcome('blocked', state);
      }
      return await beginTransaction(
        transaction,
        conversationId,
        events,
        epoch,
      );
    },
    resume: async (conversationId, attemptId, events = {}) => {
      if (destructiveJournalActive()) {
        return busyOutcome(conversationId, attemptId);
      }
      if (
        active !== null ||
        pendingPreparation !== null ||
        pendingCommit !== null ||
        pendingTerminal !== null ||
        retryPersistenceInFlight ||
        retryCommitInFlight ||
        state.phase === 'cancelling'
      ) {
        return busyOutcome(conversationId, attemptId);
      }
      const conversation = dependencies.chat.getState().conversations[conversationId];
      const attempt = conversation?.attempts.find(item => item.attemptId === attemptId);
      if (
        attempt === undefined ||
        attempt.status !== 'prepared' ||
        attempt.rounds.length !== 0
      ) {
        publish(
          stateFor('blocked', {
            conversationId,
            attemptId,
            failureCode: 'E_COMPLETION_RESULT_CORRELATION',
          }),
        );
        return outcome('blocked', state);
      }
      epoch += 1;
      return await runPrepared(
        conversationId,
        attempt.turnId,
        attemptId,
        events,
        epoch,
      );
    },
    retryPersistence: async () => {
      if (destructiveJournalActive()) return busyOutcome();
      if (state.phase === 'cancelling' || state.phase === 'finalizing') {
        return busyOutcome();
      }
      const pending = pendingPreparation;
      const terminal = pendingTerminal;
      if (pending === null && terminal === null) return outcome('blocked', state);
      if (retryPersistenceInFlight) return busyOutcome();
      retryPersistenceInFlight = true;
      try {
        if (terminal !== null) {
          return settleTerminalPersistence(terminal, await safePersist());
        }
        if (pending === null) return outcome('blocked', state);
        return await continuePreparation(
          pending.transaction,
          pending.conversationId,
          pending.events,
          pending.epoch,
          await safePersist(),
        );
      } finally {
        retryPersistenceInFlight = false;
      }
    },
    retryCommit: async () => {
      if (destructiveJournalActive()) return busyOutcome();
      if (state.phase === 'finalizing') return busyOutcome();
      const pending = pendingCommit;
      if (pending === null) return outcome('blocked', state);
      if (retryCommitInFlight) return busyOutcome();
      retryCommitInFlight = true;
      try {
        const durability = await safePersist();
        if (durability.status !== 'committed') {
          return outcome('commit_pending', state);
        }
        pendingCommit = null;
        publish(stateFor('idle'));
        notifyCommitted(pending);
        return {
          status: 'completed',
          conversationId: pending.conversationId,
          turnId: pending.turnId,
          attemptId: pending.attemptId,
          code: null,
        };
      } finally {
        retryCommitInFlight = false;
      }
    },
    cancel: async () => {
      if (destructiveJournalActive()) return;
      if (
        pendingCommit !== null ||
        pendingTerminal !== null ||
        state.phase === 'cancelling'
      )
        return;
      epoch += 1;
      const cancelling = active;
      active = null;
      if (cancelling === null) {
        const pending = pendingPreparation;
        if (pending !== null) {
          if (pending.durability === null || retryPersistenceInFlight) {
            publish(
              stateFor('cancelling', {
                conversationId: pending.conversationId,
                turnId: pending.transaction.turnId,
                attemptId: pending.transaction.attemptId,
              }),
            );
            return;
          }
          pending.transaction.commit();
          pendingPreparation = null;
          const cancelled = dependencies.chat.cancelAttempt(
            pending.conversationId,
            pending.transaction.attemptId,
          );
          if (!cancelled) {
            lastCancellationCommitted = false;
            publish(
              stateFor('blocked', {
                conversationId: pending.conversationId,
                turnId: pending.transaction.turnId,
                attemptId: pending.transaction.attemptId,
                failureCode: 'E_COMPLETION_RESULT_CORRELATION',
              }),
            );
            return;
          }
          await persistTerminal({
            conversationId: pending.conversationId,
            turnId: pending.transaction.turnId,
            attemptId: pending.transaction.attemptId,
            successStatus: 'cancelled',
            failureCode: null,
            preparedNotification: {
              events: pending.events,
              transaction: pending.transaction,
            },
          });
          return;
        }
        lastCancellationCommitted = true;
        publish(stateFor('idle'));
        return;
      }
      publish(
        stateFor('cancelling', {
          conversationId: cancelling.conversationId,
          turnId: cancelling.turnId,
          attemptId: cancelling.attemptId,
          roundId: cancelling.roundId,
          transportSchemaVersion: cancelling.transportSchemaVersion,
        }),
      );
      try {
        if (cancelling.transportSchemaVersion === 3) {
          await dependencies.cancelRoundV3(cancelling.roundId);
        } else {
          await dependencies.cancelRoundV2(cancelling.roundId);
        }
      } catch {
        // Durable cancellation below remains authoritative.
      }
      const cancelled = dependencies.chat.cancelAttempt(
        cancelling.conversationId,
        cancelling.attemptId,
      );
      if (!cancelled) {
        lastCancellationCommitted = false;
        publish(
          stateFor('blocked', {
            conversationId: cancelling.conversationId,
            turnId: cancelling.turnId,
            attemptId: cancelling.attemptId,
            failureCode: 'E_COMPLETION_RESULT_CORRELATION',
          }),
        );
        return;
      }
      await persistTerminal({
        conversationId: cancelling.conversationId,
        turnId: cancelling.turnId,
        attemptId: cancelling.attemptId,
        successStatus: 'cancelled',
        failureCode: null,
        preparedNotification: null,
      });
    },
    beforeConversationChange: async conversationId => {
      if (destructiveJournalActive()) return false;
      if (
        state.phase === 'cancelling' &&
        state.conversationId === conversationId
      ) {
        return false;
      }
      if (
        pendingCommit?.conversationId === conversationId ||
        pendingPreparation?.conversationId === conversationId ||
        pendingTerminal?.conversationId === conversationId
      ) {
        return false;
      }
      if (active?.conversationId !== conversationId) return true;
      await controller.cancel();
      return lastCancellationCommitted;
    },
    beforeConversationDelete: async conversationId => {
      if (destructiveJournalActive()) return false;
      return await controller.beforeConversationChange(conversationId);
    },
    reconcileHydrated: conversationId => {
      if (destructiveJournalActive()) return state;
      if (
        active !== null ||
        pendingPreparation !== null ||
        pendingCommit !== null ||
        pendingTerminal !== null
      ) {
        return state;
      }
      const conversation = dependencies.chat.getState().conversations[conversationId];
      const turn = conversation?.turns.at(-1);
      const attemptId = turn?.attemptIds.at(-1);
      const attempt = conversation?.attempts.find(item => item.attemptId === attemptId);
      if (attempt?.status === 'prepared' && attempt.rounds.length === 0) {
        publish(
          stateFor('resume_available', {
            conversationId,
            turnId: attempt.turnId,
            attemptId: attempt.attemptId,
          }),
        );
      } else if (attempt?.status === 'failed' || attempt?.status === 'cancelled') {
        publish(
          stateFor('retryable', {
            conversationId,
            turnId: attempt.turnId,
            attemptId: attempt.attemptId,
            failureCode: attempt.failureCode,
          }),
        );
      } else {
        publish(stateFor('idle'));
      }
      return state;
    },
  };
  return controller;
}

import {
  LocalProjectContext,
  ProjectContextBridgeError,
} from '../native/LocalProjectContext';
import type { SessionDurabilityResult } from '../completion/SessionPersistence';
import {
  isCanonicalLifecycleId,
  isCanonicalTimestamp,
  isModelId,
  isProjectId,
  isSha256Digest,
  type ChatState,
  type ChatStore,
  type ModelId,
  type ProjectContextDestructiveAction,
  type ProjectContextDestructiveAdvanceScope,
  type ProjectContextDestructivePhase,
  type ProjectContextDestructiveTransaction,
  type ProjectContextDestructiveTransitionV1,
} from '../state';
import { canonicalizeDurableProjectContextState } from './persistence';
import {
  PROJECT_CONTEXT_BRIDGE_ERROR_CODES,
  PROJECT_CONTEXT_ERROR_CODES,
  type ProjectContextBridgeErrorCode,
  type ProjectContextState,
} from './types';

export type ProjectContextDestructiveToken = {
  readonly generation: number;
  readonly lifecycleId: string;
  readonly epoch: number;
  readonly action: ProjectContextDestructiveAction;
  readonly conversationId: string;
  readonly sourceProjectId: string;
  readonly sourceRuntimeContextId: string | null;
  readonly sourceModelId: ModelId;
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly consentReceiptId: string | null;
  readonly targetProjectId: string | null;
  readonly phase: ProjectContextDestructivePhase;
};

export type ProjectContextDestructiveBeginToken = {
  readonly expectedRootEpoch: number;
  readonly action: ProjectContextDestructiveAction;
  readonly conversationId: string;
  readonly sourceProjectId: string;
  readonly sourceRuntimeContextId: string | null;
  readonly sourceModelId: ModelId;
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly consentReceiptId: string | null;
  readonly expectedUpdatedAt: string;
  readonly targetProjectId: string | null;
};

export type ProjectContextLifecycleControllerPhase =
  | 'idle'
  | 'resuming'
  | 'intent_persistence_pending'
  | 'tombstone_persistence_pending'
  | 'cleanup_pending'
  | 'ready_persistence_pending'
  | 'ready_to_finalize'
  | 'finalize_persistence_pending'
  | 'blocked';

export type ProjectContextDestructiveErrorCode =
  | ProjectContextBridgeErrorCode
  | 'E_CONTEXT_TRANSITION_BUSY'
  | 'E_CONTEXT_TRANSITION_CONFLICT'
  | 'E_CONTEXT_TRANSITION_INVALID'
  | 'E_CONTEXT_TRANSITION_REFERENCED'
  | 'E_CONTEXT_TRANSITION_UNKNOWN'
  | 'E_CONTEXT_PERSISTENCE';

export type ProjectContextLifecycleControllerState = {
  readonly generation: number;
  readonly phase: ProjectContextLifecycleControllerPhase;
  readonly token: ProjectContextDestructiveToken | null;
  readonly failureCode: ProjectContextDestructiveErrorCode | null;
  readonly pendingPersistence:
    | null
    | 'intent'
    | 'tombstone'
    | 'ready_to_finalize'
    | 'finalize';
};

export type ProjectContextDestructiveBeginResult =
  | { readonly ok: true; readonly token: ProjectContextDestructiveBeginToken }
  | { readonly ok: false; readonly code: ProjectContextDestructiveErrorCode };

export type ProjectContextDestructiveOutcome =
  | {
      readonly status: 'completed';
      readonly action: ProjectContextDestructiveAction;
    }
  | { readonly status: 'blocked'; readonly code: ProjectContextDestructiveErrorCode }
  | { readonly status: 'persistence_pending'; readonly code: 'E_CONTEXT_PERSISTENCE' }
  | {
      readonly status: 'cleanup_pending';
      readonly code: ProjectContextDestructiveErrorCode;
    };

type NativeProjectContext = Pick<typeof LocalProjectContext, 'discard'>;

export type ProjectContextLifecycleControllerDependencies = {
  readonly chat: ChatStore;
  readonly native: NativeProjectContext;
  readonly persistCurrent: () => Promise<SessionDurabilityResult>;
  readonly createLifecycleId: () => string;
  readonly completionMutationBlocked: () => boolean;
  readonly projectContextMutationBlocked: () => boolean;
  readonly snapshotReferences: (
    conversationId: string,
    snapshotId: string,
  ) => readonly unknown[];
  readonly maximumPendingLifecycle: 1;
};

export type ProjectContextLifecycleController = {
  getState(): ProjectContextLifecycleControllerState;
  subscribe(
    listener: (state: ProjectContextLifecycleControllerState) => void,
  ): () => void;
  captureDestructiveBeginToken(
    conversationId: string,
    action: ProjectContextDestructiveAction,
    targetProjectId: string | null,
  ): ProjectContextDestructiveBeginResult;
  beginDestructiveTransition(
    expected: ProjectContextDestructiveBeginToken,
  ): Promise<ProjectContextDestructiveOutcome>;
  reconcileDestructiveTransition(): Promise<ProjectContextDestructiveOutcome>;
  getDestructiveToken(): ProjectContextDestructiveToken | null;
  retryDestructivePersistence(
    expected: ProjectContextDestructiveToken,
  ): Promise<ProjectContextDestructiveOutcome>;
  retryDestructiveCleanup(
    expected: ProjectContextDestructiveToken,
  ): Promise<ProjectContextDestructiveOutcome>;
  beforeConversationChange(conversationId: string): boolean;
  beforeConversationDelete(conversationId: string): boolean;
};

type PersistenceStage = NonNullable<
  ProjectContextLifecycleControllerState['pendingPersistence']
>;

type PendingPersistence = {
  readonly stage: PersistenceStage;
  readonly transaction: ProjectContextDestructiveTransaction | null;
  readonly action: ProjectContextDestructiveAction;
};

type FrozenLifecycleIdentity = {
  readonly lifecycleId: string;
  readonly epoch: number;
  readonly action: ProjectContextDestructiveAction;
  readonly conversationId: string;
  readonly sourceProjectId: string;
  readonly sourceRuntimeContextId: string | null;
  readonly sourceModelId: ModelId;
  readonly snapshotId: string;
  readonly snapshotSha256: string;
  readonly consentReceiptId: string | null;
  readonly targetProjectId: string | null;
  readonly createdAt: string;
};

const TRANSITION_KEYS = [
  'schemaVersion',
  'lifecycleId',
  'epoch',
  'action',
  'phase',
  'conversationId',
  'sourceProjectId',
  'sourceRuntimeContextId',
  'sourceModelId',
  'snapshotId',
  'snapshotSha256',
  'consentReceiptId',
  'targetProjectId',
  'createdAt',
  'updatedAt',
] as const;
const BEGIN_TOKEN_KEYS = [
  'expectedRootEpoch',
  'action',
  'conversationId',
  'sourceProjectId',
  'sourceRuntimeContextId',
  'sourceModelId',
  'snapshotId',
  'snapshotSha256',
  'consentReceiptId',
  'expectedUpdatedAt',
  'targetProjectId',
] as const;
const PUBLIC_TOKEN_KEYS = [
  'generation',
  'lifecycleId',
  'epoch',
  'action',
  'conversationId',
  'sourceProjectId',
  'sourceRuntimeContextId',
  'sourceModelId',
  'snapshotId',
  'snapshotSha256',
  'consentReceiptId',
  'targetProjectId',
  'phase',
] as const;
const KNOWN_NATIVE_CODES: ReadonlySet<string> = new Set([
  ...PROJECT_CONTEXT_ERROR_CODES,
  ...PROJECT_CONTEXT_BRIDGE_ERROR_CODES,
]);

const INITIAL_STATE: ProjectContextLifecycleControllerState = Object.freeze({
  generation: 0,
  phase: 'idle',
  token: null,
  failureCode: null,
  pendingPersistence: null,
});

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    const names = Object.getOwnPropertyNames(value);
    if (
      names.length !== keys.length ||
      names.some(name => !keys.includes(name))
    ) {
      return false;
    }
    return keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
        descriptor.enumerable === true
      );
    });
  } catch {
    return false;
  }
}

function exactDataProjection(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!exactDataRecord(value, keys)) return null;
  try {
    const projected = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ) {
        return null;
      }
      projected[key] = descriptor.value;
    }
    return projected;
  } catch {
    return null;
  }
}

function exactConversation(
  state: ChatState,
  conversationId: string,
): ChatState['conversations'][string] | null {
  try {
    if (
      typeof state.conversations !== 'object' ||
      state.conversations === null ||
      Array.isArray(state.conversations)
    ) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      state.conversations,
      conversationId,
    );
    return descriptor !== undefined &&
      Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
      descriptor.enumerable === true
      ? (descriptor.value as ChatState['conversations'][string])
      : null;
  } catch {
    return null;
  }
}

function actionTargetValid(
  action: unknown,
  sourceProjectId: string,
  targetProjectId: unknown,
): targetProjectId is string | null {
  return (
    ((action === 'unbind' || action === 'delete') &&
      targetProjectId === null) ||
    (action === 'rebind' &&
      isProjectId(targetProjectId) &&
      targetProjectId !== sourceProjectId)
  );
}

function strictContext(value: unknown): ProjectContextState | null {
  try {
    return canonicalizeDurableProjectContextState(
      value as ProjectContextState,
    );
  } catch {
    return null;
  }
}

function validTransitionShape(
  value: unknown,
): value is ProjectContextDestructiveTransitionV1 {
  if (!exactDataRecord(value, TRANSITION_KEYS)) return false;
  try {
    const transition = value as ProjectContextDestructiveTransitionV1;
    return (
      transition.schemaVersion === 1 &&
      isCanonicalLifecycleId(transition.lifecycleId) &&
      Number.isSafeInteger(transition.epoch) &&
      !Object.is(transition.epoch, -0) &&
      transition.epoch > 0 &&
      (transition.action === 'unbind' ||
        transition.action === 'delete' ||
        transition.action === 'rebind') &&
      (transition.phase === 'intent' ||
        transition.phase === 'cleanup_pending' ||
        transition.phase === 'ready_to_finalize') &&
      typeof transition.conversationId === 'string' &&
      transition.conversationId.length > 0 &&
      transition.conversationId.length <= 256 &&
      isProjectId(transition.sourceProjectId) &&
      (transition.sourceRuntimeContextId === null ||
        isCanonicalLifecycleId(transition.sourceRuntimeContextId)) &&
      isModelId(transition.sourceModelId) &&
      isCanonicalLifecycleId(transition.snapshotId) &&
      isSha256Digest(transition.snapshotSha256) &&
      (transition.consentReceiptId === null ||
        isCanonicalLifecycleId(transition.consentReceiptId)) &&
      actionTargetValid(
        transition.action,
        transition.sourceProjectId,
        transition.targetProjectId,
      ) &&
      isCanonicalTimestamp(transition.createdAt) &&
      isCanonicalTimestamp(transition.updatedAt) &&
      Date.parse(transition.updatedAt) >= Date.parse(transition.createdAt)
    );
  } catch {
    return false;
  }
}

function relationForTransition(
  chat: ChatStore,
): ProjectContextDestructiveTransitionV1 | null {
  try {
    const state = chat.getState();
    const transition = state.projectContextDestructiveTransition;
    if (
      !validTransitionShape(transition) ||
      transition.epoch !== state.projectContextDestructiveEpoch
    ) {
      return null;
    }
    const conversation = exactConversation(state, transition.conversationId);
    if (
      conversation === null ||
      conversation.projectId !== transition.sourceProjectId ||
      conversation.runtimeContextId !== transition.sourceRuntimeContextId ||
      conversation.modelId !== transition.sourceModelId
    ) {
      return null;
    }
    const context = strictContext(conversation.projectContext);
    if (context === null || context.projectId !== transition.sourceProjectId) {
      return null;
    }
    if (transition.phase === 'intent') {
      if (
        context.activePreparationId !== null ||
        context.snapshot?.snapshot_id !== transition.snapshotId ||
        context.snapshot.snapshot_sha256 !== transition.snapshotSha256 ||
        (context.consent?.consent_receipt_id ?? null) !==
          transition.consentReceiptId ||
        transition.createdAt !== transition.updatedAt ||
        Date.parse(conversation.updatedAt) > Date.parse(transition.createdAt)
      ) {
        return null;
      }
    } else if (
      context.status !== 'setup_required' ||
      context.selectedPaths.length !== 0 ||
      context.activePreparationId !== null ||
      context.snapshot !== null ||
      context.consent !== null ||
      context.staleReason !== null ||
      context.errorCode !== null ||
      (transition.phase === 'cleanup_pending' &&
        conversation.updatedAt !== transition.updatedAt) ||
      (transition.phase === 'ready_to_finalize' &&
        Date.parse(conversation.updatedAt) > Date.parse(transition.updatedAt))
    ) {
      return null;
    }
    return transition;
  } catch {
    return null;
  }
}

function tokenFromTransition(
  transition: ProjectContextDestructiveTransitionV1,
  generation: number,
): ProjectContextDestructiveToken {
  return Object.freeze({
    generation,
    lifecycleId: transition.lifecycleId,
    epoch: transition.epoch,
    action: transition.action,
    conversationId: transition.conversationId,
    sourceProjectId: transition.sourceProjectId,
    sourceRuntimeContextId: transition.sourceRuntimeContextId,
    sourceModelId: transition.sourceModelId,
    snapshotId: transition.snapshotId,
    snapshotSha256: transition.snapshotSha256,
    consentReceiptId: transition.consentReceiptId,
    targetProjectId: transition.targetProjectId,
    phase: transition.phase,
  });
}

function frozenIdentity(
  transition: ProjectContextDestructiveTransitionV1,
): FrozenLifecycleIdentity {
  return {
    lifecycleId: transition.lifecycleId,
    epoch: transition.epoch,
    action: transition.action,
    conversationId: transition.conversationId,
    sourceProjectId: transition.sourceProjectId,
    sourceRuntimeContextId: transition.sourceRuntimeContextId,
    sourceModelId: transition.sourceModelId,
    snapshotId: transition.snapshotId,
    snapshotSha256: transition.snapshotSha256,
    consentReceiptId: transition.consentReceiptId,
    targetProjectId: transition.targetProjectId,
    createdAt: transition.createdAt,
  };
}

function sameFrozenIdentity(
  transition: ProjectContextDestructiveTransitionV1,
  expected: FrozenLifecycleIdentity,
): boolean {
  return (
    transition.lifecycleId === expected.lifecycleId &&
    transition.epoch === expected.epoch &&
    transition.action === expected.action &&
    transition.conversationId === expected.conversationId &&
    transition.sourceProjectId === expected.sourceProjectId &&
    transition.sourceRuntimeContextId === expected.sourceRuntimeContextId &&
    transition.sourceModelId === expected.sourceModelId &&
    transition.snapshotId === expected.snapshotId &&
    transition.snapshotSha256 === expected.snapshotSha256 &&
    transition.consentReceiptId === expected.consentReceiptId &&
    transition.targetProjectId === expected.targetProjectId &&
    transition.createdAt === expected.createdAt
  );
}

function samePublicToken(
  expected: unknown,
  actual: ProjectContextDestructiveToken | null,
): boolean {
  if (actual === null || !exactDataRecord(expected, PUBLIC_TOKEN_KEYS)) {
    return false;
  }
  try {
    return PUBLIC_TOKEN_KEYS.every(key => expected[key] === actual[key]);
  } catch {
    return false;
  }
}

function sameBeginToken(
  expected: unknown,
  actual: ProjectContextDestructiveBeginToken,
): boolean {
  if (!exactDataRecord(expected, BEGIN_TOKEN_KEYS)) return false;
  try {
    return BEGIN_TOKEN_KEYS.every(key => expected[key] === actual[key]);
  } catch {
    return false;
  }
}

function nativeError(error: unknown): ProjectContextBridgeErrorCode {
  try {
    if (error instanceof ProjectContextBridgeError) {
      return KNOWN_NATIVE_CODES.has(error.code) ? error.code : 'E_CONTEXT_NATIVE';
    }
    if (typeof error !== 'object' || error === null) return 'E_CONTEXT_NATIVE';
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor !== undefined &&
      Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
      typeof descriptor.value === 'string' &&
      KNOWN_NATIVE_CODES.has(descriptor.value)
      ? (descriptor.value as ProjectContextBridgeErrorCode)
      : 'E_CONTEXT_NATIVE';
  } catch {
    return 'E_CONTEXT_NATIVE';
  }
}

function blocked(
  code: ProjectContextDestructiveErrorCode,
): ProjectContextDestructiveOutcome {
  return { status: 'blocked', code };
}

export function createProjectContextLifecycleController(
  dependencies: ProjectContextLifecycleControllerDependencies,
): ProjectContextLifecycleController {
  let state = INITIAL_STATE;
  let operationSequence = 0;
  let activeOperation: number | null = null;
  let activeIdentity: FrozenLifecycleIdentity | null = null;
  let pendingPersistence: PendingPersistence | null = null;
  const listeners = new Set<
    (state: ProjectContextLifecycleControllerState) => void
  >();

  const exposedState = (): ProjectContextLifecycleControllerState =>
    Object.freeze({
      ...state,
      token: state.token === null ? null : Object.freeze({ ...state.token }),
    });

  const publish = (
    patch: Partial<
      Omit<ProjectContextLifecycleControllerState, 'generation' | 'token'>
    >,
  ) => {
    const generation = state.generation + 1;
    const transition = relationForTransition(dependencies.chat);
    state = {
      ...state,
      ...patch,
      generation,
      token:
        transition === null
          ? null
          : tokenFromTransition(transition, generation),
    };
    const visible = exposedState();
    listeners.forEach(listener => {
      try {
        listener(visible);
      } catch {
        // Listener failures cannot affect durable lifecycle ownership.
      }
    });
  };

  const safePersist = async (): Promise<SessionDurabilityResult> => {
    try {
      const result = await dependencies.persistCurrent();
      if (
        result?.status === 'committed' ||
        result?.status === 'session_only' ||
        result?.status === 'not_committed' ||
        result?.status === 'unknown'
      ) {
        return result;
      }
    } catch {
      // Unknown durability is never success.
    }
    return { status: 'unknown' };
  };

  const beginOperation = (
    transition: ProjectContextDestructiveTransitionV1 | null = null,
  ): number | null => {
    if (activeOperation !== null) return null;
    operationSequence += 1;
    activeOperation = operationSequence;
    activeIdentity =
      transition === null ? null : frozenIdentity(transition);
    return operationSequence;
  };

  const operationLive = (operationId: number): boolean =>
    activeOperation === operationId;

  const finishOperation = (operationId: number) => {
    if (activeOperation === operationId) {
      activeOperation = null;
      activeIdentity = null;
    }
  };

  const gate = (
    conversationId: string,
    snapshotId: string,
  ): ProjectContextDestructiveErrorCode | null => {
    try {
      if (
        dependencies.projectContextMutationBlocked() ||
        dependencies.completionMutationBlocked()
      ) {
        return 'E_CONTEXT_TRANSITION_BUSY';
      }
    } catch {
      return 'E_CONTEXT_TRANSITION_BUSY';
    }
    try {
      if (dependencies.snapshotReferences(conversationId, snapshotId).length > 0) {
        return 'E_CONTEXT_TRANSITION_REFERENCED';
      }
    } catch {
      return 'E_CONTEXT_TRANSITION_REFERENCED';
    }
    return null;
  };

  const setBlocked = (
    code: ProjectContextDestructiveErrorCode,
  ): ProjectContextDestructiveOutcome => {
    publish({ phase: 'blocked', failureCode: code });
    return blocked(code);
  };

  const capture = (
    conversationId: string,
    action: ProjectContextDestructiveAction,
    targetProjectId: string | null,
    allowActiveOperation = false,
  ): ProjectContextDestructiveBeginResult => {
    try {
      if (
        (!allowActiveOperation && activeOperation !== null) ||
        pendingPersistence !== null ||
        dependencies.maximumPendingLifecycle !== 1
      ) {
        return { ok: false, code: 'E_CONTEXT_TRANSITION_BUSY' };
      }
      const root = dependencies.chat.getState();
      if (root.projectContextDestructiveTransition !== null) {
        return { ok: false, code: 'E_CONTEXT_TRANSITION_BUSY' };
      }
      if (
        !Number.isSafeInteger(root.projectContextDestructiveEpoch) ||
        root.projectContextDestructiveEpoch < 0 ||
        root.projectContextDestructiveEpoch >= Number.MAX_SAFE_INTEGER ||
        Object.is(root.projectContextDestructiveEpoch, -0)
      ) {
        return { ok: false, code: 'E_CONTEXT_TRANSITION_UNKNOWN' };
      }
      const conversation = exactConversation(root, conversationId);
      if (
        conversation === null ||
        conversation.projectId === null ||
        !isProjectId(conversation.projectId) ||
        (conversation.runtimeContextId !== null &&
          !isCanonicalLifecycleId(conversation.runtimeContextId)) ||
        !isModelId(conversation.modelId) ||
        !isCanonicalTimestamp(conversation.updatedAt) ||
        !actionTargetValid(action, conversation.projectId, targetProjectId)
      ) {
        return { ok: false, code: 'E_CONTEXT_TRANSITION_INVALID' };
      }
      const context = strictContext(conversation.projectContext);
      const snapshot = context?.snapshot;
      if (
        context === null ||
        context.projectId !== conversation.projectId ||
        context.activePreparationId !== null ||
        snapshot === null ||
        snapshot === undefined ||
        !isCanonicalLifecycleId(snapshot.snapshot_id) ||
        !isSha256Digest(snapshot.snapshot_sha256) ||
        (context.consent !== null &&
          (!isCanonicalLifecycleId(context.consent.consent_receipt_id) ||
            context.consent.snapshot_id !== snapshot.snapshot_id ||
            context.consent.snapshot_sha256 !== snapshot.snapshot_sha256))
      ) {
        return { ok: false, code: 'E_CONTEXT_TRANSITION_INVALID' };
      }
      const blockedCode = gate(conversationId, snapshot.snapshot_id);
      if (blockedCode !== null) return { ok: false, code: blockedCode };
      return {
        ok: true,
        token: Object.freeze({
          expectedRootEpoch: root.projectContextDestructiveEpoch,
          action,
          conversationId,
          sourceProjectId: conversation.projectId,
          sourceRuntimeContextId: conversation.runtimeContextId,
          sourceModelId: conversation.modelId,
          snapshotId: snapshot.snapshot_id,
          snapshotSha256: snapshot.snapshot_sha256,
          consentReceiptId: context.consent?.consent_receipt_id ?? null,
          expectedUpdatedAt: conversation.updatedAt,
          targetProjectId,
        }),
      };
    } catch {
      return { ok: false, code: 'E_CONTEXT_TRANSITION_UNKNOWN' };
    }
  };

  const currentAdvanceScope = (
    expectedPhase: ProjectContextDestructivePhase,
  ): ProjectContextDestructiveAdvanceScope | null => {
    const transition = relationForTransition(dependencies.chat);
    if (
      transition === null ||
      transition.phase !== expectedPhase ||
      activeIdentity === null ||
      !sameFrozenIdentity(transition, activeIdentity)
    ) {
      return null;
    }
    return {
      lifecycleId: transition.lifecycleId,
      epoch: transition.epoch,
      action: transition.action,
      targetProjectId: transition.targetProjectId,
      expectedTransition: transition,
    };
  };

  let continueFromIntent: (
    operationId: number,
  ) => Promise<ProjectContextDestructiveOutcome>;
  let continueFromCleanup: (
    operationId: number,
  ) => Promise<ProjectContextDestructiveOutcome>;
  let continueFromReady: (
    operationId: number,
  ) => Promise<ProjectContextDestructiveOutcome>;

  const completeAction = (
    action: ProjectContextDestructiveAction,
  ): ProjectContextDestructiveOutcome => {
    pendingPersistence = null;
    publish({
      phase: 'idle',
      pendingPersistence: null,
      failureCode: null,
    });
    return { status: 'completed', action };
  };

  const continueAfterCommittedStage = async (
    operationId: number,
    stage: PersistenceStage,
    action: ProjectContextDestructiveAction,
  ): Promise<ProjectContextDestructiveOutcome> => {
    if (!operationLive(operationId)) {
      return blocked('E_CONTEXT_TRANSITION_CONFLICT');
    }
    if (stage === 'intent') return continueFromIntent(operationId);
    if (stage === 'tombstone') return continueFromCleanup(operationId);
    if (stage === 'ready_to_finalize') return continueFromReady(operationId);
    return completeAction(action);
  };

  const persistencePhase = (
    stage: PersistenceStage,
  ): ProjectContextLifecycleControllerPhase =>
    stage === 'intent'
      ? 'intent_persistence_pending'
      : stage === 'tombstone'
        ? 'tombstone_persistence_pending'
        : stage === 'ready_to_finalize'
          ? 'ready_persistence_pending'
          : 'finalize_persistence_pending';

  const persistCandidate = async (
    operationId: number,
    stage: PersistenceStage,
    action: ProjectContextDestructiveAction,
    transaction: ProjectContextDestructiveTransaction,
  ): Promise<ProjectContextDestructiveOutcome> => {
    const durability = await safePersist();
    if (!operationLive(operationId)) {
      return blocked('E_CONTEXT_TRANSITION_CONFLICT');
    }
    if (durability.status === 'committed') {
      if (!transaction.commit()) {
        return setBlocked('E_CONTEXT_TRANSITION_CONFLICT');
      }
      pendingPersistence = null;
      return continueAfterCommittedStage(operationId, stage, action);
    }

    let retainedTransaction: ProjectContextDestructiveTransaction | null =
      transaction;
    if (durability.status === 'not_committed' || stage === 'finalize') {
      if (!transaction.rollback()) {
        return setBlocked('E_CONTEXT_TRANSITION_UNKNOWN');
      }
      retainedTransaction = null;
    }
    if (stage === 'intent' && durability.status === 'not_committed') {
      pendingPersistence = null;
      publish({
        phase: 'blocked',
        pendingPersistence: null,
        failureCode: 'E_CONTEXT_PERSISTENCE',
      });
      return blocked('E_CONTEXT_PERSISTENCE');
    }
    pendingPersistence = {
      stage,
      transaction: retainedTransaction,
      action,
    };
    publish({
      phase: persistencePhase(stage),
      pendingPersistence: stage,
      failureCode: 'E_CONTEXT_PERSISTENCE',
    });
    return { status: 'persistence_pending', code: 'E_CONTEXT_PERSISTENCE' };
  };

  const gatesForCurrent = (): ProjectContextDestructiveErrorCode | null => {
    const transition = relationForTransition(dependencies.chat);
    return transition === null
      ? 'E_CONTEXT_TRANSITION_UNKNOWN'
      : gate(transition.conversationId, transition.snapshotId);
  };

  continueFromIntent = async operationId => {
    const blockedCode = gatesForCurrent();
    if (blockedCode !== null) return setBlocked(blockedCode);
    const scope = currentAdvanceScope('intent');
    if (scope === null) return setBlocked('E_CONTEXT_TRANSITION_CONFLICT');
    const transaction =
      dependencies.chat.tombstoneProjectContextDestructiveTransition(scope);
    if (transaction === null) {
      return setBlocked('E_CONTEXT_TRANSITION_CONFLICT');
    }
    return persistCandidate(
      operationId,
      'tombstone',
      scope.action,
      transaction,
    );
  };

  continueFromCleanup = async operationId => {
    let transition = relationForTransition(dependencies.chat);
    if (
      transition === null ||
      transition.phase !== 'cleanup_pending' ||
      activeIdentity === null ||
      !sameFrozenIdentity(transition, activeIdentity)
    ) {
      return setBlocked('E_CONTEXT_TRANSITION_UNKNOWN');
    }
    const blockedBefore = gate(
      transition.conversationId,
      transition.snapshotId,
    );
    if (blockedBefore !== null) return setBlocked(blockedBefore);
    publish({ phase: 'cleanup_pending', failureCode: null });
    try {
      await dependencies.native.discard(transition.snapshotId);
    } catch (error) {
      if (!operationLive(operationId)) {
        return blocked('E_CONTEXT_TRANSITION_CONFLICT');
      }
      const code = nativeError(error);
      if (code !== 'E_CONTEXT_SNAPSHOT_MISSING') {
        publish({ phase: 'cleanup_pending', failureCode: code });
        return { status: 'cleanup_pending', code };
      }
    }
    if (!operationLive(operationId)) {
      return blocked('E_CONTEXT_TRANSITION_CONFLICT');
    }
    transition = relationForTransition(dependencies.chat);
    if (
      transition === null ||
      transition.phase !== 'cleanup_pending' ||
      activeIdentity === null ||
      !sameFrozenIdentity(transition, activeIdentity)
    ) {
      return setBlocked('E_CONTEXT_TRANSITION_CONFLICT');
    }
    const blockedAfter = gate(
      transition.conversationId,
      transition.snapshotId,
    );
    if (blockedAfter !== null) return setBlocked(blockedAfter);
    const scope = currentAdvanceScope('cleanup_pending');
    if (scope === null) return setBlocked('E_CONTEXT_TRANSITION_CONFLICT');
    const transaction =
      dependencies.chat.markProjectContextDestructiveCleanupComplete(scope);
    if (transaction === null) {
      return setBlocked('E_CONTEXT_TRANSITION_CONFLICT');
    }
    return persistCandidate(
      operationId,
      'ready_to_finalize',
      scope.action,
      transaction,
    );
  };

  continueFromReady = async operationId => {
    const transition = relationForTransition(dependencies.chat);
    if (
      transition === null ||
      transition.phase !== 'ready_to_finalize' ||
      activeIdentity === null ||
      !sameFrozenIdentity(transition, activeIdentity)
    ) {
      return setBlocked('E_CONTEXT_TRANSITION_UNKNOWN');
    }
    const blockedCode = gate(
      transition.conversationId,
      transition.snapshotId,
    );
    if (blockedCode !== null) return setBlocked(blockedCode);
    publish({ phase: 'ready_to_finalize', failureCode: null });
    const scope = currentAdvanceScope('ready_to_finalize');
    if (scope === null) return setBlocked('E_CONTEXT_TRANSITION_CONFLICT');
    const transaction =
      dependencies.chat.finalizeProjectContextDestructiveTransition(scope);
    if (transaction === null) {
      return setBlocked('E_CONTEXT_TRANSITION_CONFLICT');
    }
    return persistCandidate(
      operationId,
      'finalize',
      scope.action,
      transaction,
    );
  };

  const recreatePendingCandidate = (
    pending: PendingPersistence,
  ): ProjectContextDestructiveTransaction | null => {
    if (pending.stage === 'intent') return null;
    const phase: ProjectContextDestructivePhase =
      pending.stage === 'tombstone'
        ? 'intent'
        : pending.stage === 'ready_to_finalize'
          ? 'cleanup_pending'
          : 'ready_to_finalize';
    const scope = currentAdvanceScope(phase);
    if (scope === null || scope.action !== pending.action) return null;
    return pending.stage === 'tombstone'
      ? dependencies.chat.tombstoneProjectContextDestructiveTransition(scope)
      : pending.stage === 'ready_to_finalize'
        ? dependencies.chat.markProjectContextDestructiveCleanupComplete(scope)
        : dependencies.chat.finalizeProjectContextDestructiveTransition(scope);
  };

  const controller: ProjectContextLifecycleController = {
    getState: exposedState,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    captureDestructiveBeginToken: capture,
    beginDestructiveTransition: async expected => {
      if (activeOperation !== null || pendingPersistence !== null) {
        return blocked('E_CONTEXT_TRANSITION_BUSY');
      }
      const projectedExpected = exactDataProjection(
        expected,
        BEGIN_TOKEN_KEYS,
      );
      if (projectedExpected === null) {
        return blocked('E_CONTEXT_TRANSITION_INVALID');
      }
      const captured = capture(
        projectedExpected.conversationId as string,
        projectedExpected.action as ProjectContextDestructiveAction,
        projectedExpected.targetProjectId as string | null,
      );
      if (
        !captured.ok ||
        !sameBeginToken(projectedExpected, captured.token)
      ) {
        return blocked(
          captured.ok ? 'E_CONTEXT_TRANSITION_CONFLICT' : captured.code,
        );
      }
      let lifecycleId: string;
      try {
        lifecycleId = dependencies.createLifecycleId();
      } catch {
        return blocked('E_CONTEXT_TRANSITION_INVALID');
      }
      if (!isCanonicalLifecycleId(lifecycleId)) {
        return blocked('E_CONTEXT_TRANSITION_INVALID');
      }
      const operationId = beginOperation();
      if (operationId === null) return blocked('E_CONTEXT_TRANSITION_BUSY');
      publish({ phase: 'resuming', failureCode: null, pendingPersistence: null });
      const immediate = capture(
        captured.token.conversationId,
        captured.token.action,
        captured.token.targetProjectId,
        true,
      );
      if (!immediate.ok || !sameBeginToken(captured.token, immediate.token)) {
        finishOperation(operationId);
        return setBlocked(
          immediate.ok ? 'E_CONTEXT_TRANSITION_CONFLICT' : immediate.code,
        );
      }
      const root = dependencies.chat.getState();
      const conversation = exactConversation(root, captured.token.conversationId);
      if (
        conversation === null ||
        conversation.projectContext === null ||
        root.projectContextDestructiveEpoch !==
          captured.token.expectedRootEpoch
      ) {
        finishOperation(operationId);
        return setBlocked('E_CONTEXT_TRANSITION_CONFLICT');
      }
      const transaction =
        dependencies.chat.beginProjectContextDestructiveTransition({
          lifecycleId,
          action: captured.token.action,
          targetProjectId: captured.token.targetProjectId,
          owner: {
            conversationId: captured.token.conversationId,
            projectId: captured.token.sourceProjectId,
            runtimeContextId: captured.token.sourceRuntimeContextId,
            modelId: captured.token.sourceModelId,
            expectedUpdatedAt: captured.token.expectedUpdatedAt,
            expectedContext: conversation.projectContext,
          },
        });
      if (transaction === null) {
        finishOperation(operationId);
        return setBlocked('E_CONTEXT_TRANSITION_CONFLICT');
      }
      const transition = relationForTransition(dependencies.chat);
      if (transition === null) {
        transaction.rollback();
        finishOperation(operationId);
        return setBlocked('E_CONTEXT_TRANSITION_CONFLICT');
      }
      activeIdentity = frozenIdentity(transition);
      publish({ phase: 'resuming', failureCode: null });
      const outcome = await persistCandidate(
        operationId,
        'intent',
        captured.token.action,
        transaction,
      );
      finishOperation(operationId);
      return outcome;
    },
    reconcileDestructiveTransition: async () => {
      if (activeOperation !== null || pendingPersistence !== null) {
        return blocked('E_CONTEXT_TRANSITION_BUSY');
      }
      const transition = relationForTransition(dependencies.chat);
      if (transition === null) {
        return blocked('E_CONTEXT_TRANSITION_UNKNOWN');
      }
      const operationId = beginOperation(transition);
      if (operationId === null) return blocked('E_CONTEXT_TRANSITION_BUSY');
      publish({ phase: 'resuming', failureCode: null, pendingPersistence: null });
      const outcome =
        transition.phase === 'intent'
          ? await continueFromIntent(operationId)
          : transition.phase === 'cleanup_pending'
            ? await continueFromCleanup(operationId)
            : await continueFromReady(operationId);
      finishOperation(operationId);
      return outcome;
    },
    getDestructiveToken: () =>
      state.token === null ? null : Object.freeze({ ...state.token }),
    retryDestructivePersistence: async expected => {
      if (
        activeOperation !== null ||
        pendingPersistence === null ||
        !samePublicToken(expected, state.token)
      ) {
        return blocked(
          activeOperation !== null
            ? 'E_CONTEXT_TRANSITION_BUSY'
            : 'E_CONTEXT_TRANSITION_CONFLICT',
        );
      }
      const pending = pendingPersistence;
      const blockedCode = gatesForCurrent();
      if (blockedCode !== null) return setBlocked(blockedCode);
      const transition = relationForTransition(dependencies.chat);
      if (transition === null) {
        return setBlocked('E_CONTEXT_TRANSITION_UNKNOWN');
      }
      const operationId = beginOperation(transition);
      if (operationId === null) return blocked('E_CONTEXT_TRANSITION_BUSY');
      const transaction =
        pending.transaction ?? recreatePendingCandidate(pending);
      if (transaction === null) {
        finishOperation(operationId);
        return setBlocked('E_CONTEXT_TRANSITION_CONFLICT');
      }
      publish({ phase: 'resuming', failureCode: null });
      const outcome = await persistCandidate(
        operationId,
        pending.stage,
        pending.action,
        transaction,
      );
      finishOperation(operationId);
      return outcome;
    },
    retryDestructiveCleanup: async expected => {
      if (
        activeOperation !== null ||
        pendingPersistence !== null ||
        !samePublicToken(expected, state.token) ||
        relationForTransition(dependencies.chat)?.phase !== 'cleanup_pending'
      ) {
        return blocked(
          activeOperation !== null
            ? 'E_CONTEXT_TRANSITION_BUSY'
            : 'E_CONTEXT_TRANSITION_CONFLICT',
        );
      }
      const transition = relationForTransition(dependencies.chat);
      if (transition === null) {
        return setBlocked('E_CONTEXT_TRANSITION_UNKNOWN');
      }
      const operationId = beginOperation(transition);
      if (operationId === null) return blocked('E_CONTEXT_TRANSITION_BUSY');
      const outcome = await continueFromCleanup(operationId);
      finishOperation(operationId);
      return outcome;
    },
    beforeConversationChange: _conversationId => {
      try {
        return (
          activeOperation === null &&
          pendingPersistence === null &&
          dependencies.chat.getState().projectContextDestructiveTransition ===
            null
        );
      } catch {
        return false;
      }
    },
    beforeConversationDelete: _conversationId => {
      try {
        return (
          activeOperation === null &&
          pendingPersistence === null &&
          dependencies.chat.getState().projectContextDestructiveTransition ===
            null
        );
      } catch {
        return false;
      }
    },
  };

  return controller;
}

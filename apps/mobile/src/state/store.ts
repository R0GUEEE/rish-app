import {
  chatReducer,
  createEmptyChatState,
  isCanonicalLifecycleId,
  MAX_ATTEMPT_VISIBLE_MESSAGES,
  orderConversationIds,
} from './reducer';
import { hydrateChatState, serializeChatState } from './persistence';
import type {
  ChatAction,
  ChatAttachment,
  ChatMessageMetadata,
  ChatState,
  CompletionRoundReceiptV1,
  Conversation,
  ConversationThinkingMode,
  ModelId,
  ProjectContextDestructiveAction,
  ProjectContextDestructiveAdvanceScope,
  ProjectContextDestructiveOwner,
  ProjectContextMutationScope,
  TurnAttemptV1,
} from './types';
import { isProjectContextSendable } from '../project-context/reducer';
import type {
  ProjectContextAction,
  ProjectContextConsentV1,
  ProjectContextManifestV1,
} from '../project-context/types';

export type ChatStoreIdKind = 'conversation' | 'message';
export type ChatStoreLifecycleIdKind =
  | 'runtimeContext'
  | 'turn'
  | 'attempt'
  | 'round';
export type ChatStoreListener = (state: ChatState) => void;

export type ChatStoreOptions = {
  readonly initialState?: ChatState;
  readonly now?: () => Date | number | string;
  readonly createId?: (kind: ChatStoreIdKind) => string;
  /**
   * Generates canonical UUID identities for distinct durable lifecycle
   * entities. The kind is semantic and must not be silently rerouted.
   */
  readonly createLifecycleId?: (kind: ChatStoreLifecycleIdKind) => string;
};

export type CreateConversationOptions = {
  readonly modelId?: ModelId;
  readonly thinkingMode?: ConversationThinkingMode;
  readonly projectId?: string | null;
  readonly workspaceId?: string | null;
  readonly title?: string;
  readonly select?: boolean;
};

export type AppendMessageOptions = {
  readonly metadata?: ChatMessageMetadata;
  readonly attachments?: readonly ChatAttachment[];
};

export type PrepareTurnAttemptOptions = AppendMessageOptions & {
  /** Explicit user choice to send a project-bound turn without local context. */
  readonly sendWithoutProjectContext?: boolean;
};

export type PreparedTurnAttempt = {
  readonly turnId: string;
  readonly attemptId: string;
  readonly userMessageId: string;
};

export type PreparedTurnTransaction = PreparedTurnAttempt & {
  /** Disarms rollback after the prepared state is durably accepted. */
  commit(): boolean;
  /** Restores the exact prior root only while no later state won the race. */
  rollback(): boolean;
};

export type ReplaceProjectContextPreparedInput = {
  readonly preparationId: string;
  readonly selectedPaths: readonly string[];
  readonly manifest: ProjectContextManifestV1;
};

export type ReplaceProjectContextConfirmedInput =
  ReplaceProjectContextPreparedInput & {
    readonly consent: ProjectContextConsentV1;
  };

export type ScopedProjectContextTransaction = {
  readonly conversationId: string;
  readonly previousSnapshotId: string | null;
  readonly nextSnapshotId: string | null;
  /** Settles only while the target conversation still equals the applied row. */
  commit(): boolean;
  /** Restores only the target conversation, preserving unrelated root changes. */
  rollback(): boolean;
};

export type DisableProjectContextTransaction =
  ScopedProjectContextTransaction & {
    readonly cleanupSnapshotId: string | null;
  };

export type BeginProjectContextDestructiveInput = {
  readonly lifecycleId: string;
  readonly action: ProjectContextDestructiveAction;
  readonly targetProjectId: string | null;
  readonly owner: ProjectContextDestructiveOwner;
};

export type ProjectContextDestructiveTransaction = {
  readonly lifecycleId: string;
  readonly epoch: number;
  commit(): boolean;
  rollback(): boolean;
};

export type ChatStore = {
  getState(): ChatState;
  dispatch(action: ChatAction): ChatState;
  subscribe(listener: ChatStoreListener): () => void;
  createConversation(options?: CreateConversationOptions): string;
  renameConversation(id: string, title: string): void;
  autoTitleConversation(id: string, sourceText: string): void;
  selectConversation(id: string | null): void;
  appendUserMessage(
    conversationId: string,
    text: string,
    options?: AppendMessageOptions,
  ): string;
  appendAssistantMessage(
    conversationId: string,
    text: string,
    options?: AppendMessageOptions,
  ): string;
  deleteConversation(id: string): void;
  setModel(id: string, modelId: ModelId): void;
  setThinkingMode(id: string, thinkingMode: ConversationThinkingMode): void;
  bindConversationToProject(id: string, projectId: string): void;
  unbindConversationFromProject(id: string): void;
  bindConversationToWorkspace(id: string, workspaceId: string): void;
  unbindConversationFromWorkspace(id: string): void;
  ensureRuntimeContextId(conversationId: string): string | null;
  applyProjectContextAction(
    conversationId: string,
    action: ProjectContextAction,
  ): boolean;
  replaceProjectContextPrepared(
    scope: ProjectContextMutationScope,
    input: ReplaceProjectContextPreparedInput,
  ): ScopedProjectContextTransaction | null;
  replaceProjectContextConfirmed(
    scope: ProjectContextMutationScope,
    input: ReplaceProjectContextConfirmedInput,
  ): ScopedProjectContextTransaction | null;
  disableProjectContext(
    scope: ProjectContextMutationScope,
  ): DisableProjectContextTransaction | null;
  beginProjectContextDestructiveTransition(
    input: BeginProjectContextDestructiveInput,
  ): ProjectContextDestructiveTransaction | null;
  tombstoneProjectContextDestructiveTransition(
    scope: ProjectContextDestructiveAdvanceScope,
  ): ProjectContextDestructiveTransaction | null;
  markProjectContextDestructiveCleanupComplete(
    scope: ProjectContextDestructiveAdvanceScope,
  ): ProjectContextDestructiveTransaction | null;
  finalizeProjectContextDestructiveTransition(
    scope: ProjectContextDestructiveAdvanceScope,
  ): ProjectContextDestructiveTransaction | null;
  prepareTurnAttempt(
    conversationId: string,
    text: string,
    options?: PrepareTurnAttemptOptions,
  ): PreparedTurnTransaction | null;
  startAttemptRound(
    conversationId: string,
    attemptId: string,
    roundId: string,
    roundIndex: number,
  ): boolean;
  recordAttemptRound(
    conversationId: string,
    attemptId: string,
    receipt: CompletionRoundReceiptV1,
  ): boolean;
  completeAttempt(
    conversationId: string,
    attemptId: string,
    text: string,
    options?: AppendMessageOptions,
  ): string | null;
  failAttempt(
    conversationId: string,
    attemptId: string,
    failureCode: string,
  ): boolean;
  cancelAttempt(conversationId: string, attemptId: string): boolean;
  retryAttempt(
    conversationId: string,
    sourceAttemptId: string,
  ): PreparedTurnTransaction | null;
  serialize(): string;
  hydrate(input: unknown): ChatState;
};

let defaultIdCounter = 0;

function defaultCreateId(kind: ChatStoreIdKind): string {
  defaultIdCounter += 1;
  const entropy = Math.floor(Math.random() * 0x1_0000_0000)
    .toString(36)
    .padStart(7, '0');
  return `${kind}-${Date.now().toString(36)}-${defaultIdCounter.toString(
    36,
  )}-${entropy}`;
}

/** RFC-4122-shaped random identity for identity only, never for security. */
function defaultCreateLifecycleId(_kind: ChatStoreLifecycleIdKind): string {
  let value = '';
  for (let index = 0; index < 32; index += 1) {
    const random = Math.floor(Math.random() * 16);
    const nibble =
      index === 12 ? 4 : index === 16 ? 8 + (random % 4) : random;
    value += nibble.toString(16);
  }
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(
    12,
    16,
  )}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function canonicalNow(now: () => Date | number | string): string {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('ChatStore now() returned an invalid timestamp');
  }
  return date.toISOString();
}

function exactDataProjection(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length > 0) return null;
    const names = Object.getOwnPropertyNames(value);
    if (
      names.length !== keys.length ||
      names.some(name => !keys.includes(name))
    ) {
      return null;
    }
    const projected = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        descriptor.enumerable !== true
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

function frozenProjectContext(
  conversation: Conversation,
  sendWithoutProjectContext: boolean,
):
  | Pick<
      TurnAttemptV1,
      'contextDisposition' | 'contextProjectId' | 'projectContext'
    >
  | undefined {
  if (conversation.projectId === null) {
    return {
      contextDisposition: 'unbound',
      contextProjectId: null,
      projectContext: null,
    };
  }
  if (sendWithoutProjectContext) {
    return {
      contextDisposition: 'explicit_without_context',
      contextProjectId: conversation.projectId,
      projectContext: null,
    };
  }
  const context = conversation.projectContext;
  if (
    context === null ||
    conversation.runtimeContextId === null ||
    !isProjectContextSendable(context) ||
    context.snapshot === null ||
    context.consent === null ||
    !isCanonicalLifecycleId(conversation.runtimeContextId) ||
    !isCanonicalLifecycleId(context.snapshot.snapshot_id) ||
    !isCanonicalLifecycleId(context.consent.consent_receipt_id)
  ) {
    return undefined;
  }
  return {
    contextDisposition: 'verified',
    contextProjectId: conversation.projectId,
    projectContext: {
      schemaVersion: 1,
      runtimeContextId: conversation.runtimeContextId,
      projectId: conversation.projectId,
      snapshotId: context.snapshot.snapshot_id,
      snapshotSha256: context.snapshot.snapshot_sha256,
      sourceFingerprint: context.snapshot.source_fingerprint,
      contextBytes: context.snapshot.context_bytes,
      consentReceiptId: context.consent.consent_receipt_id,
      provider: 'deepseek',
      policy: 'chat-read-v1',
      policyVersion: 'chat-read-v1.0.0',
    },
  };
}

export function createChatStore(options: ChatStoreOptions = {}): ChatStore {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? defaultCreateId;
  const createLifecycleId =
    options.createLifecycleId ?? defaultCreateLifecycleId;
  let state = options.initialState ?? createEmptyChatState();
  const listeners = new Set<ChatStoreListener>();
  let notificationDepth = 0;

  const notifyListeners = () => {
    notificationDepth += 1;
    try {
      listeners.forEach(listener => {
        try {
          listener(state);
        } catch {
          // A UI subscriber must never strand an already-applied state mutation.
        }
      });
    } finally {
      notificationDepth -= 1;
    }
  };

  type AppliedAction = {
    readonly before: ChatState;
    readonly next: ChatState;
    readonly changed: boolean;
  };

  const applyAction = (action: ChatAction): AppliedAction => {
    const before = state;
    const next = chatReducer(before, action);
    if (next !== before) {
      state = next;
      notifyListeners();
    }
    return { before, next, changed: next !== before };
  };

  const dispatch = (action: ChatAction): ChatState => {
    if (
      notificationDepth > 0 &&
      (action.type === 'project-context-destructive/begin' ||
        action.type === 'project-context-destructive/tombstone' ||
        action.type === 'project-context-destructive/cleanup-complete' ||
        action.type === 'project-context-destructive/finalize')
    ) {
      return state;
    }
    applyAction(action);
    return state;
  };

  const preparedTransaction = (
    applied: AppliedAction,
    prepared: PreparedTurnAttempt,
  ): PreparedTurnTransaction | null => {
    if (!applied.changed) return null;
    let settled = false;
    return {
      ...prepared,
      commit: () => {
        if (settled) return false;
        settled = true;
        return true;
      },
      rollback: () => {
        if (settled) return false;
        settled = true;
        if (state !== applied.next) return false;
        state = applied.before;
        notifyListeners();
        return true;
      },
    };
  };

  const scopedProjectContextTransaction = (
    applied: AppliedAction,
    conversationId: string,
  ): ScopedProjectContextTransaction | null => {
    const beforeConversation = applied.before.conversations[conversationId];
    const nextConversation = applied.next.conversations[conversationId];
    if (
      !applied.changed ||
      beforeConversation === undefined ||
      nextConversation === undefined ||
      beforeConversation === nextConversation
    ) {
      return null;
    }
    let settled = false;
    return {
      conversationId,
      previousSnapshotId:
        beforeConversation.projectContext?.snapshot?.snapshot_id ?? null,
      nextSnapshotId:
        nextConversation.projectContext?.snapshot?.snapshot_id ?? null,
      commit: () => {
        if (settled) return false;
        settled = true;
        return state.conversations[conversationId] === nextConversation;
      },
      rollback: () => {
        if (settled) return false;
        settled = true;
        if (state.conversations[conversationId] !== nextConversation) {
          return false;
        }
        const conversations = {
          ...state.conversations,
          [conversationId]: beforeConversation,
        };
        state = {
          ...state,
          conversations,
          conversationOrder: orderConversationIds(conversations),
        };
        notifyListeners();
        return true;
      },
    };
  };

  const destructiveTransaction = (
    applied: AppliedAction,
    conversationId: string,
  ): ProjectContextDestructiveTransaction | null => {
    if (!applied.changed) return null;
    const beforeTransition =
      applied.before.projectContextDestructiveTransition;
    const nextTransition = applied.next.projectContextDestructiveTransition;
    const lifecycleId =
      nextTransition?.lifecycleId ?? beforeTransition?.lifecycleId;
    const epoch = nextTransition?.epoch ?? beforeTransition?.epoch;
    if (lifecycleId === undefined || epoch === undefined) return null;
    const beforeConversation = applied.before.conversations[conversationId];
    const nextConversation = applied.next.conversations[conversationId];
    const selectionChanged =
      applied.before.selectedConversationId !==
      applied.next.selectedConversationId;
    let settled = false;
    const nextStillOwned = () =>
      state.projectContextDestructiveEpoch ===
        applied.next.projectContextDestructiveEpoch &&
      state.projectContextDestructiveTransition === nextTransition &&
      state.conversations[conversationId] === nextConversation;
    return {
      lifecycleId,
      epoch,
      commit: () => {
        if (settled) return false;
        settled = true;
        return nextStillOwned();
      },
      rollback: () => {
        if (settled) return false;
        settled = true;
        if (!nextStillOwned()) return false;
        const conversations = { ...state.conversations };
        if (beforeConversation === undefined) {
          delete conversations[conversationId];
        } else {
          conversations[conversationId] = beforeConversation;
        }
        state = {
          ...state,
          projectContextDestructiveEpoch:
            applied.before.projectContextDestructiveEpoch,
          projectContextDestructiveTransition: beforeTransition,
          conversations,
          conversationOrder: orderConversationIds(conversations),
          selectedConversationId:
            selectionChanged &&
            state.selectedConversationId ===
              applied.next.selectedConversationId
              ? applied.before.selectedConversationId
              : state.selectedConversationId,
        };
        notifyListeners();
        return true;
      },
    };
  };

  const appendMessage = (
    role: 'user' | 'assistant',
    conversationId: string,
    text: string,
    appendOptions: AppendMessageOptions = {},
  ): string => {
    const id = createId('message');
    dispatch({
      type: 'message/append',
      payload: {
        conversationId,
        message: {
          id,
          role,
          text,
          createdAt: canonicalNow(now),
          attachments: appendOptions.attachments ?? [],
          ...(appendOptions.metadata === undefined
            ? {}
            : { metadata: appendOptions.metadata }),
        },
      },
    });
    return id;
  };

  return {
    getState: () => state,
    dispatch,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    createConversation: (createOptions = {}) => {
      const id = createId('conversation');
      dispatch({
        type: 'conversation/create',
        payload: {
          id,
          at: canonicalNow(now),
          ...createOptions,
        },
      });
      return id;
    },
    renameConversation: (id, title) => {
      dispatch({
        type: 'conversation/rename',
        payload: { id, title, at: canonicalNow(now) },
      });
    },
    autoTitleConversation: (id, sourceText) => {
      dispatch({
        type: 'conversation/auto-title',
        payload: { id, text: sourceText, at: canonicalNow(now) },
      });
    },
    selectConversation: id => {
      dispatch({ type: 'conversation/select', payload: { id } });
    },
    appendUserMessage: (conversationId, text, appendOptions) =>
      appendMessage('user', conversationId, text, appendOptions),
    appendAssistantMessage: (conversationId, text, appendOptions) =>
      appendMessage('assistant', conversationId, text, appendOptions),
    deleteConversation: id => {
      dispatch({ type: 'conversation/delete', payload: { id } });
    },
    setModel: (id, modelId) => {
      dispatch({
        type: 'conversation/set-model',
        payload: { id, modelId, at: canonicalNow(now) },
      });
    },
    setThinkingMode: (id, thinkingMode) => {
      dispatch({
        type: 'conversation/set-thinking',
        payload: { id, thinkingMode, at: canonicalNow(now) },
      });
    },
    bindConversationToProject: (id, projectId) => {
      dispatch({
        type: 'conversation/bind-project',
        payload: { id, projectId, at: canonicalNow(now) },
      });
    },
    unbindConversationFromProject: id => {
      dispatch({
        type: 'conversation/unbind-project',
        payload: { id, at: canonicalNow(now) },
      });
    },
    bindConversationToWorkspace: (id, workspaceId) => {
      dispatch({
        type: 'conversation/bind-workspace',
        payload: { id, workspaceId, at: canonicalNow(now) },
      });
    },
    unbindConversationFromWorkspace: id => {
      dispatch({
        type: 'conversation/unbind-workspace',
        payload: { id, at: canonicalNow(now) },
      });
    },
    ensureRuntimeContextId: conversationId => {
      const existing = state.conversations[conversationId]?.runtimeContextId;
      if (existing !== null && existing !== undefined) return existing;
      const id = createLifecycleId('runtimeContext');
      if (!isCanonicalLifecycleId(id)) return null;
      const before = state;
      dispatch({
        type: 'conversation/ensure-runtime-context',
        payload: {
          id: conversationId,
          runtimeContextId: id,
          at: canonicalNow(now),
        },
      });
      return state === before
        ? null
        : state.conversations[conversationId]?.runtimeContextId ?? null;
    },
    applyProjectContextAction: (conversationId, action) => {
      const before = state;
      dispatch({
        type: 'project-context/apply',
        payload: { conversationId, action, at: canonicalNow(now) },
      });
      return state !== before;
    },
    replaceProjectContextPrepared: (scope, input) => {
      const conversationId = scope.conversationId;
      if (typeof conversationId !== 'string') return null;
      const applied = applyAction({
        type: 'project-context/replace-prepared',
        payload: {
          scope,
          preparationId: input.preparationId,
          selectedPaths: input.selectedPaths,
          manifest: input.manifest,
          at: canonicalNow(now),
        },
      });
      return scopedProjectContextTransaction(applied, conversationId);
    },
    replaceProjectContextConfirmed: (scope, input) => {
      const conversationId = scope.conversationId;
      if (typeof conversationId !== 'string') return null;
      const applied = applyAction({
        type: 'project-context/replace-confirmed',
        payload: {
          scope,
          preparationId: input.preparationId,
          selectedPaths: input.selectedPaths,
          manifest: input.manifest,
          consent: input.consent,
          at: canonicalNow(now),
        },
      });
      return scopedProjectContextTransaction(applied, conversationId);
    },
    disableProjectContext: scope => {
      const conversationId = scope.conversationId;
      if (typeof conversationId !== 'string') return null;
      const applied = applyAction({
        type: 'project-context/disable',
        payload: { scope, at: canonicalNow(now) },
      });
      const transaction = scopedProjectContextTransaction(
        applied,
        conversationId,
      );
      return transaction === null
        ? null
        : {
            ...transaction,
            cleanupSnapshotId: transaction.previousSnapshotId,
          };
    },
    beginProjectContextDestructiveTransition: input => {
      if (notificationDepth > 0) return null;
      const projected = exactDataProjection(input, [
        'lifecycleId',
        'action',
        'targetProjectId',
        'owner',
      ]);
      if (projected === null) return null;
      const owner = exactDataProjection(projected.owner, [
        'conversationId',
        'projectId',
        'runtimeContextId',
        'modelId',
        'expectedUpdatedAt',
        'expectedContext',
      ]);
      if (owner === null) return null;
      const applied = applyAction({
        type: 'project-context-destructive/begin',
        payload: {
          lifecycleId: projected.lifecycleId as string,
          action: projected.action as ProjectContextDestructiveAction,
          targetProjectId: projected.targetProjectId as string | null,
          owner: owner as ProjectContextDestructiveOwner,
          at: canonicalNow(now),
        },
      });
      const conversationId =
        applied.next.projectContextDestructiveTransition?.conversationId;
      return conversationId === undefined
        ? null
        : destructiveTransaction(applied, conversationId);
    },
    tombstoneProjectContextDestructiveTransition: scope => {
      if (notificationDepth > 0) return null;
      const projected = exactDataProjection(scope, [
        'lifecycleId',
        'epoch',
        'action',
        'targetProjectId',
        'expectedTransition',
      ]);
      if (projected === null) return null;
      const conversationId =
        state.projectContextDestructiveTransition?.conversationId;
      if (conversationId === undefined) return null;
      const applied = applyAction({
        type: 'project-context-destructive/tombstone',
        payload: {
          scope: projected as ProjectContextDestructiveAdvanceScope,
          at: canonicalNow(now),
        },
      });
      return destructiveTransaction(applied, conversationId);
    },
    markProjectContextDestructiveCleanupComplete: scope => {
      if (notificationDepth > 0) return null;
      const projected = exactDataProjection(scope, [
        'lifecycleId',
        'epoch',
        'action',
        'targetProjectId',
        'expectedTransition',
      ]);
      if (projected === null) return null;
      const conversationId =
        state.projectContextDestructiveTransition?.conversationId;
      if (conversationId === undefined) return null;
      const applied = applyAction({
        type: 'project-context-destructive/cleanup-complete',
        payload: {
          scope: projected as ProjectContextDestructiveAdvanceScope,
          at: canonicalNow(now),
        },
      });
      return destructiveTransaction(applied, conversationId);
    },
    finalizeProjectContextDestructiveTransition: scope => {
      if (notificationDepth > 0) return null;
      const projected = exactDataProjection(scope, [
        'lifecycleId',
        'epoch',
        'action',
        'targetProjectId',
        'expectedTransition',
      ]);
      if (projected === null) return null;
      const conversationId =
        state.projectContextDestructiveTransition?.conversationId;
      if (conversationId === undefined) return null;
      const applied = applyAction({
        type: 'project-context-destructive/finalize',
        payload: {
          scope: projected as ProjectContextDestructiveAdvanceScope,
          at: canonicalNow(now),
        },
      });
      return destructiveTransaction(applied, conversationId);
    },
    prepareTurnAttempt: (conversationId, text, appendOptions = {}) => {
      const conversation = state.conversations[conversationId];
      if (conversation === undefined) return null;
      const contextChoice = frozenProjectContext(
        conversation,
        appendOptions.sendWithoutProjectContext === true,
      );
      if (contextChoice === undefined) return null;
      const userMessageId = createId('message');
      const turnId = createLifecycleId('turn');
      const attemptId = createLifecycleId('attempt');
      if (
        !isCanonicalLifecycleId(turnId) ||
        !isCanonicalLifecycleId(attemptId)
      ) {
        return null;
      }
      const at = canonicalNow(now);
      const message = {
        id: userMessageId,
        role: 'user' as const,
        text,
        createdAt: at,
        attachments: appendOptions.attachments ?? [],
        ...(appendOptions.metadata === undefined
          ? {}
          : { metadata: appendOptions.metadata }),
      };
      const visibleMessages = [...conversation.messages, message].slice(
        -MAX_ATTEMPT_VISIBLE_MESSAGES,
      );
      const attachmentIds: string[] = [];
      const seenAttachmentIds = new Set<string>();
      visibleMessages.forEach(visibleMessage => {
        visibleMessage.attachments.forEach(attachment => {
          if (seenAttachmentIds.has(attachment.id)) return;
          seenAttachmentIds.add(attachment.id);
          attachmentIds.push(attachment.id);
        });
      });
      const attempt: TurnAttemptV1 = {
        schemaVersion: 1,
        attemptId,
        turnId,
        status: 'prepared',
        visibleMessageIds: visibleMessages.map(item => item.id),
        visibleHistorySha256: null,
        attachmentIds,
        modelId: conversation.modelId,
        thinkingMode: conversation.thinkingMode,
        contextDisposition: contextChoice.contextDisposition,
        contextProjectId: contextChoice.contextProjectId,
        projectContext: contextChoice.projectContext,
        activeRound: null,
        rounds: [],
        assistantMessageId: null,
        failureCode: null,
        createdAt: at,
        updatedAt: at,
      };
      const applied = applyAction({
        type: 'turn/prepare',
        payload: {
          conversationId,
          message,
          turn: {
            schemaVersion: 1,
            turnId,
            userMessageId,
            attemptIds: [attemptId],
            createdAt: at,
          },
          attempt,
        },
      });
      return preparedTransaction(applied, {
        turnId,
        attemptId,
        userMessageId,
      });
    },
    startAttemptRound: (
      conversationId,
      attemptId,
      roundId,
      roundIndex,
    ) => {
      const before = state;
      dispatch({
        type: 'attempt/start-round',
        payload: {
          conversationId,
          attemptId,
          round: { roundId, roundIndex },
          at: canonicalNow(now),
        },
      });
      return state !== before;
    },
    recordAttemptRound: (conversationId, attemptId, receipt) => {
      const before = state;
      dispatch({
        type: 'attempt/record-round',
        payload: {
          conversationId,
          attemptId,
          receipt,
          at: canonicalNow(now),
        },
      });
      return state !== before;
    },
    completeAttempt: (
      conversationId,
      attemptId,
      text,
      appendOptions = {},
    ) => {
      const id = createId('message');
      const before = state;
      dispatch({
        type: 'attempt/complete',
        payload: {
          conversationId,
          attemptId,
          message: {
            id,
            role: 'assistant',
            text,
            createdAt: canonicalNow(now),
            attachments: appendOptions.attachments ?? [],
            ...(appendOptions.metadata === undefined
              ? {}
              : { metadata: appendOptions.metadata }),
          },
        },
      });
      return state === before ? null : id;
    },
    failAttempt: (conversationId, attemptId, failureCode) => {
      const before = state;
      dispatch({
        type: 'attempt/fail',
        payload: {
          conversationId,
          attemptId,
          failureCode,
          at: canonicalNow(now),
        },
      });
      return state !== before;
    },
    cancelAttempt: (conversationId, attemptId) => {
      const before = state;
      dispatch({
        type: 'attempt/cancel',
        payload: {
          conversationId,
          attemptId,
          at: canonicalNow(now),
        },
      });
      return state !== before;
    },
    retryAttempt: (conversationId, sourceAttemptId) => {
      const conversation = state.conversations[conversationId];
      const source = conversation?.attempts.find(
        attempt => attempt.attemptId === sourceAttemptId,
      );
      const turn = conversation?.turns.find(item => item.turnId === source?.turnId);
      if (conversation === undefined || source === undefined || turn === undefined) {
        return null;
      }
      const attemptId = createLifecycleId('attempt');
      if (!isCanonicalLifecycleId(attemptId)) return null;
      const at = canonicalNow(now);
      const attempt: TurnAttemptV1 = {
        ...source,
        attemptId,
        status: 'prepared',
        activeRound: null,
        rounds: [],
        assistantMessageId: null,
        failureCode: null,
        createdAt: at,
        updatedAt: at,
      };
      const applied = applyAction({
        type: 'attempt/retry',
        payload: { conversationId, sourceAttemptId, attempt },
      });
      return preparedTransaction(applied, {
        turnId: turn.turnId,
        attemptId,
        userMessageId: turn.userMessageId,
      });
    },
    serialize: () => serializeChatState(state),
    hydrate: input => {
      const next = hydrateChatState(input);
      if (next !== state) {
        state = next;
        notifyListeners();
      }
      return state;
    },
  };
}

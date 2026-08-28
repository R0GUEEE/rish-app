import {
  createProjectContextLifecycleController,
  type ProjectContextLifecycleController,
  type ProjectContextLifecycleControllerDependencies,
} from '../src/project-context/ProjectContextLifecycleController';
import type { SessionDurabilityResult } from '../src/completion/SessionPersistence';
import {
  createChatStore,
  hydrateChatState,
  type ChatStore,
  type ProjectContextDestructiveAction,
} from '../src/state';
import type {
  ProjectContextConsentV1,
  ProjectContextDiscardResultV1,
  ProjectContextManifestV1,
} from '../src/project-context';
import { ProjectContextBridgeError } from '../src/native/LocalProjectContext';

const NOW = '2026-08-29T01:00:00.000Z';
const RUNTIME_ID = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const CONSENT_ID = '33333333-3333-4333-8333-333333333333';
const PREPARATION_ID = '44444444-4444-4444-8444-444444444444';
const LIFECYCLE_ID = '55555555-5555-4555-8555-555555555555';
const PROJECT_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_PROJECT_ID = '77777777-7777-4777-8777-777777777777';
const DRIFT_PROJECT_ID = '88888888-8888-4888-8888-888888888888';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function readyStore(select = true): {
  readonly store: ChatStore;
  readonly conversationId: string;
} {
  let messageId = 0;
  const store = createChatStore({
    now: () => NOW,
    createId: kind => `${kind}-${++messageId}`,
    createLifecycleId: () => RUNTIME_ID,
  });
  const conversationId = store.createConversation({
    projectId: PROJECT_ID,
    select,
  });
  expect(store.ensureRuntimeContextId(conversationId)).toBe(RUNTIME_ID);
  const manifest: ProjectContextManifestV1 = {
    schema_version: 1,
    snapshot_id: SNAPSHOT_ID,
    project_id: PROJECT_ID,
    project_name: 'demo',
    branch: 'main',
    head_oid: 'a'.repeat(40),
    clean: true,
    conflicted: false,
    captured_at: NOW,
    policy_version: 'chat-read-v1.0.0',
    provider_host: 'api.deepseek.com',
    model: 'deepseek-v4-flash',
    included: [
      {
        path: 'README.md',
        source: 'tracked_file',
        bytes: 12,
        sha256: 'b'.repeat(64),
      },
    ],
    omitted: [],
    context_bytes: 12,
    estimated_tokens: 3,
    snapshot_sha256: 'c'.repeat(64),
    source_fingerprint: 'd'.repeat(64),
  };
  const consent: ProjectContextConsentV1 = {
    schema_version: 1,
    consent_receipt_id: CONSENT_ID,
    snapshot_id: SNAPSHOT_ID,
    snapshot_sha256: manifest.snapshot_sha256,
    confirmed_at: NOW,
  };
  const initial = store.getState().conversations[conversationId]!;
  const prepared = store.replaceProjectContextPrepared(
    {
      conversationId,
      projectId: PROJECT_ID,
      runtimeContextId: RUNTIME_ID,
      modelId: initial.modelId,
      expectedContext: initial.projectContext!,
    },
    {
      preparationId: PREPARATION_ID,
      selectedPaths: ['README.md'],
      manifest,
    },
  )!;
  expect(prepared.commit()).toBe(true);
  const pending = store.getState().conversations[conversationId]!;
  const confirmed = store.replaceProjectContextConfirmed(
    {
      conversationId,
      projectId: PROJECT_ID,
      runtimeContextId: RUNTIME_ID,
      modelId: pending.modelId,
      expectedContext: pending.projectContext!,
    },
    {
      preparationId: PREPARATION_ID,
      selectedPaths: ['README.md'],
      manifest,
      consent,
    },
  )!;
  expect(confirmed.commit()).toBe(true);
  return { store, conversationId };
}

type Fixture = {
  readonly controller: ProjectContextLifecycleController;
  readonly persistCurrent: jest.Mock<Promise<SessionDurabilityResult>, []>;
  readonly discard: jest.Mock<
    Promise<ProjectContextDiscardResultV1>,
    [unknown]
  >;
  readonly completionBlocked: jest.Mock<boolean, []>;
  readonly contextBlocked: jest.Mock<boolean, []>;
  readonly references: jest.Mock<readonly unknown[], [string, string]>;
  readonly order: string[];
};

function fixture(
  store: ChatStore,
  options: {
    readonly durability?: readonly SessionDurabilityResult[];
    readonly discard?: Fixture['discard'];
    readonly completionBlocked?: Fixture['completionBlocked'];
    readonly contextBlocked?: Fixture['contextBlocked'];
    readonly references?: Fixture['references'];
    readonly persistCurrent?: Fixture['persistCurrent'];
    readonly createLifecycleId?: () => string;
    readonly maximumPendingLifecycle?: number;
  } = {},
): Fixture {
  const durability = [...(options.durability ?? [])];
  const order: string[] = [];
  const persistCurrent =
    options.persistCurrent ??
    jest.fn(async () => {
      const transition = store.getState().projectContextDestructiveTransition;
      order.push(`persist:${transition?.phase ?? 'final'}`);
      return durability.shift() ?? { status: 'committed' as const };
    });
  const discard =
    options.discard ??
    jest.fn(async (snapshotId: unknown) => {
      order.push(`discard:${snapshotId}`);
      return { schema_version: 1 as const, status: 'discarded' as const };
    });
  const completionBlocked = options.completionBlocked ?? jest.fn(() => false);
  const contextBlocked = options.contextBlocked ?? jest.fn(() => false);
  const references =
    options.references ??
    jest.fn<readonly unknown[], [string, string]>(() => []);
  const dependencies: ProjectContextLifecycleControllerDependencies = {
    chat: store,
    native: { discard },
    persistCurrent,
    createLifecycleId: options.createLifecycleId ?? (() => LIFECYCLE_ID),
    completionMutationBlocked: completionBlocked,
    projectContextMutationBlocked: contextBlocked,
    snapshotReferences: references,
    maximumPendingLifecycle: (options.maximumPendingLifecycle ?? 1) as 1,
  };
  return {
    controller: createProjectContextLifecycleController(dependencies),
    persistCurrent,
    discard,
    completionBlocked,
    contextBlocked,
    references,
    order,
  };
}

async function begin(
  controller: ProjectContextLifecycleController,
  conversationId: string,
  action: ProjectContextDestructiveAction = 'unbind',
  targetProjectId: string | null = null,
) {
  const captured = controller.captureDestructiveBeginToken(
    conversationId,
    action,
    targetProjectId,
  );
  expect(captured.ok).toBe(true);
  if (!captured.ok) throw new Error(captured.code);
  return await controller.beginDestructiveTransition(captured.token);
}

describe('project context destructive lifecycle controller', () => {
  test('persists intent, tombstone, cleanup completion, and final state in exact order', async () => {
    const value = readyStore();
    const lifecycle = fixture(value.store);

    await expect(begin(lifecycle.controller, value.conversationId)).resolves.toEqual({
      status: 'completed',
      action: 'unbind',
    });
    expect(lifecycle.order).toEqual([
      'persist:intent',
      'persist:cleanup_pending',
      `discard:${SNAPSHOT_ID}`,
      'persist:ready_to_finalize',
      'persist:final',
    ]);
    expect(value.store.getState()).toMatchObject({
      projectContextDestructiveEpoch: 1,
      projectContextDestructiveTransition: null,
      conversations: {
        [value.conversationId]: { projectId: null, projectContext: null },
      },
    });
  });

  test('blocks all three external gates before creating or persisting an intent', async () => {
    const cases: Array<{
      readonly configure: (value: Fixture) => void;
      readonly code: string;
    }> = [
      {
        configure: value => value.completionBlocked.mockReturnValue(true),
        code: 'E_CONTEXT_TRANSITION_BUSY',
      },
      {
        configure: value => value.contextBlocked.mockReturnValue(true),
        code: 'E_CONTEXT_TRANSITION_BUSY',
      },
      {
        configure: value => value.references.mockReturnValue([{}]),
        code: 'E_CONTEXT_TRANSITION_REFERENCED',
      },
    ];
    for (const row of cases) {
      const value = readyStore();
      const lifecycle = fixture(value.store);
      const captured = lifecycle.controller.captureDestructiveBeginToken(
        value.conversationId,
        'unbind',
        null,
      );
      expect(captured.ok).toBe(true);
      if (!captured.ok) continue;
      row.configure(lifecycle);
      const before = value.store.getState();
      await expect(
        lifecycle.controller.beginDestructiveTransition(captured.token),
      ).resolves.toEqual({
        status: 'blocked',
        code: row.code,
      });
      expect(value.store.getState()).toBe(before);
      expect(lifecycle.persistCurrent).not.toHaveBeenCalled();
      expect(lifecycle.discard).not.toHaveBeenCalled();
    }
  });

  test('keeps a nonactive destructive target from changing presentation selection', async () => {
    const target = readyStore(false);
    const source = target.store.getState().conversations[target.conversationId]!;
    const selectedId = target.store.createConversation({ title: 'Selected' });
    target.store.selectConversation(selectedId);
    expect(source.projectContext?.snapshot?.snapshot_id).toBe(SNAPSHOT_ID);
    const lifecycle = fixture(target.store);

    await begin(lifecycle.controller, target.conversationId, 'delete');
    expect(target.store.getState().selectedConversationId).toBe(selectedId);
    expect(target.store.getState().conversations[target.conversationId]).toBeUndefined();
  });

  test.each([
    ['intent', 0, 'not_committed'],
    ['intent', 0, 'session_only'],
    ['intent', 0, 'unknown'],
    ['tombstone', 1, 'not_committed'],
    ['tombstone', 1, 'session_only'],
    ['tombstone', 1, 'unknown'],
    ['ready_to_finalize', 2, 'not_committed'],
    ['ready_to_finalize', 2, 'session_only'],
    ['ready_to_finalize', 2, 'unknown'],
    ['finalize', 3, 'not_committed'],
    ['finalize', 3, 'session_only'],
    ['finalize', 3, 'unknown'],
  ] as const)(
    'keeps %s durability %s crash-safe',
    async (stage, committedPrefix, durabilityStatus) => {
      const value = readyStore();
      const durability: SessionDurabilityResult[] = Array.from(
        { length: committedPrefix },
        () => ({ status: 'committed' as const }),
      );
      durability.push({ status: durabilityStatus });
      const lifecycle = fixture(value.store, { durability });

      const outcome = await begin(lifecycle.controller, value.conversationId);
      const transition =
        value.store.getState().projectContextDestructiveTransition;
      if (stage === 'intent' && durabilityStatus === 'not_committed') {
        expect(outcome).toEqual({
          status: 'blocked',
          code: 'E_CONTEXT_PERSISTENCE',
        });
        expect(transition).toBeNull();
        expect(lifecycle.controller.getState()).toMatchObject({
          phase: 'blocked',
          pendingPersistence: null,
          token: null,
        });
      } else {
        expect(outcome).toEqual({
          status: 'persistence_pending',
          code: 'E_CONTEXT_PERSISTENCE',
        });
        expect(lifecycle.controller.getState()).toMatchObject({
          pendingPersistence: stage,
          failureCode: 'E_CONTEXT_PERSISTENCE',
        });
        const expectedPhase =
          stage === 'intent'
            ? 'intent'
            : stage === 'tombstone'
              ? durabilityStatus === 'not_committed'
                ? 'intent'
                : 'cleanup_pending'
              : stage === 'ready_to_finalize' &&
                  durabilityStatus === 'not_committed'
                ? 'cleanup_pending'
                : 'ready_to_finalize';
        expect(transition?.phase).toBe(expectedPhase);
      }
      expect(lifecycle.discard).toHaveBeenCalledTimes(
        committedPrefix >= 2 ? 1 : 0,
      );
    },
  );

  test.each([
    ['intent', [{ status: 'session_only' as const }], 1],
    [
      'cleanup_pending',
      [
        { status: 'committed' as const },
        { status: 'session_only' as const },
      ],
      1,
    ],
    [
      'ready_to_finalize',
      [
        { status: 'committed' as const },
        { status: 'committed' as const },
        { status: 'session_only' as const },
      ],
      0,
    ],
  ] as const)(
    'resumes a durable %s checkpoint without replaying completed work',
    async (_phase, durability, expectedDiscardCalls) => {
      const value = readyStore();
      const first = fixture(value.store, { durability });
      await begin(first.controller, value.conversationId);
      const selectedBefore = value.store.getState().selectedConversationId;
      const restoredStore = createChatStore({
        initialState: hydrateChatState(value.store.serialize()),
        now: () => NOW,
      });
      const resumed = fixture(restoredStore);

      await expect(
        resumed.controller.reconcileDestructiveTransition(),
      ).resolves.toEqual({ status: 'completed', action: 'unbind' });
      expect(resumed.discard).toHaveBeenCalledTimes(expectedDiscardCalls);
      expect(restoredStore.getState().selectedConversationId).toBe(
        selectedBefore,
      );
      expect(restoredStore.getState().projectContextDestructiveTransition).toBeNull();
    },
  );

  test.each([
    ['intent', [{ status: 'session_only' as const }], 1],
    [
      'tombstone',
      [
        { status: 'committed' as const },
        { status: 'session_only' as const },
      ],
      1,
    ],
    [
      'ready_to_finalize',
      [
        { status: 'committed' as const },
        { status: 'committed' as const },
        { status: 'session_only' as const },
      ],
      1,
    ],
    [
      'finalize',
      [
        { status: 'committed' as const },
        { status: 'committed' as const },
        { status: 'committed' as const },
        { status: 'session_only' as const },
      ],
      1,
    ],
  ] as const)(
    'retries only the pending %s checkpoint and never replays completed cleanup',
    async (_stage, durability, expectedTotalDiscard) => {
      const value = readyStore();
      const lifecycle = fixture(value.store, { durability });
      await expect(
        begin(lifecycle.controller, value.conversationId),
      ).resolves.toMatchObject({ status: 'persistence_pending' });
      const beforeRetryDiscard = lifecycle.discard.mock.calls.length;
      const token = lifecycle.controller.getDestructiveToken();
      expect(token).not.toBeNull();

      await expect(
        lifecycle.controller.retryDestructivePersistence(token!),
      ).resolves.toEqual({ status: 'completed', action: 'unbind' });
      expect(lifecycle.discard).toHaveBeenCalledTimes(expectedTotalDiscard);
      if (_stage === 'ready_to_finalize' || _stage === 'finalize') {
        expect(lifecycle.discard).toHaveBeenCalledTimes(beforeRetryDiscard);
      }
    },
  );

  test('rechecks gates before every later checkpoint and resumes after the gate clears', async () => {
    const scenarios = [
      {
        label: 'after-intent',
        configure: (value: Fixture) => {
          value.persistCurrent.mockImplementationOnce(async () => {
            value.completionBlocked.mockReturnValue(true);
            return { status: 'committed' };
          });
        },
        phase: 'intent',
        discardCalls: 0,
        code: 'E_CONTEXT_TRANSITION_BUSY',
      },
      {
        label: 'after-tombstone',
        configure: (value: Fixture) => {
          value.persistCurrent
            .mockResolvedValueOnce({ status: 'committed' })
            .mockImplementationOnce(async () => {
              value.contextBlocked.mockReturnValue(true);
              return { status: 'committed' };
            });
        },
        phase: 'cleanup_pending',
        discardCalls: 0,
        code: 'E_CONTEXT_TRANSITION_BUSY',
      },
      {
        label: 'after-discard',
        configure: (value: Fixture) => {
          value.discard.mockImplementationOnce(async () => {
            value.references.mockReturnValue([{}]);
            return { schema_version: 1, status: 'discarded' };
          });
        },
        phase: 'cleanup_pending',
        discardCalls: 1,
        code: 'E_CONTEXT_TRANSITION_REFERENCED',
      },
      {
        label: 'after-ready',
        configure: (value: Fixture) => {
          value.persistCurrent
            .mockResolvedValueOnce({ status: 'committed' })
            .mockResolvedValueOnce({ status: 'committed' })
            .mockImplementationOnce(async () => {
              value.completionBlocked.mockReturnValue(true);
              return { status: 'committed' };
            });
        },
        phase: 'ready_to_finalize',
        discardCalls: 1,
        code: 'E_CONTEXT_TRANSITION_BUSY',
      },
    ] as const;

    for (const scenario of scenarios) {
      const value = readyStore();
      const lifecycle = fixture(value.store);
      scenario.configure(lifecycle);
      const outcome = await begin(lifecycle.controller, value.conversationId);
      expect(outcome).toEqual({
        status: 'blocked',
        code: scenario.code,
      });
      expect(
        value.store.getState().projectContextDestructiveTransition?.phase,
      ).toBe(scenario.phase);
      expect(lifecycle.discard).toHaveBeenCalledTimes(scenario.discardCalls);
      lifecycle.completionBlocked.mockReturnValue(false);
      lifecycle.contextBlocked.mockReturnValue(false);
      lifecycle.references.mockReturnValue([]);
      await expect(
        lifecycle.controller.reconcileDestructiveTransition(),
      ).resolves.toEqual({ status: 'completed', action: 'unbind' });
    }
  });

  test('keeps cleanup retryable on native failure and treats missing as idempotent success', async () => {
    const value = readyStore();
    const discard = jest
      .fn<Promise<ProjectContextDiscardResultV1>, [unknown]>()
      .mockRejectedValueOnce(new ProjectContextBridgeError('E_CONTEXT_STORAGE'))
      .mockResolvedValueOnce({ schema_version: 1, status: 'discarded' });
    const lifecycle = fixture(value.store, { discard });

    await expect(begin(lifecycle.controller, value.conversationId)).resolves.toEqual({
      status: 'cleanup_pending',
      code: 'E_CONTEXT_STORAGE',
    });
    const retryToken = lifecycle.controller.getDestructiveToken()!;
    await expect(
      lifecycle.controller.retryDestructiveCleanup(retryToken),
    ).resolves.toEqual({ status: 'completed', action: 'unbind' });
    expect(discard).toHaveBeenCalledTimes(2);

    const missingValue = readyStore();
    const missing = fixture(missingValue.store, {
      discard: jest
        .fn<Promise<ProjectContextDiscardResultV1>, [unknown]>()
        .mockRejectedValue(
          new ProjectContextBridgeError('E_CONTEXT_SNAPSHOT_MISSING'),
        ),
    });
    await expect(begin(missing.controller, missingValue.conversationId)).resolves.toEqual({
      status: 'completed',
      action: 'unbind',
    });
  });

  test('serializes duplicate operations and rejects stale retry generations', async () => {
    const value = readyStore();
    const pending = deferred<SessionDurabilityResult>();
    const persistCurrent = jest
      .fn<Promise<SessionDurabilityResult>, []>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ status: 'committed' });
    const lifecycle = fixture(value.store, { persistCurrent });
    const captured = lifecycle.controller.captureDestructiveBeginToken(
      value.conversationId,
      'unbind',
      null,
    );
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const first = lifecycle.controller.beginDestructiveTransition(
      captured.token,
    );
    const stale = lifecycle.controller.getDestructiveToken();
    await expect(
      lifecycle.controller.beginDestructiveTransition(captured.token),
    ).resolves.toEqual({
      status: 'blocked',
      code: 'E_CONTEXT_TRANSITION_BUSY',
    });
    expect(persistCurrent).toHaveBeenCalledTimes(1);
    pending.resolve({ status: 'session_only' });
    await first;
    expect(stale).not.toBeNull();
    await expect(
      lifecycle.controller.retryDestructivePersistence(stale!),
    ).resolves.toEqual({
      status: 'blocked',
      code: 'E_CONTEXT_TRANSITION_CONFLICT',
    });
    expect(persistCurrent).toHaveBeenCalledTimes(1);
  });

  test('rechecks global gates before retrying a pending persistence checkpoint', async () => {
    const value = readyStore();
    const lifecycle = fixture(value.store, {
      durability: [{ status: 'session_only' }],
    });
    await begin(lifecycle.controller, value.conversationId);
    const token = lifecycle.controller.getDestructiveToken()!;
    const callsBefore = lifecycle.persistCurrent.mock.calls.length;
    lifecycle.contextBlocked.mockReturnValue(true);

    await expect(
      lifecycle.controller.retryDestructivePersistence(token),
    ).resolves.toEqual({
      status: 'blocked',
      code: 'E_CONTEXT_TRANSITION_BUSY',
    });
    expect(lifecycle.persistCurrent).toHaveBeenCalledTimes(callsBefore);
    expect(value.store.getState().projectContextDestructiveTransition?.phase).toBe(
      'intent',
    );
  });

  test('fails closed for hostile native errors and malformed hydrated journals', async () => {
    const value = readyStore();
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('RAW_NATIVE_SENTINEL');
        },
      },
    );
    const lifecycle = fixture(value.store, {
      discard: jest
        .fn<Promise<ProjectContextDiscardResultV1>, [unknown]>()
        .mockRejectedValue(hostile),
    });
    const outcome = await begin(lifecycle.controller, value.conversationId);
    expect(outcome).toEqual({
      status: 'cleanup_pending',
      code: 'E_CONTEXT_NATIVE',
    });
    expect(JSON.stringify(lifecycle.controller.getState())).not.toContain(
      'SENTINEL',
    );

    const malformedValue = readyStore();
    const current = malformedValue.store.getState();
    const conversation = current.conversations[malformedValue.conversationId]!;
    const malformedStore = createChatStore({
      initialState: {
        ...current,
        projectContextDestructiveEpoch: 1,
        projectContextDestructiveTransition: {
          schemaVersion: 1,
          lifecycleId: LIFECYCLE_ID,
          epoch: 1,
          action: 'rebind',
          phase: 'cleanup_pending',
          conversationId: malformedValue.conversationId,
          sourceProjectId: PROJECT_ID,
          sourceRuntimeContextId: RUNTIME_ID,
          sourceModelId: conversation.modelId,
          snapshotId: SNAPSHOT_ID,
          snapshotSha256: 'c'.repeat(64),
          consentReceiptId: CONSENT_ID,
          targetProjectId: PROJECT_ID,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    });
    const malformed = fixture(malformedStore);
    await expect(
      malformed.controller.reconcileDestructiveTransition(),
    ).resolves.toEqual({
      status: 'blocked',
      code: 'E_CONTEXT_TRANSITION_UNKNOWN',
    });
    expect(malformed.persistCurrent).not.toHaveBeenCalled();
    expect(malformed.discard).not.toHaveBeenCalled();
  });

  test('rejects action drift introduced after cleanup without finalizing the drifted action', async () => {
    const value = readyStore();
    const discard = jest.fn<
      Promise<ProjectContextDiscardResultV1>,
      [unknown]
    >(async () => {
      const transition = value.store.getState()
        .projectContextDestructiveTransition as unknown as {
        action: ProjectContextDestructiveAction;
      };
      transition.action = 'delete';
      return { schema_version: 1, status: 'discarded' };
    });
    const lifecycle = fixture(value.store, { discard });

    await expect(begin(lifecycle.controller, value.conversationId)).resolves.toEqual({
      status: 'blocked',
      code: 'E_CONTEXT_TRANSITION_CONFLICT',
    });
    expect(value.store.getState().conversations[value.conversationId]).toBeDefined();
    expect(lifecycle.persistCurrent).toHaveBeenCalledTimes(2);
  });

  test('rejects a valid rebind-target drift introduced after cleanup', async () => {
    const value = readyStore();
    const discard = jest.fn<
      Promise<ProjectContextDiscardResultV1>,
      [unknown]
    >(async () => {
      const transition = value.store.getState()
        .projectContextDestructiveTransition as unknown as {
        targetProjectId: string | null;
      };
      transition.targetProjectId = DRIFT_PROJECT_ID;
      return { schema_version: 1, status: 'discarded' };
    });
    const lifecycle = fixture(value.store, { discard });

    await expect(
      begin(
        lifecycle.controller,
        value.conversationId,
        'rebind',
        OTHER_PROJECT_ID,
      ),
    ).resolves.toEqual({
      status: 'blocked',
      code: 'E_CONTEXT_TRANSITION_CONFLICT',
    });
    expect(
      value.store.getState().conversations[value.conversationId]?.projectId,
    ).toBe(PROJECT_ID);
    expect(lifecycle.persistCurrent).toHaveBeenCalledTimes(2);
  });

  test('rejects drifted capture tokens and invalid lifecycle identity with zero persistence', async () => {
    const value = readyStore();
    const lifecycle = fixture(value.store);
    const captured = lifecycle.controller.captureDestructiveBeginToken(
      value.conversationId,
      'unbind',
      null,
    );
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    value.store.setModel(value.conversationId, 'deepseek-v4-pro');
    await expect(
      lifecycle.controller.beginDestructiveTransition(captured.token),
    ).resolves.toEqual({
      status: 'blocked',
      code: 'E_CONTEXT_TRANSITION_CONFLICT',
    });
    expect(lifecycle.persistCurrent).not.toHaveBeenCalled();

    const invalidValue = readyStore();
    const invalid = fixture(invalidValue.store, {
      createLifecycleId: () => 'not-a-uuid',
    });
    await expect(begin(invalid.controller, invalidValue.conversationId)).resolves.toEqual({
      status: 'blocked',
      code: 'E_CONTEXT_TRANSITION_INVALID',
    });
    expect(invalid.persistCurrent).not.toHaveBeenCalled();

    const collisionValue = readyStore();
    const collision = fixture(collisionValue.store, {
      createLifecycleId: () => RUNTIME_ID,
    });
    await expect(
      begin(collision.controller, collisionValue.conversationId),
    ).resolves.toEqual({
      status: 'blocked',
      code: 'E_CONTEXT_TRANSITION_CONFLICT',
    });
    expect(collision.persistCurrent).not.toHaveBeenCalled();

    const boundedValue = readyStore();
    const bounded = fixture(boundedValue.store, {
      maximumPendingLifecycle: 2,
    });
    expect(
      bounded.controller.captureDestructiveBeginToken(
        boundedValue.conversationId,
        'unbind',
        null,
      ),
    ).toEqual({ ok: false, code: 'E_CONTEXT_TRANSITION_BUSY' });
    expect(
      bounded.controller.captureDestructiveBeginToken(
        boundedValue.conversationId,
        'rebind',
        PROJECT_ID,
      ),
    ).toEqual({ ok: false, code: 'E_CONTEXT_TRANSITION_BUSY' });

    const targetValue = readyStore();
    const target = fixture(targetValue.store);
    expect(
      target.controller.captureDestructiveBeginToken(
        targetValue.conversationId,
        'rebind',
        PROJECT_ID,
      ),
    ).toEqual({ ok: false, code: 'E_CONTEXT_TRANSITION_INVALID' });
  });

  test('projects data-only begin tokens without evaluating proxy getters and rejects descriptor traps', async () => {
    const value = readyStore();
    const lifecycle = fixture(value.store);
    const captured = lifecycle.controller.captureDestructiveBeginToken(
      value.conversationId,
      'unbind',
      null,
    );
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    let getterCalls = 0;
    const hostile = new Proxy(
      { ...captured.token },
      {
        get: () => {
          getterCalls += 1;
          throw new Error('RAW_BEGIN_TOKEN_SENTINEL');
        },
      },
    );

    await expect(
      lifecycle.controller.beginDestructiveTransition(hostile),
    ).resolves.toEqual({
      status: 'completed',
      action: 'unbind',
    });
    expect(getterCalls).toBe(0);

    const blockedValue = readyStore();
    const blockedLifecycle = fixture(blockedValue.store);
    const blockedCaptured =
      blockedLifecycle.controller.captureDestructiveBeginToken(
        blockedValue.conversationId,
        'unbind',
        null,
      );
    expect(blockedCaptured.ok).toBe(true);
    if (!blockedCaptured.ok) return;
    const descriptorHostile = new Proxy(
      { ...blockedCaptured.token },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('RAW_DESCRIPTOR_SENTINEL');
        },
      },
    );
    const before = blockedValue.store.getState();
    await expect(
      blockedLifecycle.controller.beginDestructiveTransition(
        descriptorHostile,
      ),
    ).resolves.toEqual({
      status: 'blocked',
      code: 'E_CONTEXT_TRANSITION_INVALID',
    });
    expect(blockedValue.store.getState()).toBe(before);
    expect(blockedLifecycle.persistCurrent).not.toHaveBeenCalled();
    expect(blockedLifecycle.discard).not.toHaveBeenCalled();
  });

  test('rechecks all gates after listener notification immediately before journal creation', async () => {
    const value = readyStore();
    const lifecycle = fixture(value.store);
    const captured = lifecycle.controller.captureDestructiveBeginToken(
      value.conversationId,
      'unbind',
      null,
    );
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    lifecycle.controller.subscribe(next => {
      if (next.phase === 'resuming') {
        lifecycle.contextBlocked.mockReturnValue(true);
      }
    });

    await expect(
      lifecycle.controller.beginDestructiveTransition(captured.token),
    ).resolves.toEqual({
      status: 'blocked',
      code: 'E_CONTEXT_TRANSITION_BUSY',
    });
    expect(value.store.getState().projectContextDestructiveTransition).toBeNull();
    expect(lifecycle.persistCurrent).not.toHaveBeenCalled();
    expect(lifecycle.discard).not.toHaveBeenCalled();
  });
});

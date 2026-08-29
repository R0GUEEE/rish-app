import {
  createCompletionController,
  type CompletionController,
} from '../src/completion/CompletionController';
import type {
  CompleteRoundV2Request,
  CompleteRoundV2Result,
  CompleteRoundV3Request,
  CompleteRoundV3Result,
} from '../src/completion/types';
import type { SessionDurabilityResult } from '../src/completion/SessionPersistence';
import {
  createChatStore,
  hydrateChatState,
  type ChatStore,
} from '../src/state';
import type {
  ProjectContextConsentV1,
  ProjectContextManifestV1,
} from '../src/project-context';

const NOW = '2026-08-28T01:00:00.000Z';
const LATER = '2026-08-28T01:00:01.000Z';
const TURN_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const RETRY_ID = '33333333-3333-4333-8333-333333333333';
const ROUND_ID = '44444444-4444-4444-8444-444444444444';
const RUNTIME_ID = '55555555-5555-4555-8555-555555555555';
const SNAPSHOT_ID = '66666666-6666-4666-8666-666666666666';
const CONSENT_ID = '77777777-7777-4777-8777-777777777777';
const PROJECT_ID = '88888888-8888-4888-8888-888888888888';
const PROVIDER_REQUEST_ID = '99999999-9999-4999-8999-999999999999';
const CONTEXT_PREPARATION_ID =
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function storeWithIds(ids = [TURN_ID, ATTEMPT_ID, RETRY_ID]): ChatStore {
  let message = 0;
  const queue = [...ids];
  return createChatStore({
    now: () => NOW,
    createId: kind => `${kind}-${++message}`,
    createLifecycleId: () => queue.shift() ?? RETRY_ID,
  });
}

function v2Result(request: CompleteRoundV2Request): CompleteRoundV2Result {
  return {
    schema_version: 2,
    turn_id: request.turnId,
    attempt_id: request.attemptId,
    round_id: request.roundId,
    round_index: request.roundIndex,
    provider_request_id: PROVIDER_REQUEST_ID,
    provider_response_id: 'resp_1',
    requested_model: request.model,
    model: request.model,
    thinking_mode: request.thinkingMode,
    text: 'Strict local answer',
    reasoning: 'actual reasoning',
    tool_calls: [],
    finish_reason: 'stop',
    latency_ms: 12,
    visible_history_sha256: 'a'.repeat(64),
    model_input_sha256: 'b'.repeat(64),
    request_body_sha256: 'c'.repeat(64),
    project_context_receipt: null,
  };
}

function v3Result(request: CompleteRoundV3Request): CompleteRoundV3Result {
  return {
    ...v2Result({ ...request, schemaVersion: 2, projectContext: null }),
    schema_version: 3,
    project_context_receipt: {
      schema_version: 1,
      snapshot_id: SNAPSHOT_ID,
      snapshot_sha256: 'd'.repeat(64),
      source_fingerprint: 'e'.repeat(64),
      context_bytes: 20,
      verified_at: LATER,
    },
  };
}

type Fixture = {
  readonly store: ChatStore;
  readonly controller: CompletionController;
  readonly persistCurrent: jest.Mock<Promise<SessionDurabilityResult>, []>;
  readonly completeRoundV2: jest.Mock<
    Promise<CompleteRoundV2Result>,
    [CompleteRoundV2Request]
  >;
  readonly completeRoundV3: jest.Mock<
    Promise<CompleteRoundV3Result>,
    [CompleteRoundV3Request]
  >;
  readonly cancelRoundV2: jest.Mock;
  readonly cancelRoundV3: jest.Mock;
  readonly createRoundId: jest.Mock<string, []>;
  readonly onSessionEvent: jest.Mock;
};

function fixture(options: {
  store?: ChatStore;
  durability?: SessionDurabilityResult[];
  persistCurrent?: Fixture['persistCurrent'];
  completeRoundV2?: Fixture['completeRoundV2'];
  completeRoundV3?: Fixture['completeRoundV3'];
  cancelRoundV2?: Fixture['cancelRoundV2'];
  cancelRoundV3?: Fixture['cancelRoundV3'];
  createRoundId?: Fixture['createRoundId'];
  onSessionEvent?: Fixture['onSessionEvent'];
} = {}): Fixture {
  const store = options.store ?? storeWithIds();
  const durability = options.durability ?? [
    { status: 'committed' },
    { status: 'committed' },
    { status: 'committed' },
  ];
  const persistCurrent =
    options.persistCurrent ??
    jest.fn(async () =>
      durability.shift() ?? { status: 'committed' as const },
    );
  const completeRoundV2 =
    options.completeRoundV2 ?? jest.fn(async request => v2Result(request));
  const completeRoundV3 =
    options.completeRoundV3 ?? jest.fn(async request => v3Result(request));
  const cancelRoundV2 =
    options.cancelRoundV2 ?? jest.fn(async () => undefined);
  const cancelRoundV3 =
    options.cancelRoundV3 ?? jest.fn(async () => undefined);
  const createRoundId = options.createRoundId ?? jest.fn(() => ROUND_ID);
  const onSessionEvent =
    options.onSessionEvent ?? jest.fn();
  const controller = createCompletionController({
    chat: store,
    persistCurrent,
    completeRoundV2,
    completeRoundV3,
    cancelRoundV2,
    cancelRoundV3,
    createRoundId,
    onSessionEvent,
  });
  return {
    store,
    controller,
    persistCurrent,
    completeRoundV2,
    completeRoundV3,
    cancelRoundV2,
    cancelRoundV3,
    createRoundId,
    onSessionEvent,
  };
}

function commitDestructiveJournal(store: ChatStore) {
  const conversation = Object.values(store.getState().conversations).find(
    candidate => candidate.projectContext?.snapshot !== null,
  )!;
  const transaction = store.beginProjectContextDestructiveTransition({
    lifecycleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    action: 'unbind',
    targetProjectId: null,
    owner: {
      conversationId: conversation.id,
      projectId: conversation.projectId!,
      runtimeContextId: conversation.runtimeContextId,
      modelId: conversation.modelId,
      expectedUpdatedAt: conversation.updatedAt,
      expectedContext: conversation.projectContext!,
    },
  });
  expect(transaction).not.toBeNull();
  expect(transaction!.commit()).toBe(true);
}

function readyProjectStore(): ChatStore {
  const store = storeWithIds([RUNTIME_ID, TURN_ID, ATTEMPT_ID, RETRY_ID]);
  const conversationId = store.createConversation({ projectId: PROJECT_ID });
  const manifest: ProjectContextManifestV1 = {
    schema_version: 1,
    snapshot_id: SNAPSHOT_ID,
    project_id: PROJECT_ID,
    project_name: 'demo',
    branch: 'main',
    head_oid: '0'.repeat(40),
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
        bytes: 20,
        sha256: 'f'.repeat(64),
      },
    ],
    omitted: [],
    context_bytes: 20,
    estimated_tokens: 5,
    snapshot_sha256: 'd'.repeat(64),
    source_fingerprint: 'e'.repeat(64),
  };
  const consent: ProjectContextConsentV1 = {
    schema_version: 1,
    consent_receipt_id: CONSENT_ID,
    snapshot_id: SNAPSHOT_ID,
    snapshot_sha256: 'd'.repeat(64),
    confirmed_at: LATER,
  };
  expect(store.ensureRuntimeContextId(conversationId)).toBe(RUNTIME_ID);
  const preparedConversation = store.getState().conversations[conversationId]!;
  const prepared = store.replaceProjectContextPrepared(
    {
      conversationId,
      projectId: PROJECT_ID,
      runtimeContextId: RUNTIME_ID,
      modelId: preparedConversation.modelId,
      expectedContext: preparedConversation.projectContext!,
    },
    {
      preparationId: CONTEXT_PREPARATION_ID,
      selectedPaths: ['README.md'],
      manifest,
    },
  );
  expect(prepared).not.toBeNull();
  expect(prepared!.commit()).toBe(true);

  const confirmedConversation = store.getState().conversations[conversationId]!;
  const confirmed = store.replaceProjectContextConfirmed(
    {
      conversationId,
      projectId: PROJECT_ID,
      runtimeContextId: RUNTIME_ID,
      modelId: confirmedConversation.modelId,
      expectedContext: confirmedConversation.projectContext!,
    },
    {
      preparationId: CONTEXT_PREPARATION_ID,
      selectedPaths: ['README.md'],
      manifest,
      consent,
    },
  );
  expect(confirmed).not.toBeNull();
  expect(confirmed!.commit()).toBe(true);
  return store;
}

describe('transactional completion controller', () => {
  test.each(['send', 'retry', 'resume'] as const)(
    'reverse-gates %s while a destructive journal exists with zero side effects',
    async operation => {
      const store = readyProjectStore();
      const conversationId = store.createConversation();
      let attemptId: string | null = null;
      if (operation !== 'send') {
        const prepared = store.prepareTurnAttempt(conversationId, operation)!;
        expect(prepared.commit()).toBe(true);
        attemptId = prepared.attemptId;
        if (operation === 'retry') {
          expect(
            store.failAttempt(
              conversationId,
              attemptId,
              'E_COMPLETION_NATIVE',
            ),
          ).toBe(true);
        }
      }
      commitDestructiveJournal(store);
      const value = fixture({ store });
      const beforeChat = store.getState();
      const beforeController = value.controller.getState();
      const events = {
        onPreparedDurable: jest.fn(),
        onCommitted: jest.fn(),
      };

      const outcome =
        operation === 'send'
          ? await value.controller.send(
              { conversationId, text: 'blocked', attachments: [] },
              events,
            )
          : operation === 'retry'
            ? await value.controller.retry(conversationId, attemptId!, events)
            : await value.controller.resume(conversationId, attemptId!, events);

      expect(outcome).toMatchObject({
        status: 'blocked',
        code: 'E_COMPLETION_BUSY',
      });
      expect(store.getState()).toBe(beforeChat);
      expect(value.controller.getState()).toBe(beforeController);
      expect(value.persistCurrent).not.toHaveBeenCalled();
      expect(value.completeRoundV2).not.toHaveBeenCalled();
      expect(value.completeRoundV3).not.toHaveBeenCalled();
      expect(value.cancelRoundV2).not.toHaveBeenCalled();
      expect(value.cancelRoundV3).not.toHaveBeenCalled();
      expect(value.createRoundId).not.toHaveBeenCalled();
      expect(events.onPreparedDurable).not.toHaveBeenCalled();
      expect(events.onCommitted).not.toHaveBeenCalled();
    },
  );

  test('reverse-gates every remaining public completion action without reading hostile input', async () => {
    const store = readyProjectStore();
    commitDestructiveJournal(store);
    const value = fixture({ store });
    const before = value.controller.getState();
    const hostileInput = new Proxy(
      {},
      {
        get: () => {
          throw new Error('RAW_INPUT_SENTINEL');
        },
      },
    ) as Parameters<CompletionController['send']>[0];

    await expect(value.controller.send(hostileInput)).resolves.toMatchObject({
      status: 'blocked',
      code: 'E_COMPLETION_BUSY',
    });
    await expect(value.controller.retryPersistence()).resolves.toMatchObject({
      status: 'blocked',
      code: 'E_COMPLETION_BUSY',
    });
    await expect(value.controller.retryCommit()).resolves.toMatchObject({
      status: 'blocked',
      code: 'E_COMPLETION_BUSY',
    });
    await expect(value.controller.cancel()).resolves.toBeUndefined();
    await expect(
      value.controller.beforeConversationChange('hostile-conversation'),
    ).resolves.toBe(false);
    await expect(
      value.controller.beforeConversationDelete('hostile-conversation'),
    ).resolves.toBe(false);
    expect(
      value.controller.reconcileHydrated('hostile-conversation'),
    ).toBe(before);

    expect(value.controller.getState()).toBe(before);
    expect(store.getState().projectContextDestructiveTransition).not.toBeNull();
    expect(value.persistCurrent).not.toHaveBeenCalled();
    expect(value.completeRoundV2).not.toHaveBeenCalled();
    expect(value.completeRoundV3).not.toHaveBeenCalled();
    expect(value.cancelRoundV2).not.toHaveBeenCalled();
    expect(value.cancelRoundV3).not.toHaveBeenCalled();
    expect(value.createRoundId).not.toHaveBeenCalled();
  });

  test('runs an unbound turn through exact schema2 durability boundaries', async () => {
    const value = fixture();
    const conversationId = value.store.createConversation();
    const onPreparedDurable = jest.fn();
    const onCommitted = jest.fn();
    const outcome = await value.controller.send(
      { conversationId, text: 'hello', attachments: [] },
      { onPreparedDurable, onCommitted },
    );

    expect(outcome).toMatchObject({ status: 'completed', attemptId: ATTEMPT_ID });
    expect(value.persistCurrent).toHaveBeenCalledTimes(3);
    expect(onPreparedDurable).toHaveBeenCalledTimes(1);
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(value.completeRoundV2).toHaveBeenCalledWith({
      schemaVersion: 2,
      turnId: TURN_ID,
      attemptId: ATTEMPT_ID,
      roundId: ROUND_ID,
      roundIndex: 0,
      model: 'deepseek-v4-flash',
      thinkingMode: 'high',
      visibleHistory: [
        { role: 'user', content: 'hello', attachments: [] },
      ],
      roundTranscript: [],
      tools: [],
      projectContext: null,
    });
    expect(
      value.store.getState().conversations[conversationId]?.attempts[0],
    ).toMatchObject({
      status: 'completed',
      visibleHistorySha256: 'a'.repeat(64),
      rounds: [{ transportSchemaVersion: 2 }],
    });
  });

  test('uses schema3 only for an exact verified project binding', async () => {
    const store = readyProjectStore();
    const value = fixture({ store });
    const conversationId = store.getState().selectedConversationId!;
    await value.controller.send({
      conversationId,
      text: 'read project',
      attachments: [],
    });
    expect(value.completeRoundV2).not.toHaveBeenCalled();
    expect(value.completeRoundV3).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 3,
        projectContext: {
          schemaVersion: 1,
          snapshotId: SNAPSHOT_ID,
          consentReceiptId: CONSENT_ID,
          conversationId: RUNTIME_ID,
          projectId: PROJECT_ID,
          provider: 'deepseek',
          policy: 'chat-read-v1',
        },
      }),
    );
  });

  test('uses explicit schema2 without-context for a verified project', async () => {
    const store = readyProjectStore();
    const value = fixture({ store });
    const conversationId = store.getState().selectedConversationId!;

    await value.controller.send({
      conversationId,
      text: 'explicitly omit context',
      attachments: [],
      sendWithoutProjectContext: true,
    });
    expect(value.completeRoundV2).toHaveBeenCalledWith(
      expect.objectContaining({ schemaVersion: 2, projectContext: null }),
    );
    expect(value.completeRoundV3).not.toHaveBeenCalled();
  });

  test('cancels a verified schema3 round through the schema3 alias', async () => {
    const pending = deferred<CompleteRoundV3Result>();
    const store = readyProjectStore();
    const value = fixture({
      store,
      completeRoundV3: jest.fn(
        (_request: CompleteRoundV3Request) => pending.promise,
      ),
    });
    const conversationId = store.getState().selectedConversationId!;
    const run = value.controller.send({
      conversationId,
      text: 'cancel verified context',
      attachments: [],
    });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    await value.controller.cancel();
    expect(value.cancelRoundV3).toHaveBeenCalledWith(ROUND_ID);
    expect(value.cancelRoundV2).not.toHaveBeenCalled();
    pending.resolve(v3Result(value.completeRoundV3.mock.calls[0]![0]));
    await expect(run).resolves.toMatchObject({ status: 'cancelled' });
  });

  test.each([
    {
      name: 'tool calls',
      result: (request: CompleteRoundV2Request): CompleteRoundV2Result => ({
        ...v2Result(request),
        text: '',
        tool_calls: [
          { id: 'call_1', name: 'read_file', arguments: '{}' },
        ],
        finish_reason: 'tool_calls',
      }),
    },
    {
      name: 'content filtering',
      result: (request: CompleteRoundV2Request): CompleteRoundV2Result => ({
        ...v2Result(request),
        text: 'provider filtered response',
        finish_reason: 'content_filter',
      }),
    },
  ])('records the terminal receipt but stores no assistant for $name', async ({
    result,
  }) => {
    const value = fixture({
      completeRoundV2: jest.fn(async request => result(request)),
    });
    const conversationId = value.store.createConversation();

    await expect(
      value.controller.send({
        conversationId,
        text: 'terminal relation',
        attachments: [],
      }),
    ).resolves.toMatchObject({
      status: 'retryable',
      code: 'E_COMPLETION_FINISH_RELATION',
    });
    const conversation = value.store.getState().conversations[conversationId]!;
    expect(conversation.attempts[0]).toMatchObject({
      status: 'failed',
      rounds: [{ finishReason: expect.any(String) }],
      assistantMessageId: null,
    });
    expect(conversation.messages.map(message => message.role)).toEqual(['user']);
  });

  test.each([
    {
      name: 'allowlisted native error',
      error: { code: 'E_COMPLETION_TRANSPORT', message: 'PROVIDER_SECRET' },
      expected: 'E_COMPLETION_TRANSPORT',
    },
    {
      name: 'unknown native error',
      error: { code: 'E_PROVIDER_KEY_SECRET', message: 'PROVIDER_SECRET' },
      expected: 'E_COMPLETION_NATIVE',
    },
    {
      name: 'hostile native error',
      error: new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error('PROVIDER_SECRET');
          },
        },
      ),
      expected: 'E_COMPLETION_NATIVE',
    },
  ])('maps $name to a stable value-free code', async ({ error, expected }) => {
    const value = fixture({
      completeRoundV2: jest.fn(
        async (
          _request: CompleteRoundV2Request,
        ): Promise<CompleteRoundV2Result> => {
        throw error;
        },
      ),
    });
    const conversationId = value.store.createConversation();

    await expect(
      value.controller.send({
        conversationId,
        text: 'sanitize failure',
        attachments: [],
      }),
    ).resolves.toMatchObject({ status: 'retryable', code: expected });
    expect(
      value.store.getState().conversations[conversationId]?.attempts[0]
        ?.failureCode,
    ).toBe(expected);
  });

  test('records and completes synchronously before the single final persist', async () => {
    const base = storeWithIds();
    let persisted: Fixture['persistCurrent'] | null = null;
    const order: Array<readonly [string, number]> = [];
    const chat: ChatStore = {
      ...base,
      recordAttemptRound: (conversationId, attemptId, roundReceipt) => {
        order.push(['record', persisted?.mock.calls.length ?? -1]);
        return base.recordAttemptRound(
          conversationId,
          attemptId,
          roundReceipt,
        );
      },
      completeAttempt: (conversationId, attemptId, text, options) => {
        order.push(['complete', persisted?.mock.calls.length ?? -1]);
        return base.completeAttempt(conversationId, attemptId, text, options);
      },
    };
    const value = fixture({ store: chat });
    persisted = value.persistCurrent;
    const conversationId = chat.createConversation();

    await value.controller.send({
      conversationId,
      text: 'ordered outcome',
      attachments: [],
    });
    expect(order).toEqual([
      ['record', 2],
      ['complete', 2],
    ]);
    expect(value.persistCurrent).toHaveBeenCalledTimes(3);
  });

  test('blocks setup-required projects while preserving explicit schema2 API', async () => {
    const store = storeWithIds();
    const conversationId = store.createConversation({ projectId: PROJECT_ID });
    const value = fixture({ store });
    await expect(
      value.controller.send({ conversationId, text: 'blocked', attachments: [] }),
    ).resolves.toMatchObject({
      status: 'blocked',
      code: 'E_ATTEMPT_CONTEXT_REQUIRED',
    });
    expect(value.persistCurrent).not.toHaveBeenCalled();
    expect(value.completeRoundV2).not.toHaveBeenCalled();

    await expect(
      value.controller.send({
        conversationId,
        text: 'explicit',
        attachments: [],
        sendWithoutProjectContext: true,
      }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(value.completeRoundV2).toHaveBeenCalledTimes(1);
  });

  test.each(['session_only', 'unknown'] as const)(
    'holds %s preparation without HTTP until retryPersistence commits',
    async status => {
      const value = fixture({
        durability: [
          { status },
          { status: 'committed' },
          { status: 'committed' },
          { status: 'committed' },
        ],
      });
      const conversationId = value.store.createConversation();
      const onPreparedDurable = jest.fn();
      await expect(
        value.controller.send(
          { conversationId, text: 'pending', attachments: [] },
          { onPreparedDurable },
        ),
      ).resolves.toMatchObject({ status: 'persistence_pending' });
      expect(value.completeRoundV2).not.toHaveBeenCalled();
      expect(onPreparedDurable).not.toHaveBeenCalled();

      await expect(value.controller.retryPersistence()).resolves.toMatchObject({
        status: 'completed',
      });
      expect(onPreparedDurable).toHaveBeenCalledTimes(1);
      expect(value.completeRoundV2).toHaveBeenCalledTimes(1);
    },
  );

  test('rolls back not-committed preparation and never calls HTTP', async () => {
    const value = fixture({ durability: [{ status: 'not_committed' }] });
    const conversationId = value.store.createConversation();
    const before = value.store.getState();
    const onPreparedDurable = jest.fn();
    await expect(
      value.controller.send(
        { conversationId, text: 'rollback', attachments: [] },
        { onPreparedDurable },
      ),
    ).resolves.toMatchObject({
      status: 'blocked',
      code: 'E_ATTEMPT_PERSISTENCE',
    });
    expect(value.store.getState()).toBe(before);
    expect(onPreparedDurable).not.toHaveBeenCalled();
    expect(value.completeRoundV2).not.toHaveBeenCalled();
  });

  test('fails before HTTP when sending state is not fully committed', async () => {
    const value = fixture({
      durability: [
        { status: 'committed' },
        { status: 'session_only' },
        { status: 'committed' },
      ],
    });
    const conversationId = value.store.createConversation();
    await expect(
      value.controller.send({ conversationId, text: 'no http', attachments: [] }),
    ).resolves.toMatchObject({
      status: 'retryable',
      code: 'E_ATTEMPT_PERSISTENCE',
    });
    expect(value.completeRoundV2).not.toHaveBeenCalled();
  });

  test('keeps final persistence commit-pending and never repeats HTTP', async () => {
    const value = fixture({
      durability: [
        { status: 'committed' },
        { status: 'committed' },
        { status: 'not_committed' },
        { status: 'committed' },
      ],
    });
    const conversationId = value.store.createConversation();
    await expect(
      value.controller.send({ conversationId, text: 'once', attachments: [] }),
    ).resolves.toMatchObject({ status: 'commit_pending' });
    expect(value.completeRoundV2).toHaveBeenCalledTimes(1);
    await expect(value.controller.retryCommit()).resolves.toMatchObject({
      status: 'completed',
    });
    expect(value.completeRoundV2).toHaveBeenCalledTimes(1);
  });

  test('cancels the exact active schema2 round and ignores late results', async () => {
    let resolveResult!: (result: CompleteRoundV2Result) => void;
    const completeRoundV2: Fixture['completeRoundV2'] = jest.fn(
      (_request: CompleteRoundV2Request) =>
        new Promise<CompleteRoundV2Result>(resolve => {
          resolveResult = resolve;
        }),
    );
    const value = fixture({ completeRoundV2 });
    const conversationId = value.store.createConversation();
    const run = value.controller.send({
      conversationId,
      text: 'cancel',
      attachments: [],
    });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(completeRoundV2).toHaveBeenCalledTimes(1);
    await value.controller.cancel();
    expect(value.cancelRoundV2).toHaveBeenCalledWith(ROUND_ID);
    resolveResult(v2Result(completeRoundV2.mock.calls[0]![0]));
    await expect(run).resolves.toMatchObject({ status: 'cancelled' });
    expect(
      value.store.getState().conversations[conversationId]?.messages,
    ).toHaveLength(1);
  });

  test('keeps cancelling identity authoritative until native cancel is durable', async () => {
    const completion = deferred<CompleteRoundV2Result>();
    const nativeCancel = deferred<unknown>();
    const value = fixture({
      completeRoundV2: jest.fn(
        (_request: CompleteRoundV2Request) => completion.promise,
      ),
      cancelRoundV2: jest.fn(() => nativeCancel.promise),
    });
    const conversationId = value.store.createConversation();
    const run = value.controller.send({
      conversationId,
      text: 'first active request',
      attachments: [],
    });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    const cancelling = value.controller.cancel();
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(value.controller.getState()).toMatchObject({
      phase: 'cancelling',
      conversationId,
      roundId: ROUND_ID,
    });

    await expect(
      value.controller.send({
        conversationId,
        text: 'must remain blocked',
        attachments: [],
      }),
    ).resolves.toMatchObject({
      status: 'blocked',
      code: 'E_COMPLETION_BUSY',
    });
    expect(value.controller.getState()).toMatchObject({
      phase: 'cancelling',
      conversationId,
      roundId: ROUND_ID,
    });
    expect(value.completeRoundV2).toHaveBeenCalledTimes(1);

    nativeCancel.resolve(undefined);
    await cancelling;
    completion.resolve(v2Result(value.completeRoundV2.mock.calls[0]![0]));
    await run;
  });

  test('serializes persistence and commit retries across duplicate taps', async () => {
    const pendingPreparationWrite = deferred<SessionDurabilityResult>();
    const persistence = jest
      .fn<Promise<SessionDurabilityResult>, []>()
      .mockResolvedValue({ status: 'committed' })
      .mockResolvedValueOnce({ status: 'session_only' })
      .mockImplementationOnce(() => pendingPreparationWrite.promise);
    const pending = fixture({ persistCurrent: persistence });
    const pendingConversation = pending.store.createConversation();
    await pending.controller.send({
      conversationId: pendingConversation,
      text: 'persist once',
      attachments: [],
    });
    const firstPersistenceRetry = pending.controller.retryPersistence();
    await Promise.resolve();
    await expect(pending.controller.retryPersistence()).resolves.toMatchObject({
      status: 'blocked',
      code: 'E_COMPLETION_BUSY',
    });
    expect(persistence).toHaveBeenCalledTimes(2);
    pendingPreparationWrite.resolve({ status: 'committed' });
    await expect(firstPersistenceRetry).resolves.toMatchObject({
      status: 'completed',
    });

    const pendingCommitWrite = deferred<SessionDurabilityResult>();
    const commitPersistence = jest
      .fn<Promise<SessionDurabilityResult>, []>()
      .mockResolvedValue({ status: 'committed' })
      .mockResolvedValueOnce({ status: 'committed' })
      .mockResolvedValueOnce({ status: 'committed' })
      .mockResolvedValueOnce({ status: 'session_only' })
      .mockImplementationOnce(() => pendingCommitWrite.promise);
    const committed = fixture({ persistCurrent: commitPersistence });
    const committedConversation = committed.store.createConversation();
    await committed.controller.send(
      {
        conversationId: committedConversation,
        text: 'commit once',
        attachments: [],
      },
      { onCommitted: jest.fn() },
    );
    const firstCommitRetry = committed.controller.retryCommit();
    await Promise.resolve();
    await expect(committed.controller.retryCommit()).resolves.toMatchObject({
      status: 'blocked',
      code: 'E_COMPLETION_BUSY',
    });
    expect(commitPersistence).toHaveBeenCalledTimes(4);
    pendingCommitWrite.resolve({ status: 'committed' });
    await expect(firstCommitRetry).resolves.toMatchObject({
      status: 'completed',
    });
  });

  test('blocks retry methods while the initial terminal write is finalizing', async () => {
    const finalWrite = deferred<SessionDurabilityResult>();
    const completionPersistence = jest
      .fn<Promise<SessionDurabilityResult>, []>()
      .mockResolvedValue({ status: 'committed' })
      .mockResolvedValueOnce({ status: 'committed' })
      .mockResolvedValueOnce({ status: 'committed' })
      .mockImplementationOnce(() => finalWrite.promise);
    const completed = fixture({ persistCurrent: completionPersistence });
    const completedConversation = completed.store.createConversation();
    const completing = completed.controller.send({
      conversationId: completedConversation,
      text: 'final write',
      attachments: [],
    });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(completed.controller.getState()).toMatchObject({ phase: 'finalizing' });
    await expect(completed.controller.retryCommit()).resolves.toMatchObject({
      status: 'blocked',
      code: 'E_COMPLETION_BUSY',
    });
    expect(completionPersistence).toHaveBeenCalledTimes(3);
    finalWrite.resolve({ status: 'committed' });
    await completing;

    const failureWrite = deferred<SessionDurabilityResult>();
    const failurePersistence = jest
      .fn<Promise<SessionDurabilityResult>, []>()
      .mockResolvedValue({ status: 'committed' })
      .mockResolvedValueOnce({ status: 'committed' })
      .mockResolvedValueOnce({ status: 'committed' })
      .mockImplementationOnce(() => failureWrite.promise);
    const failed = fixture({
      persistCurrent: failurePersistence,
      completeRoundV2: jest.fn(
        async (
          _request: CompleteRoundV2Request,
        ): Promise<CompleteRoundV2Result> => {
          throw { code: 'E_COMPLETION_TRANSPORT' };
        },
      ),
    });
    const failedConversation = failed.store.createConversation();
    const failing = failed.controller.send({
      conversationId: failedConversation,
      text: 'failure write',
      attachments: [],
    });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(failed.controller.getState()).toMatchObject({ phase: 'finalizing' });
    await expect(failed.controller.retryPersistence()).resolves.toMatchObject({
      status: 'blocked',
      code: 'E_COMPLETION_BUSY',
    });
    expect(failurePersistence).toHaveBeenCalledTimes(3);
    failureWrite.resolve({ status: 'committed' });
    await failing;
  });

  test('cancels and rolls back a preparation while first durability is in flight', async () => {
    const durability = deferred<SessionDurabilityResult>();
    const store = storeWithIds();
    const persistCurrent = jest
      .fn()
      .mockImplementationOnce(() => durability.promise)
      .mockResolvedValue({ status: 'committed' });
    const completeRoundV2 = jest.fn(async request => v2Result(request));
    const controller = createCompletionController({
      chat: store,
      persistCurrent,
      completeRoundV2,
      completeRoundV3: jest.fn(async request => v3Result(request)),
      cancelRoundV2: jest.fn(async () => undefined),
      cancelRoundV3: jest.fn(async () => undefined),
      createRoundId: () => ROUND_ID,
    });
    const conversationId = store.createConversation();
    const run = controller.send({
      conversationId,
      text: 'cancel before save',
      attachments: [],
    });
    await Promise.resolve();
    await controller.cancel();
    durability.resolve({ status: 'not_committed' });
    await expect(run).resolves.toMatchObject({ status: 'cancelled' });
    expect(store.getState().conversations[conversationId]?.messages).toEqual(
      [],
    );
    expect(completeRoundV2).not.toHaveBeenCalled();
  });

  test('transfers durable draft ownership when pre-send cancellation commits', async () => {
    const firstWrite = deferred<SessionDurabilityResult>();
    const persistCurrent = jest
      .fn<Promise<SessionDurabilityResult>, []>()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue({ status: 'committed' });
    const value = fixture({ persistCurrent });
    const conversationId = value.store.createConversation();
    const onPreparedDurable = jest.fn();
    const run = value.controller.send(
      {
        conversationId,
        text: 'cancel after durable prepare',
        attachments: [],
      },
      { onPreparedDurable },
    );
    await Promise.resolve();
    await value.controller.cancel();
    await expect(value.controller.retryPersistence()).resolves.toMatchObject({
      status: 'blocked',
      code: 'E_COMPLETION_BUSY',
    });
    expect(persistCurrent).toHaveBeenCalledTimes(1);
    firstWrite.resolve({ status: 'committed' });

    await expect(run).resolves.toMatchObject({ status: 'cancelled' });
    expect(onPreparedDurable).toHaveBeenCalledTimes(1);
    expect(persistCurrent).toHaveBeenCalledTimes(2);
    expect(
      value.store.getState().conversations[conversationId]?.attempts[0],
    ).toMatchObject({ status: 'cancelled' });
    expect(value.controller.getState()).toMatchObject({ phase: 'retryable' });
  });

  test('keeps failed pre-send cancellation persistence pending until retried', async () => {
    const firstWrite = deferred<SessionDurabilityResult>();
    const persistCurrent = jest
      .fn<Promise<SessionDurabilityResult>, []>()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValueOnce({ status: 'not_committed' })
      .mockResolvedValue({ status: 'committed' });
    const value = fixture({ persistCurrent });
    const conversationId = value.store.createConversation();
    const onPreparedDurable = jest.fn();
    const run = value.controller.send(
      {
        conversationId,
        text: 'cancel persistence failure',
        attachments: [],
      },
      { onPreparedDurable },
    );
    await Promise.resolve();
    await value.controller.cancel();
    firstWrite.resolve({ status: 'committed' });

    await expect(run).resolves.toMatchObject({
      status: 'persistence_pending',
      code: 'E_ATTEMPT_PERSISTENCE',
    });
    expect(onPreparedDurable).toHaveBeenCalledTimes(1);
    expect(value.controller.getState()).toMatchObject({
      phase: 'persistence_pending',
      failureCode: 'E_ATTEMPT_PERSISTENCE',
    });
    await expect(
      value.controller.beforeConversationChange(conversationId),
    ).resolves.toBe(false);
    await expect(value.controller.retryPersistence()).resolves.toMatchObject({
      status: 'cancelled',
      code: null,
    });
    await expect(
      value.controller.beforeConversationChange(conversationId),
    ).resolves.toBe(true);
  });

  test('does not transfer draft ownership from session-only cancellation state', async () => {
    const firstWrite = deferred<SessionDurabilityResult>();
    const persistCurrent = jest
      .fn<Promise<SessionDurabilityResult>, []>()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValueOnce({ status: 'not_committed' })
      .mockResolvedValue({ status: 'committed' });
    const value = fixture({ persistCurrent });
    const conversationId = value.store.createConversation();
    const onPreparedDurable = jest.fn();
    const run = value.controller.send(
      {
        conversationId,
        text: 'session-only cancel',
        attachments: [],
      },
      { onPreparedDurable },
    );
    await Promise.resolve();
    await value.controller.cancel();
    firstWrite.resolve({ status: 'session_only' });

    await expect(run).resolves.toMatchObject({
      status: 'persistence_pending',
    });
    expect(onPreparedDurable).not.toHaveBeenCalled();
    await value.controller.retryPersistence();
    expect(onPreparedDurable).toHaveBeenCalledTimes(1);
  });

  test('lets the in-flight persistence retry own a concurrent cancellation', async () => {
    const retryWrite = deferred<SessionDurabilityResult>();
    const persistCurrent = jest
      .fn<Promise<SessionDurabilityResult>, []>()
      .mockResolvedValueOnce({ status: 'session_only' })
      .mockImplementationOnce(() => retryWrite.promise)
      .mockResolvedValue({ status: 'committed' });
    const value = fixture({ persistCurrent });
    const conversationId = value.store.createConversation();
    const onPreparedDurable = jest.fn();
    await value.controller.send(
      {
        conversationId,
        text: 'retry then cancel',
        attachments: [],
      },
      { onPreparedDurable },
    );
    const retrying = value.controller.retryPersistence();
    await Promise.resolve();
    await value.controller.cancel();
    expect(value.controller.getState()).toMatchObject({ phase: 'cancelling' });
    expect(persistCurrent).toHaveBeenCalledTimes(2);
    retryWrite.resolve({ status: 'committed' });

    await expect(retrying).resolves.toMatchObject({ status: 'cancelled' });
    expect(onPreparedDurable).toHaveBeenCalledTimes(1);
    expect(persistCurrent).toHaveBeenCalledTimes(3);
    expect(value.controller.getState()).toMatchObject({
      phase: 'retryable',
      failureCode: null,
    });
  });

  test('does not expose an undurable failure as retryable', async () => {
    const value = fixture({
      durability: [
        { status: 'committed' },
        { status: 'committed' },
        { status: 'not_committed' },
        { status: 'committed' },
      ],
      completeRoundV2: jest.fn(
        async (
          _request: CompleteRoundV2Request,
        ): Promise<CompleteRoundV2Result> => {
          throw { code: 'E_COMPLETION_TRANSPORT' };
        },
      ),
    });
    const conversationId = value.store.createConversation();
    await expect(
      value.controller.send({
        conversationId,
        text: 'persist failure state',
        attachments: [],
      }),
    ).resolves.toMatchObject({
      status: 'persistence_pending',
      code: 'E_ATTEMPT_PERSISTENCE',
    });
    await expect(
      value.controller.beforeConversationChange(conversationId),
    ).resolves.toBe(false);
    expect(value.completeRoundV2).toHaveBeenCalledTimes(1);
    await expect(value.controller.retryPersistence()).resolves.toMatchObject({
      status: 'retryable',
      code: 'E_COMPLETION_TRANSPORT',
    });
    expect(value.completeRoundV2).toHaveBeenCalledTimes(1);
  });

  test('reconciles a persisted sending round to interrupted without HTTP', () => {
    const source = storeWithIds();
    const conversationId = source.createConversation();
    const prepared = source.prepareTurnAttempt(conversationId, 'restart')!;
    prepared.commit();
    source.startAttemptRound(conversationId, prepared.attemptId, ROUND_ID, 0);
    const hydrated = createChatStore({
      initialState: hydrateChatState(source.serialize()),
    });
    const value = fixture({ store: hydrated });

    expect(value.controller.reconcileHydrated(conversationId)).toMatchObject({
      phase: 'retryable',
      attemptId: ATTEMPT_ID,
      failureCode: 'E_ATTEMPT_INTERRUPTED',
    });
    expect(value.completeRoundV2).not.toHaveBeenCalled();
  });

  test('reconciles a completed persisted attempt without repeating HTTP', async () => {
    const source = fixture();
    const conversationId = source.store.createConversation();
    await source.controller.send({
      conversationId,
      text: 'already completed',
      attachments: [],
    });
    const reloaded = createChatStore({
      initialState: hydrateChatState(source.store.serialize()),
    });
    const value = fixture({ store: reloaded });

    expect(value.controller.reconcileHydrated(conversationId)).toMatchObject({
      phase: 'idle',
    });
    expect(value.completeRoundV2).not.toHaveBeenCalled();
  });

  test('does not let cancel or duplicate send overwrite active controller identity', async () => {
    const pendingResult = deferred<CompleteRoundV2Result>();
    const completeRoundV2: Fixture['completeRoundV2'] = jest.fn(
      (_request: CompleteRoundV2Request) => pendingResult.promise,
    );
    const value = fixture({ completeRoundV2 });
    const conversationId = value.store.createConversation();
    const run = value.controller.send({
      conversationId,
      text: 'active',
      attachments: [],
    });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    const sending = value.controller.getState();
    expect(sending).toMatchObject({
      phase: 'sending',
      conversationId,
      attemptId: ATTEMPT_ID,
      roundId: ROUND_ID,
    });
    await expect(
      value.controller.send({
        conversationId,
        text: 'duplicate',
        attachments: [],
      }),
    ).resolves.toMatchObject({
      status: 'blocked',
      code: 'E_COMPLETION_BUSY',
    });
    expect(value.controller.getState()).toBe(sending);

    await value.controller.cancel();
    pendingResult.resolve(v2Result(completeRoundV2.mock.calls[0]![0]));
    await run;
  });

  test('keeps commit-pending authoritative until retryCommit succeeds', async () => {
    const value = fixture({
      durability: [
        { status: 'committed' },
        { status: 'committed' },
        { status: 'not_committed' },
        { status: 'committed' },
      ],
    });
    const conversationId = value.store.createConversation();
    await value.controller.send({
      conversationId,
      text: 'pending commit',
      attachments: [],
    });
    const pending = value.controller.getState();
    expect(pending.phase).toBe('commit_pending');
    await value.controller.cancel();
    expect(value.controller.getState()).toBe(pending);
    expect(value.cancelRoundV2).not.toHaveBeenCalled();
    await expect(value.controller.retryCommit()).resolves.toMatchObject({
      status: 'completed',
    });
  });

  test('fails closed when a failure transition cannot be recorded', async () => {
    const base = storeWithIds();
    const chat: ChatStore = {
      ...base,
      failAttempt: () => false,
    };
    const value = fixture({
      store: chat,
      durability: [
        { status: 'committed' },
        { status: 'not_committed' },
      ],
    });
    const conversationId = chat.createConversation();
    await expect(
      value.controller.send({
        conversationId,
        text: 'transition conflict',
        attachments: [],
      }),
    ).resolves.toMatchObject({
      status: 'blocked',
      code: 'E_COMPLETION_RESULT_CORRELATION',
    });
  });

  test('blocks navigation for pending durability and cancels active identity before switching', async () => {
    const pending = fixture({
      durability: [{ status: 'session_only' }],
    });
    const pendingId = pending.store.createConversation();
    await pending.controller.send({
      conversationId: pendingId,
      text: 'pending',
      attachments: [],
    });
    await expect(
      pending.controller.beforeConversationChange(pendingId),
    ).resolves.toBe(false);
    await expect(
      pending.controller.beforeConversationDelete(pendingId),
    ).resolves.toBe(false);

    const activeResult = deferred<CompleteRoundV2Result>();
    const active = fixture({
      completeRoundV2: jest.fn(
        (_request: CompleteRoundV2Request) => activeResult.promise,
      ),
    });
    const activeId = active.store.createConversation();
    const run = active.controller.send({
      conversationId: activeId,
      text: 'switch',
      attachments: [],
    });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await expect(
      active.controller.beforeConversationChange(activeId),
    ).resolves.toBe(true);
    expect(active.cancelRoundV2).toHaveBeenCalledWith(ROUND_ID);
    activeResult.resolve(v2Result(active.completeRoundV2.mock.calls[0]![0]));
    await run;
  });

  test('retries the same turn with a new attempt and resumes prepared without HTTP automation', async () => {
    const store = storeWithIds();
    const conversationId = store.createConversation();
    const first = store.prepareTurnAttempt(conversationId, 'retry')!;
    first.commit();
    store.failAttempt(conversationId, first.attemptId, 'E_COMPLETION_TRANSPORT');
    const value = fixture({ store });
    await expect(
      value.controller.retry(conversationId, first.attemptId),
    ).resolves.toMatchObject({ status: 'completed', attemptId: RETRY_ID });
    const conversation = store.getState().conversations[conversationId]!;
    expect(conversation.turns[0]?.attemptIds).toEqual([
      ATTEMPT_ID,
      RETRY_ID,
    ]);
    expect(conversation.messages.filter(message => message.role === 'user')).toHaveLength(1);

    const resumableStore = storeWithIds();
    const resumableId = resumableStore.createConversation();
    const prepared = resumableStore.prepareTurnAttempt(resumableId, 'resume')!;
    prepared.commit();
    const resumable = fixture({ store: resumableStore });
    resumable.controller.reconcileHydrated(resumableId);
    expect(resumable.controller.getState()).toMatchObject({
      phase: 'resume_available',
      attemptId: ATTEMPT_ID,
    });
    const resumeIdentity = resumable.controller.getState();
    await expect(
      resumable.controller.send({
        conversationId: resumableId,
        text: 'must resume first',
        attachments: [],
      }),
    ).resolves.toMatchObject({
      status: 'blocked',
      code: 'E_COMPLETION_BUSY',
    });
    expect(resumable.controller.getState()).toBe(resumeIdentity);
    expect(resumable.completeRoundV2).not.toHaveBeenCalled();
    await expect(
      resumable.controller.resume(resumableId, ATTEMPT_ID),
    ).resolves.toMatchObject({ status: 'completed' });
  });
});

test('completing a round emits reasoning before text session events', async () => {
  const events: Array<{ kind: string; seq: number; text: string }> = [];
  const f = fixture({
    onSessionEvent: jest.fn((event: { kind: string; seq: number; text: string }) => {
      events.push(event);
    }),
  });
  f.store.createConversation();
  const conversationId = f.store.getState().selectedConversationId;
  if (conversationId === null) throw new Error('no conversation');
  await f.controller.send({ conversationId, text: 'hello', attachments: [] });

  const kinds = events.map(e => e.kind);
  expect(kinds).toContain('assistant_text');
  expect(events.map(e => e.seq)).toEqual(
    events.map((_, i) => i),
  );
  const textIdx = kinds.indexOf('assistant_text');
  const reasoningIdx = kinds.indexOf('assistant_reasoning');
  if (reasoningIdx !== -1) {
    expect(reasoningIdx).toBeLessThan(textIdx);
  }
});

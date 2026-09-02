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
import { sessionSnapshotSHA256 } from '../src/completion/SessionPersistence';
import type {
  AgentRuntimeFacadeV2,
  AgentAttemptProjectionV2,
  AgentBatchReceiptV2,
  AgentBatchCallProjectionV2,
  AgentRuntimeRootV1,
  AgentRuntimePolicyV1,
  AgentRuntimeRegistryV2,
  AgentRuntimeTranscriptHandleV1,
  AgentApprovalBindingTokenV2,
  AgentToolReceiptV1,
  AgentRoundReceiptV2,
  CompleteAgentRoundRequestV2,
  CompleteAgentRoundResultV2,
  PrepareAgentAttemptRequestV2,
  PrepareAgentToolBatchRequestV2,
  PrepareAgentToolBatchResultV2,
  BindAgentApprovalRequestV2,
  ExecuteAgentToolRequestV2,
  ExecuteAgentToolResultV2,
  CancelAgentAttemptResultV2,
  QueryAgentAttemptResultV2,
  RecoverAgentAttemptResultV2,
} from '../src/native/AgentRuntime';
import type { CompletionPersistenceResult } from '../src/completion/CompletionController';
import {
  createSessionEventJournal,
  type SessionEventEmission,
} from '../src/agent/SessionEvents';
import {
  createChatStore,
  hydrateChatState,
  type ChatStore,
} from '../src/state';
import type {
  ProjectContextConsentV1,
  ProjectContextManifestV1,
  ProjectContextState,
} from '../src/project-context';

declare const __dirname: string;

const nodeFs = jest.requireActual('node:fs') as {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const nodePath = jest.requireActual('node:path') as {
  resolve(...paths: string[]): string;
};

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
  // The controller delegates event_id/seq/created_at allocation to the
  // receiver; feed its emissions through the shared journal exactly like
  // production wiring does.
  const journal = createSessionEventJournal();
  const f = fixture({
    onSessionEvent: jest.fn((event: { schema_version: number; attempt_id: string; kind: string; text: string }) => {
      journal.append(event as unknown as SessionEventEmission);
    }),
  });
  f.store.createConversation();
  const conversationId = f.store.getState().selectedConversationId;
  if (conversationId === null) throw new Error('no conversation');
  await f.controller.send({ conversationId, text: 'hello', attachments: [] });

  const events = journal.snapshot();
  const kinds = events.map(e => e.kind);
  expect(kinds).toContain('assistant_text');
  // The journal allocates strictly increasing per-attempt sequences.
  expect(events.map(e => e.seq)).toEqual(
    events.map((_, i) => i),
  );
  expect(new Set(events.map(e => e.event_id)).size).toBe(events.length);
  // Every emitted row must conform to the persisted session-event schema.
  expect(
    events.every(e => (e as { schema_version?: unknown }).schema_version === 1),
  ).toBe(true);
  const textIdx = kinds.indexOf('assistant_text');
  const reasoningIdx = kinds.indexOf('assistant_reasoning');
  if (reasoningIdx !== -1) {
    expect(reasoningIdx).toBeLessThan(textIdx);
  }
});

describe('project Agent completion controller', () => {
  const AGENT_CONVERSATION = '10101010-1010-4101-8101-101010101010';
  const AGENT_MESSAGE = '20202020-2020-4202-8202-202020202020';
  const AGENT_TURN = '30303030-3030-4303-8303-303030303030';
  const AGENT_ATTEMPT = '40404040-4040-4404-8404-404040404040';
  const AGENT_WORKSPACE = '50505050-5050-4505-8505-505050505050';
  const AGENT_PROJECT = '60606060-6060-4606-8606-606060606060';
  const AGENT_TRANSCRIPT = '70707070-7070-4707-8707-707070707070';
  const SHA = 'a'.repeat(64);
  const ROOT_SHA = 'b'.repeat(64);
  const TOOLSET_SHA = 'c'.repeat(64);
  const MANIFEST_SHA = 'd'.repeat(64);
  const IDS = [
    '80808080-8080-4808-8808-808080808080',
    '90909090-9090-4909-8909-909090909090',
    'a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0',
    'b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0',
    'c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c0c0',
    'd0d0d0d0-d0d0-40d0-80d0-d0d0d0d0d0d0',
    'e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e0e0',
    'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0',
    '81818181-8181-4181-8181-818181818181',
    '82828282-8282-4282-8282-828282828282',
    '83838383-8383-4383-8383-838383838383',
    '84848484-8484-4484-8484-848484848484',
    '85858585-8585-4585-8585-858585858585',
    '86868686-8686-4686-8686-868686868686',
    '87878787-8787-4787-8787-878787878787',
    '88888888-8888-4888-8888-888888888888',
    '89898989-8989-4989-8989-898989898989',
    '8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a',
    '8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b',
    '8c8c8c8c-8c8c-4c8c-8c8c-8c8c8c8c8c8c',
  ];

  function agentStore() {
    let messageUsed = false;
    const options: Parameters<typeof createChatStore>[0] = {
      now: () => NOW,
      sessionAuthority: { generation: 1, sessionSha256: SHA },
      createId: kind => {
        if (kind === 'conversation') return AGENT_CONVERSATION;
        if (!messageUsed) {
          messageUsed = true;
          return AGENT_MESSAGE;
        }
        return IDS.shift() ?? AGENT_MESSAGE;
      },
      createLifecycleId: kind =>
        kind === 'turn' ? AGENT_TURN : kind === 'attempt' ? AGENT_ATTEMPT : (IDS.shift() ?? AGENT_TURN),
    };
    const base = createChatStore(options);
    const conversationId = base.createConversation({ workspaceId: AGENT_WORKSPACE, projectId: AGENT_PROJECT });
    const source = base.getState().conversations[conversationId]!;
    const manifest: ProjectContextManifestV1 = {
      schema_version: 1 as const,
      snapshot_id: '91919191-9191-4919-8919-919191919191',
      project_id: AGENT_PROJECT,
      project_name: 'agent-project',
      branch: 'main',
      head_oid: '0'.repeat(40),
      clean: true,
      conflicted: false,
      captured_at: NOW,
      policy_version: 'chat-read-v1.0.0',
      provider_host: 'api.deepseek.com',
      model: 'deepseek-v4-flash',
      included: [{ path: 'README.md', source: 'tracked_file' as const, bytes: 1, sha256: 'c'.repeat(64) }],
      omitted: [],
      context_bytes: 1,
      estimated_tokens: 1,
      snapshot_sha256: 'a'.repeat(64),
      source_fingerprint: 'b'.repeat(64),
    };
    const context: ProjectContextState = {
      schemaVersion: 1 as const,
      projectId: AGENT_PROJECT,
      status: 'ready' as const,
      selectedPaths: [],
      activePreparationId: null,
      snapshot: manifest,
      consent: {
        schema_version: 1 as const,
        consent_receipt_id: '92929292-9292-4929-8929-929292929292',
        snapshot_id: manifest.snapshot_id,
        snapshot_sha256: manifest.snapshot_sha256,
        confirmed_at: LATER,
      },
      staleReason: null,
      errorCode: null,
    };
    const state = base.getState();
    return createChatStore({
      ...options,
      initialState: {
        ...state,
        conversations: {
          ...state.conversations,
          [conversationId]: {
            ...source,
            workspaceId: AGENT_WORKSPACE,
            runtimeContextId: AGENT_WORKSPACE,
            workspaceBinding: {
              schemaVersion: 1 as const,
              workspaceId: AGENT_WORKSPACE,
              bindingRevision: 1,
              projectId: AGENT_PROJECT,
            },
            workspaceBootstrapState: 'none' as const,
            projectContext: context,
          },
        },
      },
    });
  }

  type AgentRuntimeFixtureCall = {
    readonly callId: string;
    readonly name: string;
    readonly argumentsSha256: string;
    readonly access: 'auto' | 'conversation_confirm' | 'confirm_once' | 'durable_deny';
  };

  type AgentRuntimeFixtureOptions = {
    readonly batchRounds?: readonly (readonly AgentRuntimeFixtureCall[])[];
    readonly finalRoundIndex?: number;
    readonly cancelledCallIds?: readonly string[];
  };

  const defaultBatchCalls: readonly AgentRuntimeFixtureCall[] = [
    { callId: 'write-call', name: 'write_file', argumentsSha256: '2'.repeat(64), access: 'conversation_confirm' },
    { callId: 'commit-call', name: 'git_commit', argumentsSha256: '3'.repeat(64), access: 'conversation_confirm' },
  ];
  const tokenIds = [
    '93939393-9393-4939-8939-939393939393',
    '94949494-9494-4949-8949-949494949494',
    '95959595-9595-4959-8959-959595959595',
    '96969696-9696-4969-8969-969696969696',
    '97979797-9797-4979-8979-979797979797',
    '98989898-9898-4989-8989-989898989898',
  ];

  function makeRuntime(
    operations: ReturnType<typeof jest.fn>[],
    options: AgentRuntimeFixtureOptions = {},
  ): AgentRuntimeFacadeV2 {
    const root: AgentRuntimeRootV1 = {
      schema_version: 1,
      kind: 'project',
      workspace_id: AGENT_WORKSPACE,
      workspace_binding_revision: 1,
      project_id: AGENT_PROJECT,
      root_fingerprint_sha256: ROOT_SHA,
      capabilities: ['file_read', 'file_write', 'git_commit'],
    };
    const policy: AgentRuntimePolicyV1 = {
      schema_version: 1,
      policy_version: 'agent-v1',
      max_single_write_bytes: 32768,
      max_batch_write_bytes: 512 * 1024,
      max_attempt_write_bytes: 4 * 1024 * 1024,
    };
    const registry: AgentRuntimeRegistryV2 = {
      schema_version: 2,
      registry_version: 1,
      toolset_sha256: TOOLSET_SHA,
      tools: [
        { schema_version: 2, name: 'write_file', safe_summary_key: 'agent.write_file', access: 'conversation_confirm' },
        { schema_version: 2, name: 'git_commit', safe_summary_key: 'agent.git_commit', access: 'conversation_confirm' },
      ],
    };
    const transcript = (generation: number, digest: string): AgentRuntimeTranscriptHandleV1 => ({
      schema_version: 1,
      transcript_ref: AGENT_TRANSCRIPT,
      generation,
      transcript_sha256: digest,
      transcript_bytes: generation * 10,
    });
    const prepareAgentAttempt = jest.fn(async (request: PrepareAgentAttemptRequestV2) => ({
      schema_version: 2 as const,
      status: 'prepared' as const,
      operation_id: request.operation_id,
      attempt: {
        schema_version: 2 as const,
        task_id: request.task_id,
        conversation_id: request.conversation_id,
        attempt_id: request.attempt_id,
        phase: 'ready_for_round' as const,
        controller_generation: request.controller_cas.expected_controller_generation,
        journal_revision: request.controller_cas.expected_journal_revision,
        authority_revision: 1,
        root,
        policy,
        registry,
        transcript: transcript(0, SHA),
        round_index: 0,
        round_id: null,
        round_revision: null,
        round_status: null,
        batch_kind: null,
        batch_revision: null,
        manifest_sha256: null,
        call_index: null,
        batch: [],
        frozen_grant_ids: [],
        reserved_write_bytes: 0,
        cancel_source_event_id: null,
        cleanup_id: null,
      } as AgentAttemptProjectionV2,
      observed_checkpoint: request.committed_checkpoint,
    }));
    const completeAgentRoundV2 = jest.fn(async (request: CompleteAgentRoundRequestV2): Promise<CompleteAgentRoundResultV2> => {
      operations.push(completeAgentRoundV2);
      const final = request.round_index >= (options.finalRoundIndex ?? 1);
      const nextGeneration = request.transcript.generation + 1;
      const nextTranscript = transcript(
        nextGeneration,
        final ? '9'.repeat(64) : `${nextGeneration}`.repeat(64),
      );
      const completionReceipt: AgentRoundReceiptV2 = {
        schema_version: 2,
        transport_schema_version: request.transport_schema_version,
        turn_id: request.task_id,
        task_id: request.task_id,
        attempt_id: request.attempt_id,
        round_id: request.round_id,
        round_index: request.round_index,
        provider_request_id:
          `77777777-7777-4777-8777-${String(request.round_index + 1).padStart(12, '0')}`,
        provider_response_id: `response-${request.round_index}`,
        requested_model: request.model,
        model: request.model,
        thinking_mode: request.thinking_mode,
        finish_reason: final ? 'stop' : 'tool_calls',
        latency_ms: 1,
        // Native separately proves the controller HJ digest and the provider
        // transport body digest; exercise the intentionally distinct values.
        visible_history_sha256: 'f'.repeat(64),
        model_input_sha256: SHA,
        request_body_sha256: SHA,
        project_context_receipt: request.transport_schema_version === 3 ? {
          schema_version: 1,
          snapshot_id: '91919191-9191-4919-8919-919191919191',
          snapshot_sha256: SHA,
          source_fingerprint: 'b'.repeat(64),
          context_bytes: 1,
          verified_at: NOW,
        } : null,
      };
      if (final) {
        return {
          schema_version: 2,
          status: 'completed',
          operation_id: request.operation_id,
          task_id: request.task_id,
          attempt_id: request.attempt_id,
          round_id: request.round_id,
          round_index: request.round_index,
          launch_attempt: request.launch_attempt,
          result_round_revision: 1,
          transcript: nextTranscript,
          outcome: {
            schema_version: 3,
            kind: 'final',
            finish_reason: 'stop',
            completion_receipt: completionReceipt,
            transcript: nextTranscript,
            text: 'Agent final',
            reasoning: 'Agent reasoning',
          },
        };
      }
      const callsForRound = options.batchRounds?.[request.round_index] ?? defaultBatchCalls;
      const executableCallCount = callsForRound.filter(call => call.access !== 'durable_deny').length;
      const deniedCallCount = callsForRound.length - executableCallCount;
      return {
        schema_version: 2,
        status: 'completed',
        operation_id: request.operation_id,
        task_id: request.task_id,
        attempt_id: request.attempt_id,
        round_id: request.round_id,
        round_index: request.round_index,
        launch_attempt: request.launch_attempt,
        result_round_revision: 1,
        transcript: nextTranscript,
        outcome: {
          schema_version: 3,
          kind: 'tool_batch',
          finish_reason: 'tool_calls',
          completion_receipt: completionReceipt,
          transcript: nextTranscript,
          calls: [
            ...callsForRound.map((call, callIndex) => ({
              schema_version: 3 as const,
              call_index: callIndex,
              call_id: call.callId,
              name: call.name,
              arguments_sha256: call.argumentsSha256,
              safe_summary_key: call.access === 'durable_deny' ? 'agent.unknown' : `agent.${call.name}`,
              access: call.access,
              approval_state: call.access === 'durable_deny' ? 'durable_denied' as const : 'deferred' as const,
            })),
          ],
          batch_class: deniedCallCount === 0 ? 'executable' : deniedCallCount === callsForRound.length ? 'denied_only' : 'mixed',
          executable_call_count: executableCallCount,
          denied_call_count: deniedCallCount,
          reasoning: '',
        },
      };
    });
    const prepareAgentToolBatch = jest.fn(async (request: PrepareAgentToolBatchRequestV2) => {
      operations.push(prepareAgentToolBatch);
      const callsForRound = options.batchRounds?.[request.round_index] ?? defaultBatchCalls;
      const hasMutation = callsForRound.some(call => call.name === 'write_file' || call.name === 'git_commit' || call.name === 'git_push');
      const batchRevision = hasMutation
        ? request.expected_batch_revision + 1
        : request.expected_round_revision;
      const makeToken = (index: number, call: AgentRuntimeFixtureCall): AgentApprovalBindingTokenV2 => ({
        schema_version: 2,
        token: tokenIds[request.round_index * 2 + index] ?? tokenIds[index]!,
        controller_cas: request.controller_cas,
        task_id: request.task_id,
        attempt_id: request.attempt_id,
        round_id: request.round_id,
        round_index: request.round_index,
        batch_call_ids: callsForRound.map(candidate => candidate.callId),
        batch_arguments_sha256: callsForRound.map(candidate => candidate.argumentsSha256),
        batch_revision: batchRevision,
        manifest_sha256: MANIFEST_SHA,
        call_index: index,
        call_id: call.callId,
        name: call.name,
        arguments_sha256: call.argumentsSha256,
        idempotency_key: `${request.round_index + index + 4}`.repeat(64),
        root_fingerprint_sha256: ROOT_SHA,
        binding_revision: 1,
        policy_version: 'agent-v1',
        registry_version: 1,
        access: call.access === 'confirm_once' ? 'confirm_once' : 'conversation_confirm',
        allowed_decisions: call.access === 'confirm_once'
          ? ['denied', 'allow_once', 'cancelled']
          : ['denied', 'allow_once', 'allow_conversation', 'cancelled'],
      });
      const calls: AgentBatchCallProjectionV2[] = callsForRound.map((call, callIndex) => {
        const durableDeny = call.access === 'durable_deny';
        const idempotencyKey = durableDeny ? null : `${request.round_index + callIndex + 4}`.repeat(64);
        const deniedReceipt: AgentToolReceiptV1 | null = durableDeny
          ? {
              schema_version: 1,
              call_id: call.callId,
              name: call.name,
              arguments_sha256: call.argumentsSha256,
              result_sha256: 'e'.repeat(64),
              result_bytes: 0,
              truncated: false,
              duration_ms: 0,
              outcome: 'denied',
              failure_code: 'E_AGENT_UNKNOWN_TOOL',
              approval_reference: null,
            }
          : null;
        return {
          schema_version: 2,
          call_index: callIndex,
          call_id: call.callId,
          name: call.name,
          arguments_sha256: call.argumentsSha256,
          idempotency_key: idempotencyKey,
          safe_summary_key: durableDeny ? 'agent.unknown' : `agent.${call.name}`,
          access: call.access,
          approval_state: durableDeny ? 'denied' : call.access === 'auto' ? 'not_required' : 'pending',
          approval_token: durableDeny || call.access === 'auto' ? null : makeToken(callIndex, call),
          approval_reference: null,
          execution_status: durableDeny ? 'denied' : 'intent',
          execution_revision: durableDeny ? null : 1,
          native_row_revision: 1,
          receipt: deniedReceipt,
        };
      });
      const batchKind = hasMutation ? 'write_batch' : 'read_only_batch';
      const batchNewWriteBytes = hasMutation ? 1 : 0;
      const receipt: AgentBatchReceiptV2 = {
        schema_version: 2,
        task_id: request.task_id,
        attempt_id: request.attempt_id,
        round_id: request.round_id,
        round_index: request.round_index,
        batch_kind: batchKind,
        batch_revision: batchRevision,
        manifest_sha256: hasMutation ? MANIFEST_SHA : null,
        transcript: request.transcript,
        calls,
        batch_new_write_bytes: batchNewWriteBytes,
        reserved_write_bytes: request.expected_reserved_write_bytes + batchNewWriteBytes,
        effect_gate: hasMutation ? 'closed' : 'not_applicable',
      };
      return { schema_version: 2 as const, status: 'prepared' as const, operation_id: request.operation_id, receipt, observed_checkpoint: request.committed_checkpoint };
    });
    const bindAgentApproval = jest.fn(async (request: BindAgentApprovalRequestV2) => {
      operations.push(bindAgentApproval);
      return { schema_version: 2 as const, status: 'bound' as const, operation_id: request.operation_id, task_id: request.task_id, attempt_id: request.attempt_id, round_id: request.round_id, call_index: request.call_index, call_id: request.call_id, decision: request.decision, approval_reference: request.operation_id, grant: null, result_batch_revision: request.batch_revision, observed_checkpoint: request.committed_checkpoint };
    });
    const executeAgentTool = jest.fn(async (request: ExecuteAgentToolRequestV2): Promise<ExecuteAgentToolResultV2> => {
      operations.push(executeAgentTool);
      const cancelled = options.cancelledCallIds?.includes(request.call_id) === true;
      const receipt: AgentToolReceiptV1 = { schema_version: 1, call_id: request.call_id, name: request.name, arguments_sha256: request.arguments_sha256, result_sha256: `${request.call_index + 6}`.repeat(64), result_bytes: 1, truncated: false, duration_ms: 1, outcome: cancelled ? 'cancelled' : 'ok', failure_code: cancelled ? 'E_AGENT_CANCELLED' : null, approval_reference: request.approval_reference };
      const nextGeneration = request.transcript.generation + 1;
      const commonResult = { operation_id: request.operation_id, task_id: request.task_id, attempt_id: request.attempt_id, round_id: request.round_id, round_index: request.round_index, call_index: request.call_index, call_id: request.call_id, name: request.name, idempotency_key: request.idempotency_key, result_execution_revision: request.expected_execution_revision + 3, transcript: { schema_version: 1 as const, transcript_ref: AGENT_TRANSCRIPT, generation: nextGeneration, transcript_sha256: `${nextGeneration}`.repeat(64), transcript_bytes: nextGeneration * 10 }, receipt };
      if (cancelled) {
        return { schema_version: 2, status: 'cancelled', ...commonResult, effect_may_have_occurred: false };
      }
      return { schema_version: 2, status: 'completed', ...commonResult, effect_may_have_occurred: true };
    });
    const finalizeAgentAttempt = jest.fn(async (request: any) => ({ schema_version: 2 as const, status: 'terminal' as const, operation_id: request.operation_id, cleanup_id: request.cleanup_id, transcript: request.transcript }));
    const discardAgentAttempt = jest.fn(async (request: any) => ({ schema_version: 2 as const, status: 'discarded' as const, operation_id: request.operation_id, cleanup_id: request.cleanup_id }));
    const runtime: AgentRuntimeFacadeV2 = {
      isAvailable: () => true,
      prepareAgentAttempt,
      completeAgentRoundV2,
      prepareAgentToolBatch,
      bindAgentApproval,
      executeAgentTool,
      cancelAgentAttempt: jest.fn(),
      queryAgentAttempt: jest.fn(),
      queryAgentTool: jest.fn(),
      recoverAgentAttempt: jest.fn(),
      finalizeAgentAttempt,
      discardAgentAttempt,
      queryAgentCleanup: jest.fn(),
    };
    return runtime;
  }

  function committedPersistence(store: ChatStore) {
    return jest.fn(async (): Promise<CompletionPersistenceResult> => {
      const digest = sessionSnapshotSHA256(store.serialize())!;
      const generation = (store.getSessionAuthority()?.generation ?? 1) + 1;
      const snapshot = { schema_version: 1 as const, generation, session_sha256: digest };
      store.setSessionAuthority({ generation, sessionSha256: digest });
      return { status: 'committed', snapshot };
    });
  }

  function agentController(
    store: ChatStore,
    runtime: AgentRuntimeFacadeV2,
    persistCurrent: () => Promise<CompletionPersistenceResult>,
    operationIds = [...IDS],
    requestAgentApproval = jest.fn(async () => ({ status: 'approved' as const, scope: 'once' as const })),
  ) {
    return createCompletionController({
      chat: store,
      persistCurrent,
      completeRoundV2: jest.fn(),
      completeRoundV3: jest.fn(),
      cancelRoundV2: jest.fn(),
      cancelRoundV3: jest.fn(),
      createRoundId: jest.fn(() => operationIds.shift() ?? AGENT_TURN),
      createOperationId: jest.fn(() => operationIds.shift() ?? AGENT_ATTEMPT),
      agentRuntime: runtime,
      requestAgentApproval,
      now: () => NOW,
    });
  }

  test('does not invoke Agent native effects when outer preparation is not durable', async () => {
    const store = agentStore();
    const runtime = makeRuntime([]);
    const persistCurrent = jest.fn(async (): Promise<CompletionPersistenceResult> => ({ status: 'not_committed' }));
    const controller = agentController(store, runtime, persistCurrent);
    const conversationId = store.getState().selectedConversationId!;

    const result = await controller.send({ conversationId, text: 'write', attachments: [] });

    expect(result).toMatchObject({ status: 'blocked', code: 'E_ATTEMPT_PERSISTENCE' });
    expect(runtime.prepareAgentAttempt).not.toHaveBeenCalled();
    expect(runtime.completeAgentRoundV2).not.toHaveBeenCalled();
    expect(store.getState().conversations[conversationId]?.attempts).toHaveLength(0);
  });

  test('cancel persists request_cancel before native cancel and never runs the held round', async () => {
    const store = agentStore();
    const runtime = makeRuntime([]);
    const round = deferred<CompleteAgentRoundResultV2>();
    (runtime.completeAgentRoundV2 as jest.Mock).mockImplementationOnce(() => round.promise);
    (runtime.cancelAgentAttempt as jest.Mock).mockImplementation(async (request: any): Promise<CancelAgentAttemptResultV2> => ({
      schema_version: 2,
      status: 'cancelled',
      operation_id: request.operation_id,
      target: request.target,
      result_round_revision: request.target.kind === 'round' ? 1 : null,
      result_execution_revision: null,
      transcript: request.expected_transcript,
      receipt: null,
      effect_may_have_occurred: false,
      observed_checkpoint: request.committed_checkpoint,
    }));
    const persistCurrent = committedPersistence(store);
    const controller = agentController(store, runtime, persistCurrent);
    const conversationId = store.getState().selectedConversationId!;
    const sendPromise = controller.send({ conversationId, text: 'cancel me', attachments: [] });
    for (let index = 0; index < 20 && !(runtime.completeAgentRoundV2 as jest.Mock).mock.calls.length; index += 1) {
      await Promise.resolve();
    }
    expect(runtime.completeAgentRoundV2).toHaveBeenCalledTimes(1);

    await controller.cancel();
    expect(runtime.cancelAgentAttempt).toHaveBeenCalledTimes(1);
    expect((runtime.cancelAgentAttempt as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(
      (runtime.completeAgentRoundV2 as jest.Mock).mock.invocationCallOrder[0] ?? 0,
    );
    expect(
      persistCurrent.mock.invocationCallOrder.some(
        order => order < (runtime.cancelAgentAttempt as jest.Mock).mock.invocationCallOrder[0]!,
      ),
    ).toBe(true);
    expect(runtime.finalizeAgentAttempt).toHaveBeenCalledTimes(1);
    expect(runtime.discardAgentAttempt).toHaveBeenCalledTimes(1);
    expect(store.getState().agentTranscriptCleanupOutbox).toEqual([]);

    // The round was still in flight when cancel committed; its late result
    // must be ignored and cannot trigger another native call.
    round.resolve({} as CompleteAgentRoundResultV2);
    await sendPromise;
    expect(runtime.completeAgentRoundV2).toHaveBeenCalledTimes(1);
  });

  test('restarts through query/recover without replaying an in-flight round', async () => {
    const store = agentStore();
    const runtime = makeRuntime([]);
    (runtime.completeAgentRoundV2 as jest.Mock).mockImplementationOnce(async (request: CompleteAgentRoundRequestV2) => ({
      schema_version: 2,
      status: 'in_flight',
      operation_id: request.operation_id,
      task_id: request.task_id,
      attempt_id: request.attempt_id,
      round_id: request.round_id,
      round_index: request.round_index,
      launch_attempt: request.launch_attempt,
      result_round_revision: 1,
      transcript: request.transcript,
    }));
    const firstController = agentController(store, runtime, committedPersistence(store));
    const conversationId = store.getState().selectedConversationId!;
    const first = await firstController.send({ conversationId, text: 'resume me', attachments: [] });
    expect(first.status).toBe('retryable');
    expect(firstController.getState().phase).toBe('resume_available');
    expect(runtime.completeAgentRoundV2).toHaveBeenCalledTimes(1);

    const attempt = store.getState().conversations[conversationId]!.attempts[0]!;
    const journal = attempt.agent!;
    const projection: AgentAttemptProjectionV2 = {
      schema_version: 2,
      task_id: attempt.turnId,
      conversation_id: conversationId,
      attempt_id: attempt.attemptId,
      phase: journal.phase,
      controller_generation: journal.controller_generation,
      journal_revision: attempt.journalRevision ?? 0,
      authority_revision: 1,
      root: journal.root,
      policy: {
        schema_version: 1,
        policy_version: 'agent-v1',
        max_single_write_bytes: journal.policy.max_single_write_bytes,
        max_batch_write_bytes: journal.policy.max_batch_write_bytes,
        max_attempt_write_bytes: journal.policy.max_attempt_write_bytes,
      },
      registry: {
        schema_version: 2,
        registry_version: journal.tool_registry_version,
        toolset_sha256: journal.toolset_sha256,
        tools: [],
      },
      transcript: journal.transcript,
      round_index: journal.round_index,
      round_id: journal.round_lineage?.round_id ?? null,
      round_revision: journal.round_lineage?.native_row_revision ?? null,
      round_status: journal.round_lineage?.status ?? null,
      batch_kind: null,
      batch_revision: null,
      manifest_sha256: null,
      call_index: null,
      batch: [],
      frozen_grant_ids: [...journal.frozen_grant_ids],
      reserved_write_bytes: journal.reserved_write_bytes,
      cancel_source_event_id: null,
      cleanup_id: null,
    };
    (runtime.queryAgentAttempt as jest.Mock).mockResolvedValue({
      schema_version: 2,
      status: 'active',
      attempt: projection,
    } as QueryAgentAttemptResultV2);
    (runtime.recoverAgentAttempt as jest.Mock).mockImplementation(async (request: any): Promise<RecoverAgentAttemptResultV2> => ({
      schema_version: 2,
      status: 'manual_reconciliation',
      operation_id: request.operation_id,
      next_action: 'inspect_native_state',
      attempt: projection,
      completed_round: null,
    }));

    const restarted = agentController(store, runtime, committedPersistence(store));
    const recovered = await restarted.resume(conversationId, attempt.attemptId);
    expect(recovered.status).toBe('retryable');
    expect(restarted.getState().phase).toBe('resume_available');
    expect(runtime.queryAgentAttempt).toHaveBeenCalledTimes(1);
    expect(runtime.recoverAgentAttempt).toHaveBeenCalledTimes(1);
    expect(runtime.completeAgentRoundV2).toHaveBeenCalledTimes(1);
    expect(runtime.prepareAgentToolBatch).not.toHaveBeenCalled();
    expect(runtime.executeAgentTool).not.toHaveBeenCalled();
  });

  test('drives write approval, commit, next round, and atomic final cleanup', async () => {
    const store = agentStore();
    const conversationId = store.getState().selectedConversationId!;
    const operations: ReturnType<typeof jest.fn>[] = [];
    const runtime = makeRuntime(operations);
    const originalCheckpointAgentRound = store.checkpointAgentRound.bind(store);
    const roundCommitByOperationId = new Map<string, jest.Mock>();
    const roundCommits: Array<{
      readonly kind: string;
      readonly commit: jest.Mock;
    }> = [];
    const roundStore = jest
      .spyOn(store, 'checkpointAgentRound')
      .mockImplementation(input => {
        const transaction = originalCheckpointAgentRound(input);
        if (transaction === null) return null;
        const originalCommit = transaction.commit.bind(transaction);
        const commit = jest.fn(
          (proof: Parameters<typeof transaction.commit>[0]) =>
            originalCommit(proof),
        );
        roundCommitByOperationId.set(input.evidence.operation_id, commit);
        roundCommits.push({ kind: input.evidence.kind, commit });
        return { ...transaction, commit };
      });
    const executionStore = jest.spyOn(store, 'insertAgentExecutionIntent');
    const receiptStore = jest.spyOn(store, 'recordAgentToolResult');
    const opIds = [...IDS];
    const committedSnapshots: NonNullable<
      CompletionPersistenceResult['snapshot']
    >[] = [];
    const committedSessions: Array<{
      readonly snapshot: NonNullable<CompletionPersistenceResult['snapshot']>;
      readonly session: string;
    }> = [];
    const persistCurrent = jest.fn(async (): Promise<CompletionPersistenceResult> => {
      const session = store.serialize();
      const digest = sessionSnapshotSHA256(session)!;
      const generation = (store.getSessionAuthority()?.generation ?? 1) + 1;
      const snapshot = { schema_version: 1 as const, generation, session_sha256: digest };
      committedSnapshots.push(snapshot);
      committedSessions.push({ snapshot, session });
      store.setSessionAuthority({ generation, sessionSha256: digest });
      return { status: 'committed', snapshot };
    });
    const controller = createCompletionController({
      chat: store,
      persistCurrent,
      completeRoundV2: jest.fn(),
      completeRoundV3: jest.fn(),
      cancelRoundV2: jest.fn(),
      cancelRoundV3: jest.fn(),
      createRoundId: jest.fn(() => opIds.shift() ?? AGENT_TURN),
      createOperationId: jest.fn(() => opIds.shift() ?? AGENT_ATTEMPT),
      agentRuntime: runtime,
      requestAgentApproval: jest.fn(async () => ({ status: 'approved', scope: 'once' })),
      now: () => NOW,
    });
    const result = await controller.send({ conversationId, text: 'write and commit', attachments: [] });
    expect(result.status).toBe('completed');
    expect(runtime.prepareAgentAttempt).toHaveBeenCalledTimes(1);
    expect(runtime.completeAgentRoundV2).toHaveBeenCalledTimes(2);
    expect(runtime.prepareAgentToolBatch).toHaveBeenCalledTimes(1);
    expect(runtime.bindAgentApproval).toHaveBeenCalledTimes(2);
    expect(runtime.executeAgentTool).toHaveBeenCalledTimes(2);
    expect(runtime.finalizeAgentAttempt).toHaveBeenCalledTimes(1);
    expect(runtime.discardAgentAttempt).toHaveBeenCalledTimes(1);
    expect(roundStore.mock.calls.map(call => call[0]?.evidence?.kind)).toEqual([
      'begin_round',
      'complete_agent_round_v2',
      'prepare_agent_tool_batch',
      'begin_round',
    ]);
    const completeRoundCheckpoint = roundStore.mock.calls.find(
      call => call[0]?.evidence?.kind === 'complete_agent_round_v2',
    );
    const batchCheckpoint = roundStore.mock.calls.find(
      call => call[0]?.evidence?.kind === 'prepare_agent_tool_batch',
    );
    const completeRoundEvidence = completeRoundCheckpoint?.[0]?.evidence;
    const batchEvidence = batchCheckpoint?.[0]?.evidence;
    if (
      completeRoundEvidence?.kind !== 'complete_agent_round_v2' ||
      batchEvidence?.kind !== 'prepare_agent_tool_batch'
    ) throw new Error('missing exact round/batch evidence');
    const batchNative = runtime.prepareAgentToolBatch as jest.Mock;
    const batchRequest = batchNative.mock.calls[0]?.[0];
    const batchResult = await batchNative.mock.results[0]?.value;
    expect(completeRoundEvidence.operation_id).not.toBe(batchEvidence.operation_id);
    expect(batchEvidence.operation_id).toBe(batchRequest.operation_id);
    expect(batchEvidence.request).toStrictEqual(batchRequest);
    expect(batchEvidence.result).toStrictEqual(batchResult);

    const completeRoundCommit = roundCommitByOperationId.get(
      completeRoundEvidence.operation_id,
    );
    const beginRoundEvidence = roundStore.mock.calls.find(
      call => call[0]?.evidence?.kind === 'begin_round',
    )?.[0]?.evidence;
    if (beginRoundEvidence?.kind !== 'begin_round') {
      throw new Error('missing begin-round evidence');
    }
    const beginRoundCommit = roundCommits.find(
      entry => entry.kind === 'begin_round',
    )?.commit;
    const nextRoundCommit = roundCommits.filter(
      entry => entry.kind === 'begin_round',
    )[1]?.commit;
    const batchCommit = roundCommitByOperationId.get(batchEvidence.operation_id);
    expect(beginRoundCommit).toHaveBeenCalledTimes(1);
    expect(nextRoundCommit).toHaveBeenCalledTimes(1);
    expect(completeRoundCommit).toHaveBeenCalledTimes(1);
    expect(batchCommit).toHaveBeenCalledTimes(1);
    expect(completeRoundCommit!.mock.results[0]?.value).toBe(true);
    expect(batchCommit!.mock.results[0]?.value).toBe(true);
    const completeRoundProof = completeRoundCommit!.mock.calls[0]?.[0];
    const beginRoundProof = beginRoundCommit!.mock.calls[0]?.[0];
    const nextRoundProof = nextRoundCommit!.mock.calls[0]?.[0];
    const batchProof = batchCommit!.mock.calls[0]?.[0];
    expect(committedSnapshots).toContain(completeRoundProof);
    expect(committedSnapshots).toContain(batchProof);
    expect(committedSnapshots).toContain(nextRoundProof);
    const beginSession = committedSessions.find(
      entry => entry.snapshot === beginRoundProof,
    )?.session;
    const completeSession = committedSessions.find(
      entry => entry.snapshot === completeRoundProof,
    )?.session;
    const nextRoundSession = committedSessions.find(
      entry => entry.snapshot === nextRoundProof,
    )?.session;
    expect(beginSession).toBeDefined();
    expect(completeSession).toBeDefined();
    expect(nextRoundSession).toBeDefined();
    const fixtures = nodePath.resolve(
      __dirname,
      '../ios/DSHMobileTests/Fixtures',
    );
    expect(`${beginSession}\n`).toBe(nodeFs.readFileSync(
      nodePath.resolve(fixtures, 'agent-begin-round-session.json'),
      'utf8',
    ));
    expect(`${completeSession}\n`).toBe(nodeFs.readFileSync(
      nodePath.resolve(fixtures, 'agent-first-round-complete-session.json'),
      'utf8',
    ));
    expect(`${nextRoundSession}\n`).toBe(nodeFs.readFileSync(
      nodePath.resolve(fixtures, 'agent-next-round-after-tool-session.json'),
      'utf8',
    ));
    expect(batchRequest.committed_checkpoint).toMatchObject({
      session_generation: completeRoundProof.generation,
      session_sha256: completeRoundProof.session_sha256,
    });
    expect(completeRoundCommit!.mock.invocationCallOrder[0]!).toBeLessThan(
      batchNative.mock.invocationCallOrder[0]!,
    );
    for (const native of [runtime.bindAgentApproval, runtime.executeAgentTool]) {
      for (const invocation of (native as jest.Mock).mock.invocationCallOrder) {
        expect(batchCommit!.mock.invocationCallOrder[0]!).toBeLessThan(invocation);
      }
    }
    expect(executionStore.mock.calls).toHaveLength(2);
    expect(executionStore.mock.calls.map(call => call[0]?.evidence?.operation_id)).toEqual(
      (runtime.executeAgentTool as jest.Mock).mock.calls.map(call => call[0]?.operation_id),
    );
    expect(receiptStore.mock.calls.map(call => call[0]?.events[0]?.event_id)).toEqual(
      (runtime.executeAgentTool as jest.Mock).mock.calls.map(call => call[0]?.operation_id),
    );
    expect(persistCurrent).toHaveBeenCalled();
    const committedPersistOrders = persistCurrent.mock.invocationCallOrder;
    for (const native of [
      runtime.prepareAgentAttempt,
      runtime.completeAgentRoundV2,
      runtime.prepareAgentToolBatch,
      runtime.bindAgentApproval,
      runtime.executeAgentTool,
      runtime.finalizeAgentAttempt,
      runtime.discardAgentAttempt,
    ]) {
      for (const invocation of (native as jest.Mock).mock.invocationCallOrder) {
        expect(committedPersistOrders.some(order => order < invocation)).toBe(true);
      }
    }
    expect(store.getState().agentTranscriptCleanupOutbox).toEqual([]);
    const completedAttempt = store.getState().conversations[conversationId]?.attempts[0];
    expect(completedAttempt).toMatchObject({ status: 'completed', agent: { phase: 'final_response' } });
    expect(completedAttempt?.visibleHistorySha256).not.toBe('f'.repeat(64));
    expect(completedAttempt?.rounds.every(
      round => round.visibleHistorySha256 === 'f'.repeat(64),
    )).toBe(true);
  });

  test('keeps a rejected Agent batch recoverable with its native failure code', async () => {
    const store = agentStore();
    const conversationId = store.getState().selectedConversationId!;
    const runtime = makeRuntime([]);
    const requestAgentApproval = jest.fn(async () => ({
      status: 'approved' as const,
      scope: 'once' as const,
    }));
    (runtime.prepareAgentToolBatch as jest.Mock).mockImplementationOnce(
      async (request: PrepareAgentToolBatchRequestV2): Promise<PrepareAgentToolBatchResultV2> => ({
        schema_version: 2,
        status: 'rejected',
        operation_id: request.operation_id,
        failure_code: 'E_AGENT_CONFLICT',
        expected_batch_revision: request.expected_batch_revision,
        expected_reserved_write_bytes: request.expected_reserved_write_bytes,
        result_reserved_write_bytes: request.expected_reserved_write_bytes,
        effect_gate: 'closed',
        reservation_status: 'unchanged',
        effect_dispatched: false,
        retry_advice: 'requery',
      }),
    );
    (runtime.queryAgentAttempt as jest.Mock).mockResolvedValue({
      schema_version: 2,
      status: 'not_found',
      failure_code: 'E_AGENT_NOT_FOUND',
    } satisfies QueryAgentAttemptResultV2);
    const failAttempt = jest.spyOn(store, 'failAttempt');
    const controller = agentController(
      store,
      runtime,
      committedPersistence(store),
      [...IDS],
      requestAgentApproval,
    );

    const result = await controller.send({
      conversationId,
      text: 'write an existing file',
      attachments: [],
    });

    expect(result).toMatchObject({ status: 'retryable', code: 'E_AGENT_CONFLICT' });
    expect(controller.getState()).toMatchObject({
      phase: 'resume_available',
      conversationId,
      failureCode: 'E_AGENT_CONFLICT',
    });
    expect(failAttempt).not.toHaveBeenCalled();
    expect(requestAgentApproval).not.toHaveBeenCalled();
    expect(runtime.bindAgentApproval).not.toHaveBeenCalled();
    expect(runtime.executeAgentTool).not.toHaveBeenCalled();
    expect(store.getState().conversations[conversationId]?.attempts[0]).toMatchObject({
      status: 'prepared',
      failureCode: null,
      agent: { phase: 'batch_frozen' },
    });
    const resumed = await controller.resume(
      conversationId,
      result.attemptId!,
    );
    expect(resumed).toMatchObject({ status: 'retryable', code: 'E_COMPLETION_HISTORY' });
    expect(runtime.queryAgentAttempt).toHaveBeenCalledTimes(1);
  });

  test('carries the persisted batch authority into a second write batch', async () => {
    const store = agentStore();
    const conversationId = store.getState().selectedConversationId!;
    const operations: ReturnType<typeof jest.fn>[] = [];
    const secondBatch: readonly AgentRuntimeFixtureCall[] = [
      { callId: 'write-call-2', name: 'write_file', argumentsSha256: '6'.repeat(64), access: 'conversation_confirm' },
    ];
    const runtime = makeRuntime(operations, {
      batchRounds: [defaultBatchCalls, secondBatch],
      finalRoundIndex: 2,
    });
    const persistCurrent = committedPersistence(store);
    const additionalOperationIds = Array.from({ length: 40 }, (_, index) => {
      const suffix = (index + 1).toString(16).padStart(12, '0');
      return `${suffix.slice(0, 8)}-${suffix.slice(0, 4)}-4${suffix.slice(0, 3)}-8${suffix.slice(0, 3)}-${suffix}`;
    });
    const controller = agentController(store, runtime, persistCurrent, [...IDS, ...additionalOperationIds]);

    const result = await controller.send({ conversationId, text: 'two write batches', attachments: [] });
    expect(result.status).toBe('completed');
    expect(runtime.completeAgentRoundV2).toHaveBeenCalledTimes(3);
    expect(runtime.prepareAgentToolBatch).toHaveBeenCalledTimes(2);
    expect(runtime.executeAgentTool).toHaveBeenCalledTimes(3);
    const batchRequests = (runtime.prepareAgentToolBatch as jest.Mock).mock.calls.map(call => call[0]);
    expect(batchRequests.map(request => request.expected_batch_revision)).toEqual([0, 1]);
    expect(batchRequests.every(request => request.expected_batch_revision >= 0)).toBe(true);
    const batchResults = await Promise.all(
      (runtime.prepareAgentToolBatch as jest.Mock).mock.results.map(resultValue => resultValue.value),
    );
    const executeRequests = (runtime.executeAgentTool as jest.Mock).mock.calls.map(call => call[0]);
    expect(executeRequests.map(request => request.expected_batch_revision)).toEqual([1, 1, 2]);
    expect(executeRequests.every(request => request.manifest_sha256 === MANIFEST_SHA)).toBe(true);
    expect(batchResults.map(resultValue => resultValue.receipt.batch_revision)).toEqual([1, 2]);
  });

  test('uses batch authority for a mixed auto and write batch', async () => {
    const store = agentStore();
    const conversationId = store.getState().selectedConversationId!;
    const runtime = makeRuntime([], {
      batchRounds: [[
        { callId: 'read-call', name: 'read_file', argumentsSha256: '8'.repeat(64), access: 'auto' },
        { callId: 'write-call-mixed', name: 'write_file', argumentsSha256: '9'.repeat(64), access: 'conversation_confirm' },
      ]],
      finalRoundIndex: 1,
    });
    const persistCurrent = committedPersistence(store);
    const controller = agentController(store, runtime, persistCurrent, [...IDS, ...Array.from({ length: 30 }, (_, index) => {
      const suffix = (index + 1).toString(16).padStart(12, '0');
      return `${suffix.slice(0, 8)}-${suffix.slice(0, 4)}-4${suffix.slice(0, 3)}-8${suffix.slice(0, 3)}-${suffix}`;
    })]);

    const result = await controller.send({ conversationId, text: 'read then write', attachments: [] });

    expect(result.status).toBe('completed');
    expect(runtime.prepareAgentToolBatch).toHaveBeenCalledTimes(1);
    expect(runtime.bindAgentApproval).toHaveBeenCalledTimes(1);
    expect(runtime.executeAgentTool).toHaveBeenCalledTimes(2);
    expect((runtime.prepareAgentToolBatch as jest.Mock).mock.calls[0]?.[0].expected_batch_revision).toBe(0);
    expect((runtime.executeAgentTool as jest.Mock).mock.calls.every(call => call[0].expected_batch_revision === 1)).toBe(true);
    expect((runtime.executeAgentTool as jest.Mock).mock.calls[0]?.[0].name).toBe('read_file');
    expect((runtime.executeAgentTool as jest.Mock).mock.calls[1]?.[0].name).toBe('write_file');
  });

  test('keeps durable-deny calls terminal without executing them', async () => {
    const store = agentStore();
    const conversationId = store.getState().selectedConversationId!;
    const runtime = makeRuntime([], {
      batchRounds: [[
        { callId: 'unknown-call', name: 'unknown_tool', argumentsSha256: 'b'.repeat(64), access: 'durable_deny' },
        { callId: 'read-call-deny', name: 'read_file', argumentsSha256: 'a'.repeat(64), access: 'auto' },
      ]],
      finalRoundIndex: 1,
    });
    const persistCurrent = committedPersistence(store);
    const controller = agentController(store, runtime, persistCurrent, [...IDS, ...Array.from({ length: 30 }, (_, index) => {
      const suffix = (index + 1).toString(16).padStart(12, '0');
      return `${suffix.slice(0, 8)}-${suffix.slice(0, 4)}-4${suffix.slice(0, 3)}-8${suffix.slice(0, 3)}-${suffix}`;
    })]);

    const result = await controller.send({ conversationId, text: 'read with denied tool', attachments: [] });

    expect(result.status).toBe('completed');
    expect(runtime.bindAgentApproval).not.toHaveBeenCalled();
    expect(runtime.executeAgentTool).toHaveBeenCalledTimes(1);
    expect((runtime.executeAgentTool as jest.Mock).mock.calls[0]?.[0].name).toBe('read_file');
    expect((runtime.prepareAgentToolBatch as jest.Mock).mock.calls[0]?.[0].expected_batch_revision).toBe(0);
  });

  test('atomically finalizes a cancelled tool result with cleanup', async () => {
    const store = agentStore();
    const conversationId = store.getState().selectedConversationId!;
    const runtime = makeRuntime([], {
      batchRounds: [[
        { callId: 'cancelled-write', name: 'write_file', argumentsSha256: 'c'.repeat(64), access: 'conversation_confirm' },
      ]],
      finalRoundIndex: 1,
      cancelledCallIds: ['cancelled-write'],
    });
    const persistCurrent = committedPersistence(store);
    const finalStore = jest.spyOn(store, 'completeAgentAttempt');
    const receiptStore = jest.spyOn(store, 'recordAgentToolResult');
    const cleanupAck = jest.spyOn(store, 'acknowledgeAgentTranscriptCleanupTransaction');
    const controller = agentController(store, runtime, persistCurrent, [...IDS, ...Array.from({ length: 30 }, (_, index) => {
      const suffix = (index + 1).toString(16).padStart(12, '0');
      return `${suffix.slice(0, 8)}-${suffix.slice(0, 4)}-4${suffix.slice(0, 3)}-8${suffix.slice(0, 3)}-${suffix}`;
    })]);

    const result = await controller.send({ conversationId, text: 'cancelled tool', attachments: [] });

    expect(result.status).toBe('completed');
    expect(runtime.executeAgentTool).toHaveBeenCalledTimes(1);
    expect(receiptStore).not.toHaveBeenCalled();
    expect(finalStore).toHaveBeenCalledTimes(1);
    expect(finalStore.mock.calls[0]?.[0]).toMatchObject({
      assistantMessage: null,
      journal: { phase: 'cancelled' },
      evidence: { kind: 'execute_agent_tool' },
      cleanup: { reason: 'cancelled' },
    });
    const executeRequest = (runtime.executeAgentTool as jest.Mock).mock.calls[0]?.[0];
    const finalEvents = finalStore.mock.calls[0]?.[0]?.events ?? [];
    expect(finalEvents).toHaveLength(3);
    expect(finalEvents[0]).toMatchObject({
      event_id: executeRequest.operation_id,
      kind: 'tool_call',
      status: 'running',
      call_id: 'cancelled-write',
    });
    expect(finalEvents[1]).toMatchObject({
      kind: 'tool_result',
      status: 'cancelled',
      call_id: 'cancelled-write',
    });
    expect(finalEvents[1]?.event_id).not.toBe(executeRequest.operation_id);
    expect(finalEvents[2]).toMatchObject({
      kind: 'terminal',
      status: 'cancelled',
      call_id: null,
    });
    expect(new Set(finalEvents.map(event => event.event_id)).size).toBe(3);
    expect(runtime.finalizeAgentAttempt).toHaveBeenCalledTimes(1);
    expect(runtime.discardAgentAttempt).toHaveBeenCalledTimes(1);
    expect(cleanupAck).toHaveBeenCalledTimes(1);
    expect(store.getState().agentTranscriptCleanupOutbox).toEqual([]);
    expect(store.getState().conversations[conversationId]?.messages).toHaveLength(1);
    expect(store.getState().conversations[conversationId]?.attempts[0]).toMatchObject({
      status: 'cancelled',
      assistantMessageId: null,
      agent: { phase: 'cancelled' },
    });
  });
});

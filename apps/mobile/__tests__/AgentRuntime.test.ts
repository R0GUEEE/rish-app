import { NativeModules, TurboModuleRegistry } from 'react-native';

const native = {
  prepare_agent_attempt: jest.fn(),
  complete_agent_round_v2: jest.fn(),
  prepare_agent_tool_batch: jest.fn(),
  bind_agent_approval: jest.fn(),
  execute_agent_tool: jest.fn(),
  cancel_agent_attempt: jest.fn(),
  query_agent_attempt: jest.fn(),
  query_agent_tool: jest.fn(),
  recover_agent_attempt: jest.fn(),
  finalize_agent_attempt: jest.fn(),
  discard_agent_attempt: jest.fn(),
  interrupt_agent_attempt: jest.fn(),
  query_agent_cleanup: jest.fn(),
};

const LEGACY_SELECTORS = [
  'createAgentTranscript',
  'validateAgentTranscript',
  'createAgentRound',
  'claimAgentRound',
  'casAgentRound',
  'claimAgentExecution',
  'casAgentExecution',
  'queryAgentExecution',
  'reserveWriteBytes',
  'openAgentWriteBatchEffectGate',
  'reconcileAgentExecution',
] as const;
const turboModuleGet = jest.spyOn(TurboModuleRegistry, 'get');
turboModuleGet.mockReturnValue(null);

(NativeModules as Record<string, unknown>).AgentRuntime = native;

const { AgentRuntime, AgentRuntimeError } = jest.requireActual(
  '../src/native/AgentRuntime',
) as typeof import('../src/native/AgentRuntime');

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const CLEANUP_ID = '44444444-4444-4444-8444-444444444444';
const SHA256 = 'a'.repeat(64);

const controllerCas = {
  schema_version: 1 as const,
  conversation_id: CONVERSATION_ID,
  task_id: TASK_ID,
  attempt_id: ATTEMPT_ID,
  expected_controller_generation: 1,
  expected_journal_revision: 1,
  expected_session_generation: 1,
  expected_session_sha256: SHA256,
};

const checkpoint = {
  schema_version: 1 as const,
  journal_revision: 1,
  session_generation: 1,
  session_sha256: SHA256,
};

const root = {
  schema_version: 1 as const,
  kind: 'workspace' as const,
  workspace_id: CONVERSATION_ID,
  workspace_binding_revision: 1,
  project_id: null,
  root_fingerprint_sha256: SHA256,
  capabilities: ['file_read'] as const,
};

const transcript = {
  schema_version: 1 as const,
  transcript_ref: CLEANUP_ID,
  generation: 0,
  transcript_sha256: SHA256,
  transcript_bytes: 0,
};

const policy = {
  schema_version: 1 as const,
  policy_version: 'agent-v1' as const,
  max_single_write_bytes: 32768 as const,
  max_batch_write_bytes: 32768,
  max_attempt_write_bytes: 32768,
};

const registry = {
  schema_version: 2 as const,
  registry_version: 1 as const,
  toolset_sha256: SHA256,
  tools: [
    {
      schema_version: 2 as const,
      name: 'list_dir',
      safe_summary_key: 'agent.list_dir',
      access: 'auto' as const,
    },
  ],
};

const attempt = {
  schema_version: 2 as const,
  task_id: TASK_ID,
  conversation_id: CONVERSATION_ID,
  attempt_id: ATTEMPT_ID,
  phase: 'ready_for_round' as const,
  controller_generation: 1,
  journal_revision: 1,
  authority_revision: 1,
  root,
  policy,
  registry,
  transcript,
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
};

const prepareRequest = {
  schema_version: 2 as const,
  operation_id: CLEANUP_ID,
  controller_cas: controllerCas,
  committed_checkpoint: checkpoint,
  task_id: TASK_ID,
  conversation_id: CONVERSATION_ID,
  attempt_id: ATTEMPT_ID,
  workspace_id: CONVERSATION_ID,
  project_id: null,
  workspace_binding_revision: 1,
  transport_schema_version: 2 as const,
  harness_id: 'dsh' as const,
  model: 'deepseek-v4-flash' as const,
  thinking_mode: 'off' as const,
  visible_message_ids: [],
  visible_history_sha256: SHA256,
  visible_message_count: 0,
  project_context_sha256: null,
  registry_version: 1 as const,
  expected_policy_version: null,
  expected_transcript: null,
};

const prepareResult = {
  schema_version: 2 as const,
  status: 'prepared' as const,
  operation_id: CLEANUP_ID,
  attempt,
  observed_checkpoint: checkpoint,
};

const ROUND_ID = '55555555-5555-4555-8555-555555555555';
const CALL_ID = 'call-0';
const completeRequest = {
  schema_version: 2 as const,
  operation_id: CLEANUP_ID,
  controller_cas: controllerCas,
  committed_checkpoint: checkpoint,
  task_id: TASK_ID,
  conversation_id: CONVERSATION_ID,
  attempt_id: ATTEMPT_ID,
  round_id: ROUND_ID,
  round_index: 0,
  launch_attempt: 1,
  expected_round_revision: 0,
  transport_schema_version: 2 as const,
  harness_id: 'dsh' as const,
  model: 'deepseek-v4-flash' as const,
  thinking_mode: 'off' as const,
  visible_history_sha256: SHA256,
  visible_message_count: 0,
  project_context_sha256: null,
  transcript,
  root,
  registry_version: 1 as const,
  toolset_sha256: SHA256,
};

const roundReceipt = {
  schema_version: 2 as const,
  transport_schema_version: 2 as const,
  harness_id: 'dsh' as const,
  turn_id: TASK_ID,
  task_id: TASK_ID,
  attempt_id: ATTEMPT_ID,
  round_id: ROUND_ID,
  round_index: 0,
  provider_request_id: 'provider-request',
  provider_response_id: 'provider-response',
  requested_model: 'deepseek-v4-flash' as const,
  model: 'deepseek-v4-flash' as const,
  thinking_mode: 'off' as const,
  finish_reason: 'stop' as const,
  latency_ms: 0,
  visible_history_sha256: SHA256,
  model_input_sha256: SHA256,
  request_body_sha256: SHA256,
  project_context_receipt: null,
};

const completedRoundResult = {
  schema_version: 2 as const,
  status: 'completed' as const,
  operation_id: CLEANUP_ID,
  task_id: TASK_ID,
  attempt_id: ATTEMPT_ID,
  round_id: ROUND_ID,
  round_index: 0,
  launch_attempt: 1,
  result_round_revision: 1,
  transcript,
  outcome: {
    schema_version: 3 as const,
    kind: 'final' as const,
    finish_reason: 'stop' as const,
    completion_receipt: roundReceipt,
    transcript,
    text: '',
    reasoning: '',
  },
};

const batchRequest = {
  schema_version: 2 as const,
  operation_id: CLEANUP_ID,
  controller_cas: controllerCas,
  committed_checkpoint: checkpoint,
  task_id: TASK_ID,
  conversation_id: CONVERSATION_ID,
  attempt_id: ATTEMPT_ID,
  round_id: ROUND_ID,
  round_index: 0,
  expected_round_revision: 1,
  transcript,
  root,
  registry_version: 1 as const,
  toolset_sha256: SHA256,
  policy_version: 'agent-v1' as const,
  expected_batch_revision: 0,
  expected_reserved_write_bytes: 0,
};

const batchResult = {
  schema_version: 2 as const,
  status: 'prepared' as const,
  operation_id: CLEANUP_ID,
  receipt: {
    schema_version: 2 as const,
    task_id: TASK_ID,
    attempt_id: ATTEMPT_ID,
    round_id: ROUND_ID,
    round_index: 0,
    batch_kind: 'read_only_batch' as const,
    batch_revision: 1,
    manifest_sha256: null,
    transcript,
    calls: [],
    batch_new_write_bytes: 0,
    reserved_write_bytes: 0,
    effect_gate: 'not_applicable' as const,
  },
  observed_checkpoint: checkpoint,
};

const approvalToken = {
  schema_version: 2 as const,
  token: CLEANUP_ID,
  controller_cas: controllerCas,
  task_id: TASK_ID,
  attempt_id: ATTEMPT_ID,
  round_id: ROUND_ID,
  round_index: 0,
  batch_call_ids: [CALL_ID],
  batch_arguments_sha256: [SHA256],
  batch_revision: 1,
  manifest_sha256: SHA256,
  call_index: 0,
  call_id: CALL_ID,
  name: 'write_file',
  arguments_sha256: SHA256,
  idempotency_key: SHA256,
  root_fingerprint_sha256: SHA256,
  binding_revision: 1,
  policy_version: 'agent-v1' as const,
  registry_version: 1 as const,
  access: 'conversation_confirm' as const,
  allowed_decisions: [
    'denied',
    'allow_once',
    'allow_conversation',
    'cancelled',
  ] as const,
};

const bindRequest = {
  schema_version: 2 as const,
  operation_id: CLEANUP_ID,
  controller_cas: controllerCas,
  committed_checkpoint: checkpoint,
  task_id: TASK_ID,
  conversation_id: CONVERSATION_ID,
  attempt_id: ATTEMPT_ID,
  round_id: ROUND_ID,
  round_index: 0,
  manifest_sha256: SHA256,
  batch_revision: 1,
  call_index: 0,
  call_id: CALL_ID,
  token: approvalToken,
  decision: 'allow_once' as const,
  deny_message: null,
};

const executeRequest = {
  schema_version: 2 as const,
  operation_id: CLEANUP_ID,
  controller_cas: controllerCas,
  committed_checkpoint: checkpoint,
  task_id: TASK_ID,
  conversation_id: CONVERSATION_ID,
  attempt_id: ATTEMPT_ID,
  round_id: ROUND_ID,
  round_index: 0,
  batch_kind: 'write_batch' as const,
  manifest_sha256: SHA256,
  expected_batch_revision: 1,
  call_index: 0,
  call_id: CALL_ID,
  name: 'write_file',
  arguments_sha256: SHA256,
  idempotency_key: SHA256,
  expected_execution_revision: 1,
  transcript,
  root,
  approval_reference: CLEANUP_ID,
};

const toolReceipt = {
  schema_version: 1 as const,
  call_id: CALL_ID,
  name: 'write_file',
  arguments_sha256: SHA256,
  result_sha256: SHA256,
  result_bytes: 0,
  truncated: false,
  duration_ms: 0,
  outcome: 'ok' as const,
  failure_code: null,
  approval_reference: CLEANUP_ID,
};

const cancelTarget = {
  schema_version: 2 as const,
  kind: 'round' as const,
  task_id: TASK_ID,
  attempt_id: ATTEMPT_ID,
  round_id: ROUND_ID,
  round_index: 0,
};

const cancelRequest = {
  schema_version: 2 as const,
  operation_id: CLEANUP_ID,
  controller_cas: controllerCas,
  committed_checkpoint: checkpoint,
  target: cancelTarget,
  cancel_token: {
    schema_version: 2 as const,
    issuer: 'completion_controller' as const,
    source_event_id: CLEANUP_ID,
    token: CLEANUP_ID,
    task_id: TASK_ID,
    attempt_id: ATTEMPT_ID,
    expected_phase: 'round_in_flight' as const,
    reason_code: 'E_AGENT_CANCELLED' as const,
  },
  expected_round_revision: 1,
  expected_execution_revision: null,
  expected_transcript: transcript,
  root,
};

const queryAttemptRequest = {
  schema_version: 2 as const,
  controller_cas: controllerCas,
  task_id: TASK_ID,
  conversation_id: CONVERSATION_ID,
  attempt_id: ATTEMPT_ID,
  expected_journal_revision: 1,
  expected_session_generation: 1,
  expected_session_sha256: SHA256,
  expected_transcript: transcript,
  expected_root_fingerprint_sha256: SHA256,
  expected_workspace_binding_revision: 1,
};

const queryToolRequest = {
  schema_version: 2 as const,
  controller_cas: controllerCas,
  task_id: TASK_ID,
  conversation_id: CONVERSATION_ID,
  attempt_id: ATTEMPT_ID,
  round_id: ROUND_ID,
  round_index: 0,
  call_index: 0,
  call_id: CALL_ID,
  idempotency_key: SHA256,
  expected_execution_revision: 0,
  expected_transcript: transcript,
  expected_root_fingerprint_sha256: SHA256,
  expected_workspace_binding_revision: 1,
};

const recoveryRequest = {
  schema_version: 2 as const,
  operation_id: CLEANUP_ID,
  controller_cas: controllerCas,
  committed_checkpoint: checkpoint,
  target: {
    schema_version: 2 as const,
    kind: 'attempt' as const,
    task_id: TASK_ID,
    attempt_id: ATTEMPT_ID,
  },
  action: 'reconcile' as const,
  expected_round_revision: null,
  expected_execution_revision: null,
  expected_transcript: transcript,
  root,
};

const finalizeRequest = {
  schema_version: 2 as const,
  operation_id: CLEANUP_ID,
  controller_cas: controllerCas,
  committed_checkpoint: checkpoint,
  task_id: TASK_ID,
  conversation_id: CONVERSATION_ID,
  attempt_id: ATTEMPT_ID,
  terminal_reason: 'completed' as const,
  cleanup_id: CLEANUP_ID,
  transcript,
  root,
};

const discardRequest = {
  schema_version: 2 as const,
  operation_id: CLEANUP_ID,
  cleanup_id: CLEANUP_ID,
  task_id: TASK_ID,
  conversation_id: CONVERSATION_ID,
  attempt_id: ATTEMPT_ID,
  transcript_ref: CLEANUP_ID,
  transcript_sha256: SHA256,
};

beforeEach(() => {
  (NativeModules as Record<string, unknown>).AgentRuntime = native;
  jest.clearAllMocks();
  turboModuleGet.mockReturnValue(null);
  for (const method of Object.values(native)) {
    method.mockResolvedValue(prepareResult);
  }
});

test('exposes exactly the approved high-level facade inventory', () => {
  expect(Object.keys(AgentRuntime).sort()).toEqual([
    'bindAgentApproval',
    'cancelAgentAttempt',
    'completeAgentRoundV2',
    'discardAgentAttempt',
    'executeAgentTool',
    'finalizeAgentAttempt',
    'interruptAgentAttempt',
    'isAvailable',
    'prepareAgentAttempt',
    'prepareAgentToolBatch',
    'queryAgentAttempt',
    'queryAgentCleanup',
    'queryAgentTool',
    'recoverAgentAttempt',
  ]);
  expect(AgentRuntime.isAvailable()).toBe(true);
  expect(
    (AgentRuntime as Record<string, unknown>).createAgentTranscript,
  ).toBeUndefined();
  expect(
    (AgentRuntime as Record<string, unknown>).casAgentExecution,
  ).toBeUndefined();
  expect(
    (AgentRuntime as Record<string, unknown>).reserveWriteBytes,
  ).toBeUndefined();
});

test('availability requires all 12 high-level selectors and rejects known legacy selectors', () => {
  const legacyOnly = {
    createAgentTranscript: jest.fn(),
    queryAgentExecution: jest.fn(),
    reconcileAgentExecution: jest.fn(),
  };
  (NativeModules as Record<string, unknown>).AgentRuntime = legacyOnly;
  expect(AgentRuntime.isAvailable()).toBe(false);

  const incomplete = { ...native };
  delete (incomplete as Partial<typeof native>).query_agent_cleanup;
  (NativeModules as Record<string, unknown>).AgentRuntime = incomplete;
  expect(AgentRuntime.isAvailable()).toBe(false);
});

test.each(LEGACY_SELECTORS)(
  'rejects a complete HostObject that also exposes legacy selector %s',
  legacySelector => {
    const mixedPrototype = {
      ...native,
      [legacySelector]: jest.fn(),
    };
    const mixed = Object.create(mixedPrototype);
    expect(Object.getOwnPropertyNames(mixed)).toEqual([]);
    (NativeModules as Record<string, unknown>).AgentRuntime = mixed;
    expect(AgentRuntime.isAvailable()).toBe(false);
  },
);

test('links prototype-backed HostObjects without relying on own names', () => {
  const snapshot = Object.create({
    ...native,
    unrelatedHostFunction: jest.fn(),
  });
  expect(Object.getOwnPropertyNames(snapshot)).toEqual([]);
  (NativeModules as Record<string, unknown>).AgentRuntime = snapshot;
  expect(AgentRuntime.isAvailable()).toBe(true);
});

test('accepts TurboModuleRegistry and NativeModules candidates', () => {
  const registryModule = Object.create(native);
  turboModuleGet.mockReturnValue(registryModule);
  (NativeModules as Record<string, unknown>).AgentRuntime = null;
  expect(AgentRuntime.isAvailable()).toBe(true);
  expect(turboModuleGet).toHaveBeenCalledWith('AgentRuntime');

  turboModuleGet.mockImplementation(() => {
    throw new Error('registry unavailable');
  });
  (NativeModules as Record<string, unknown>).AgentRuntime = native;
  expect(AgentRuntime.isAvailable()).toBe(true);
});

test('falls back when TurboModuleRegistry returns an incomplete proxy', () => {
  turboModuleGet.mockReturnValue({ prepare_agent_attempt: jest.fn() } as never);
  (NativeModules as Record<string, unknown>).AgentRuntime = native;
  expect(AgentRuntime.isAvailable()).toBe(true);
});

test('recovers when the native module is transiently absent', () => {
  const recovered = Object.create(native);
  turboModuleGet.mockReturnValueOnce(null).mockReturnValueOnce(recovered);
  (NativeModules as Record<string, unknown>).AgentRuntime = null;
  expect(AgentRuntime.isAvailable()).toBe(false);
  expect(AgentRuntime.isAvailable()).toBe(true);
});

test('reads a lazy required method once and keeps the bound callable snapshot', async () => {
  const snapshot = { ...native };
  let getterReads = 0;
  const lazy = jest.fn().mockResolvedValue({
    schema_version: 2,
    status: 'pending',
    cleanup_id: CLEANUP_ID,
  });
  Object.defineProperty(snapshot, 'query_agent_cleanup', {
    configurable: true,
    enumerable: false,
    get: () => {
      getterReads += 1;
      return lazy;
    },
  });
  (NativeModules as Record<string, unknown>).AgentRuntime = snapshot;
  expect(AgentRuntime.isAvailable()).toBe(true);
  expect(AgentRuntime.isAvailable()).toBe(true);
  expect(getterReads).toBe(1);

  await expect(
    AgentRuntime.queryAgentCleanup({
      schema_version: 2,
      cleanup_id: CLEANUP_ID,
    }),
  ).resolves.toMatchObject({ status: 'pending' });
  expect(lazy).toHaveBeenCalledTimes(1);
  expect(getterReads).toBe(1);
});

test('recovers from transient hostile required and legacy getters', () => {
  for (const selector of [
    'query_agent_cleanup',
    'createAgentTranscript',
  ] as const) {
    const snapshot = { ...native } as Record<string, unknown>;
    let getterReads = 0;
    Object.defineProperty(snapshot, selector, {
      configurable: true,
      get: () => {
        getterReads += 1;
        if (getterReads === 1) {
          throw new Error('transient hostile HostObject getter');
        }
        return selector === 'query_agent_cleanup'
          ? native.query_agent_cleanup
          : undefined;
      },
    });
    (NativeModules as Record<string, unknown>).AgentRuntime = snapshot;
    expect(AgentRuntime.isAvailable()).toBe(false);
    expect(AgentRuntime.isAvailable()).toBe(true);
    expect(AgentRuntime.isAvailable()).toBe(true);
    expect(getterReads).toBe(2);
  }
});

test('keeps the callable snapshot when a same-object native method is replaced', async () => {
  const snapshot = { ...native };
  const original = snapshot.query_agent_cleanup;
  original.mockResolvedValueOnce({
    schema_version: 2,
    status: 'pending',
    cleanup_id: CLEANUP_ID,
  });
  (NativeModules as Record<string, unknown>).AgentRuntime = snapshot;
  expect(AgentRuntime.isAvailable()).toBe(true);
  const replacement = jest.fn().mockResolvedValue({
    schema_version: 2,
    status: 'unknown',
    cleanup_id: CLEANUP_ID,
  });
  snapshot.query_agent_cleanup = replacement;

  await expect(
    AgentRuntime.queryAgentCleanup({
      schema_version: 2,
      cleanup_id: CLEANUP_ID,
    }),
  ).resolves.toMatchObject({ status: 'pending' });
  expect(original).toHaveBeenCalledTimes(1);
  expect(replacement).not.toHaveBeenCalled();
});

test('forwards only the high-level operation and a defensive safe request', async () => {
  native.prepare_agent_attempt.mockResolvedValueOnce(prepareResult);
  await expect(
    AgentRuntime.prepareAgentAttempt(prepareRequest),
  ).resolves.toEqual(prepareResult);
  expect(native.prepare_agent_attempt).toHaveBeenCalledTimes(1);
  expect(native.prepare_agent_attempt).toHaveBeenCalledWith(prepareRequest);
});

test('accepts an explicitly versioned DEBUG v2 registry projection', async () => {
  native.prepare_agent_attempt.mockResolvedValueOnce({
    ...prepareResult,
    attempt: {
      ...attempt,
      registry: {
        ...registry,
        registry_version: 2,
      },
    },
  });
  await expect(
    AgentRuntime.prepareAgentAttempt(prepareRequest),
  ).resolves.toMatchObject({
    attempt: { registry: { registry_version: 2 } },
  });
});

test('rejects CGI descriptors inside a legacy v1 registry', async () => {
  native.prepare_agent_attempt.mockResolvedValueOnce({
    ...prepareResult,
    attempt: {
      ...attempt,
      root: { ...attempt.root, capabilities: ['guest_service'] },
      registry: {
        ...registry,
        tools: [{
          schema_version: 2,
          name: 'start_guest_cgi',
          safe_summary_key: 'agent.start_guest_cgi',
          access: 'conversation_confirm',
        }],
      },
    },
  });
  await expect(
    AgentRuntime.prepareAgentAttempt(prepareRequest),
  ).rejects.toMatchObject({ code: 'E_AGENT_LEDGER' });
});

test('reopens a historical v1 session projection without upgrading its registry', async () => {
  native.query_agent_attempt.mockResolvedValueOnce({
    schema_version: 2,
    status: 'active',
    attempt,
  });
  await expect(
    AgentRuntime.queryAgentAttempt(queryAttemptRequest),
  ).resolves.toMatchObject({
    attempt: { registry: { registry_version: 1 } },
  });
});

test('maps every approved high-level method to its snake-case selector', async () => {
  native.complete_agent_round_v2.mockResolvedValueOnce(completedRoundResult);
  native.prepare_agent_tool_batch.mockResolvedValueOnce(batchResult);
  native.bind_agent_approval.mockResolvedValueOnce({
    schema_version: 2,
    status: 'bound',
    operation_id: CLEANUP_ID,
    task_id: TASK_ID,
    attempt_id: ATTEMPT_ID,
    round_id: ROUND_ID,
    call_index: 0,
    call_id: CALL_ID,
    decision: 'allow_once',
    approval_reference: CLEANUP_ID,
    grant: null,
    result_batch_revision: 1,
    observed_checkpoint: checkpoint,
    receipt: null,
    transcript: null,
  });
  native.execute_agent_tool.mockResolvedValueOnce({
    schema_version: 2,
    status: 'completed',
    operation_id: CLEANUP_ID,
    task_id: TASK_ID,
    attempt_id: ATTEMPT_ID,
    round_id: ROUND_ID,
    round_index: 0,
    call_index: 0,
    call_id: CALL_ID,
    name: 'write_file',
    idempotency_key: SHA256,
    result_execution_revision: 2,
    transcript,
    receipt: toolReceipt,
    effect_may_have_occurred: true,
  });
  native.cancel_agent_attempt.mockResolvedValueOnce({
    schema_version: 2,
    status: 'cancel_requested',
    operation_id: CLEANUP_ID,
    target: cancelTarget,
    result_round_revision: 2,
    result_execution_revision: null,
    transcript,
    receipt: null,
    effect_may_have_occurred: false,
    observed_checkpoint: checkpoint,
  });
  native.query_agent_attempt.mockResolvedValueOnce({
    schema_version: 2,
    status: 'active',
    attempt,
  });
  native.query_agent_tool.mockResolvedValueOnce({
    schema_version: 2,
    status: 'not_started',
  });
  native.recover_agent_attempt.mockResolvedValueOnce({
    schema_version: 2,
    status: 'resumed',
    operation_id: CLEANUP_ID,
    next_action: 'none',
    attempt,
    completed_round: null,
  });
  native.finalize_agent_attempt.mockResolvedValueOnce({
    schema_version: 2,
    status: 'terminal',
    operation_id: CLEANUP_ID,
    cleanup_id: CLEANUP_ID,
    transcript,
  });
  native.discard_agent_attempt.mockResolvedValueOnce({
    schema_version: 2,
    status: 'discarded',
    operation_id: CLEANUP_ID,
    cleanup_id: CLEANUP_ID,
  });
  native.interrupt_agent_attempt.mockResolvedValueOnce({
    schema_version: 2,
    status: 'discarded',
    operation_id: CLEANUP_ID,
    cleanup_id: CLEANUP_ID,
  });
  native.query_agent_cleanup.mockResolvedValueOnce({
    schema_version: 2,
    status: 'pending',
    cleanup_id: CLEANUP_ID,
  });

  await expect(
    AgentRuntime.completeAgentRoundV2(completeRequest),
  ).resolves.toEqual(completedRoundResult);
  await expect(
    AgentRuntime.prepareAgentToolBatch(batchRequest),
  ).resolves.toEqual(batchResult);
  await expect(
    AgentRuntime.bindAgentApproval(bindRequest),
  ).resolves.toMatchObject({
    status: 'bound',
  });
  await expect(
    AgentRuntime.executeAgentTool(executeRequest),
  ).resolves.toMatchObject({
    status: 'completed',
  });
  await expect(
    AgentRuntime.cancelAgentAttempt(cancelRequest),
  ).resolves.toMatchObject({
    status: 'cancel_requested',
  });
  await expect(
    AgentRuntime.queryAgentAttempt(queryAttemptRequest),
  ).resolves.toMatchObject({
    status: 'active',
  });
  await expect(AgentRuntime.queryAgentTool(queryToolRequest)).resolves.toEqual({
    schema_version: 2,
    status: 'not_started',
  });
  await expect(
    AgentRuntime.recoverAgentAttempt(recoveryRequest),
  ).resolves.toMatchObject({
    status: 'resumed',
  });
  await expect(
    AgentRuntime.finalizeAgentAttempt(finalizeRequest),
  ).resolves.toMatchObject({
    status: 'terminal',
  });
  await expect(
    AgentRuntime.discardAgentAttempt(discardRequest),
  ).resolves.toMatchObject({
    status: 'discarded',
  });
  await expect(
    AgentRuntime.interruptAgentAttempt({
      schema_version: 2,
      operation_id: CLEANUP_ID,
      cleanup_id: CLEANUP_ID,
      task_id: TASK_ID,
      conversation_id: CONVERSATION_ID,
      attempt_id: ATTEMPT_ID,
      transcript_ref: transcript.transcript_ref,
      transcript_sha256: transcript.transcript_sha256,
      reason: 'failed',
      expected_session_generation: 1,
      expected_session_sha256: SHA256,
    }),
  ).resolves.toMatchObject({
    status: 'discarded',
  });
  await expect(
    AgentRuntime.queryAgentCleanup({
      schema_version: 2,
      cleanup_id: CLEANUP_ID,
    }),
  ).resolves.toEqual({
    schema_version: 2,
    status: 'pending',
    cleanup_id: CLEANUP_ID,
  });

  expect(native.complete_agent_round_v2).toHaveBeenCalledTimes(1);
  expect(native.prepare_agent_tool_batch).toHaveBeenCalledTimes(1);
  expect(native.bind_agent_approval).toHaveBeenCalledTimes(1);
  expect(native.execute_agent_tool).toHaveBeenCalledTimes(1);
  expect(native.cancel_agent_attempt).toHaveBeenCalledTimes(1);
  expect(native.query_agent_attempt).toHaveBeenCalledTimes(1);
  expect(native.query_agent_tool).toHaveBeenCalledTimes(1);
  expect(native.recover_agent_attempt).toHaveBeenCalledTimes(1);
  expect(native.finalize_agent_attempt).toHaveBeenCalledTimes(1);
  expect(native.discard_agent_attempt).toHaveBeenCalledTimes(1);
  expect(native.interrupt_agent_attempt).toHaveBeenCalledTimes(1);
  expect(native.query_agent_cleanup).toHaveBeenCalledTimes(1);
});

test('keeps an immutable batch approval token while the bind CAS advances', async () => {
  const currentCas = {
    ...controllerCas,
    expected_controller_generation: 3,
    expected_journal_revision: 3,
    expected_session_generation: 3,
    expected_session_sha256: 'b'.repeat(64),
  };
  const currentCheckpoint = {
    ...checkpoint,
    journal_revision: 3,
    session_generation: 3,
    session_sha256: 'b'.repeat(64),
  };
  const request = {
    ...bindRequest,
    controller_cas: currentCas,
    committed_checkpoint: currentCheckpoint,
    token: approvalToken,
  };
  native.bind_agent_approval.mockResolvedValueOnce({
    schema_version: 2,
    status: 'bound',
    operation_id: CLEANUP_ID,
    task_id: TASK_ID,
    attempt_id: ATTEMPT_ID,
    round_id: ROUND_ID,
    call_index: 0,
    call_id: CALL_ID,
    decision: 'allow_once',
    approval_reference: CLEANUP_ID,
    grant: null,
    result_batch_revision: 1,
    observed_checkpoint: currentCheckpoint,
    receipt: null,
    transcript: null,
  });

  await expect(AgentRuntime.bindAgentApproval(request)).resolves.toMatchObject({
    status: 'bound',
  });
  expect(native.bind_agent_approval).toHaveBeenCalledWith(
    expect.objectContaining({
      controller_cas: currentCas,
      token: approvalToken,
    }),
  );
});

test('rejects unknown/raw keys before native and rejects raw result fields', async () => {
  const before = native.prepare_agent_attempt.mock.calls.length;
  await expect(
    AgentRuntime.prepareAgentAttempt({
      ...prepareRequest,
      path: '/private/raw',
    } as never),
  ).rejects.toMatchObject({
    code: 'E_AGENT_BAD_ARGUMENTS',
    message: 'E_AGENT_BAD_ARGUMENTS',
  });
  expect(native.prepare_agent_attempt).toHaveBeenCalledTimes(before);

  native.prepare_agent_attempt.mockResolvedValueOnce({
    ...prepareResult,
    native_envelope: { secret: true },
  });
  await expect(
    AgentRuntime.prepareAgentAttempt(prepareRequest),
  ).rejects.toMatchObject({
    code: 'E_AGENT_LEDGER',
    message: 'E_AGENT_LEDGER',
  });
});

test('rejects mutable/accessor nested safe values and malformed schema values', async () => {
  const accessor = { ...prepareRequest };
  Object.defineProperty(accessor, 'task_id', {
    configurable: true,
    enumerable: true,
    get: () => TASK_ID,
  });
  await expect(
    AgentRuntime.prepareAgentAttempt(accessor as never),
  ).rejects.toBeInstanceOf(AgentRuntimeError);

  await expect(
    AgentRuntime.prepareAgentAttempt({
      ...prepareRequest,
      visible_message_count: 1,
      visible_message_ids: [],
    } as never),
  ).rejects.toMatchObject({ code: 'E_AGENT_BAD_ARGUMENTS' });
});

test('accepts first-round cancellation revision zero', async () => {
  const request = { ...cancelRequest, expected_round_revision: 0 };
  native.cancel_agent_attempt.mockResolvedValueOnce({
    schema_version: 2,
    status: 'cancel_requested',
    operation_id: CLEANUP_ID,
    target: cancelTarget,
    result_round_revision: 1,
    result_execution_revision: null,
    transcript,
    receipt: null,
    effect_may_have_occurred: false,
    observed_checkpoint: checkpoint,
  });
  await expect(AgentRuntime.cancelAgentAttempt(request)).resolves.toMatchObject({
    status: 'cancel_requested',
    result_round_revision: 1,
  });
  expect(native.cancel_agent_attempt).toHaveBeenCalledWith(request);
});

test.each([-1, Number.NaN])(
  'rejects invalid round cancellation revision %s before native',
  async expectedRoundRevision => {
    await expect(AgentRuntime.cancelAgentAttempt({
      ...cancelRequest,
      expected_round_revision: expectedRoundRevision,
    } as never)).rejects.toMatchObject({ code: 'E_AGENT_BAD_ARGUMENTS' });
    expect(native.cancel_agent_attempt).not.toHaveBeenCalled();
  },
);

test('rejects tool cancellation execution revision zero before native', async () => {
  await expect(AgentRuntime.cancelAgentAttempt({
    ...cancelRequest,
    target: {
      schema_version: 2,
      kind: 'tool',
      task_id: TASK_ID,
      attempt_id: ATTEMPT_ID,
      round_id: ROUND_ID,
      round_index: 0,
      call_index: 0,
      call_id: CALL_ID,
      idempotency_key: SHA256,
    },
    cancel_token: {
      ...cancelRequest.cancel_token,
      expected_phase: 'execution_intent',
    },
    expected_round_revision: null,
    expected_execution_revision: 0,
  } as never)).rejects.toMatchObject({ code: 'E_AGENT_BAD_ARGUMENTS' });
  expect(native.cancel_agent_attempt).not.toHaveBeenCalled();
});

test('maps native errors to closed code-only failures', async () => {
  native.query_agent_cleanup.mockRejectedValueOnce(
    new Error('native path or body must not escape'),
  );
  await expect(
    AgentRuntime.queryAgentCleanup({
      schema_version: 2,
      cleanup_id: CLEANUP_ID,
    }),
  ).rejects.toEqual(
    expect.objectContaining({
      code: 'E_AGENT_PERSISTENCE',
      message: 'E_AGENT_PERSISTENCE',
    }),
  );
});

test.each([
  'E_CONTEXT_CHANGED', 'E_CONTEXT_STORAGE', 'E_CONTEXT_CONSENT_INVALID',
  'E_CONTEXT_SNAPSHOT_MISSING', 'E_CONTEXT_INTEGRITY',
])('preserves pre-round context failure %s without native details', async code => {
  native.complete_agent_round_v2.mockRejectedValueOnce({
    code, message: 'private native path must not escape',
  });
  await expect(AgentRuntime.completeAgentRoundV2(completeRequest))
    .rejects.toMatchObject({ code, message: code });
  expect(native.complete_agent_round_v2).toHaveBeenCalledTimes(1);
});

test('requires every controller CAS session field to equal the committed checkpoint', async () => {
  const mismatch = {
    ...prepareRequest,
    controller_cas: {
      ...controllerCas,
      expected_session_generation: 2,
    },
  };
  await expect(
    AgentRuntime.prepareAgentAttempt(mismatch as never),
  ).rejects.toMatchObject({ code: 'E_AGENT_BAD_ARGUMENTS' });
  expect(native.prepare_agent_attempt).not.toHaveBeenCalled();
});

test('requires gated and durable-deny batch projections to be closed and relation-safe', async () => {
  const baseCall = {
    schema_version: 2,
    call_index: 0,
    call_id: CALL_ID,
    name: 'list_dir',
    arguments_sha256: SHA256,
    idempotency_key: SHA256,
    safe_summary_key: 'agent.list_dir',
    access: 'auto',
    approval_state: 'not_required',
    approval_token: null,
    approval_reference: null,
    execution_status: 'not_started',
    execution_revision: null,
    native_row_revision: null,
    receipt: null,
  };
  const attemptWithBatch = (call: Record<string, unknown>) => ({
    ...attempt,
    phase: 'batch_frozen' as const,
    round_id: ROUND_ID,
    round_revision: 1,
    round_status: 'completed' as const,
    batch_kind: 'read_only_batch' as const,
    batch_revision: 1,
    batch: [call],
  });

  native.query_agent_attempt.mockResolvedValueOnce({
    schema_version: 2,
    status: 'active',
    attempt: attemptWithBatch({
      ...baseCall,
      access: 'conversation_confirm',
      approval_state: 'pending',
    }),
  });
  await expect(
    AgentRuntime.queryAgentAttempt(queryAttemptRequest),
  ).rejects.toMatchObject({ code: 'E_AGENT_LEDGER' });

  native.query_agent_attempt.mockResolvedValueOnce({
    schema_version: 2,
    status: 'active',
    attempt: attemptWithBatch({
      ...baseCall,
      access: 'durable_deny',
      safe_summary_key: 'agent.unknown',
      approval_state: 'denied',
      execution_status: 'not_started',
      idempotency_key: null,
    }),
  });
  await expect(
    AgentRuntime.queryAgentAttempt(queryAttemptRequest),
  ).rejects.toMatchObject({ code: 'E_AGENT_LEDGER' });
});

test('binds terminal receipts to their enclosing call identity', async () => {
  native.execute_agent_tool.mockResolvedValueOnce({
    schema_version: 2,
    status: 'completed',
    operation_id: CLEANUP_ID,
    task_id: TASK_ID,
    attempt_id: ATTEMPT_ID,
    round_id: ROUND_ID,
    round_index: 0,
    call_index: 0,
    call_id: CALL_ID,
    name: 'write_file',
    idempotency_key: SHA256,
    result_execution_revision: 2,
    transcript,
    receipt: {
      ...toolReceipt,
      call_id: 'different-call',
    },
    effect_may_have_occurred: true,
  });
  await expect(
    AgentRuntime.executeAgentTool(executeRequest),
  ).rejects.toMatchObject({ code: 'E_AGENT_LEDGER' });
});

test('binds recovered completed rounds to a round target and exact next action', async () => {
  const recoveredFinal = {
    schema_version: 2,
    kind: 'final',
    task_id: TASK_ID,
    attempt_id: ATTEMPT_ID,
    round_id: ROUND_ID,
    round_index: 0,
    launch_attempt: 1,
    result_round_revision: 1,
    transcript,
    completion_receipt: roundReceipt,
    text: '',
    reasoning: '',
    assistant_text_sha256: SHA256,
    reasoning_text_sha256: SHA256,
  };

  native.recover_agent_attempt.mockResolvedValueOnce({
    schema_version: 2,
    status: 'resumed',
    operation_id: CLEANUP_ID,
    next_action: 'persist_final',
    attempt,
    completed_round: recoveredFinal,
  });
  await expect(
    AgentRuntime.recoverAgentAttempt(recoveryRequest),
  ).rejects.toMatchObject({ code: 'E_AGENT_LEDGER' });

  native.recover_agent_attempt.mockResolvedValueOnce({
    schema_version: 2,
    status: 'resumed',
    operation_id: CLEANUP_ID,
    next_action: 'persist_approval',
    attempt,
    completed_round: recoveredFinal,
  });
  await expect(
    AgentRuntime.recoverAgentAttempt({
      ...recoveryRequest,
      target: {
        schema_version: 2,
        kind: 'round',
        task_id: TASK_ID,
        attempt_id: ATTEMPT_ID,
        round_id: ROUND_ID,
        round_index: 0,
      },
      expected_round_revision: 1,
    } as never),
  ).rejects.toMatchObject({ code: 'E_AGENT_LEDGER' });
});

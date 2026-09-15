import {
  createAgentAttemptJournal,
  normalizeAgentRoundAction,
  reduceAgentRound,
  reduceAgentRoundEvent,
  type AgentRoundState,
} from '../src/agent/AgentRoundReducer';
import {
  validateAgentControllerPreflight,
  type AgentControllerPreflightV1,
} from '../src/agent/AgentControllerPreflight';
import {
  isAgentPhaseLineageValid,
  MAX_AGENT_SINGLE_WRITE_BYTES,
  type AgentRuntimePolicyV1,
  type AgentRuntimeRootV1,
  type AgentRuntimeTranscriptHandleV1,
} from '../src/state';
import { projectToolActivity } from '../src/components/toolActivityProjection';
import { validateAgentStoreTransition } from '../src/agent/AgentStoreTransitions';
import { parsePersistedAgentAttemptJournalV3 } from '../src/state/persistence';

const T0 = '2026-08-30T00:00:00.000Z';
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const ROUND_ID = '44444444-4444-4444-8444-444444444444';
const OPERATION_ID = '55555555-5555-4555-8555-555555555555';
const SHA = 'a'.repeat(64);

const root: AgentRuntimeRootV1 = {
  schema_version: 1,
  kind: 'workspace',
  workspace_id: CONVERSATION_ID,
  workspace_binding_revision: 1,
  project_id: null,
  root_fingerprint_sha256: SHA,
  capabilities: ['file_read'],
};
const policy: AgentRuntimePolicyV1 = {
  schema_version: 1,
  policy_version: 'agent-v1',
  max_single_write_bytes: MAX_AGENT_SINGLE_WRITE_BYTES,
  max_batch_write_bytes: 512 * 1024,
  max_attempt_write_bytes: 4 * 1024 * 1024,
};
const transcript: AgentRuntimeTranscriptHandleV1 = {
  schema_version: 1,
  transcript_ref: '66666666-6666-4666-8666-666666666666',
  generation: 0,
  transcript_sha256: SHA,
  transcript_bytes: 0,
};

function initialState(): AgentRoundState {
  return createAgentAttemptJournal({
    policy,
    root,
    toolset_sha256: SHA,
    transcript,
    round_id: ROUND_ID,
    updated_at: T0,
  });
}

function cas(generation: number, revision: number, sessionGeneration: number) {
  return {
    schema_version: 1 as const,
    conversation_id: CONVERSATION_ID,
    task_id: TASK_ID,
    attempt_id: ATTEMPT_ID,
    expected_controller_generation: generation,
    expected_journal_revision: revision,
    expected_session_generation: sessionGeneration,
    expected_session_sha256: SHA,
  };
}

function beginRoundPreflight(state: AgentRoundState): AgentControllerPreflightV1 {
  const input = {
    schema_version: 1 as const,
    source: 'completion_controller' as const,
    kind: 'begin_round' as const,
    operation_id: OPERATION_ID,
    base_cas: cas(state.controller_generation, state.controller_generation, 1),
    task_id: TASK_ID,
    conversation_id: CONVERSATION_ID,
    attempt_id: ATTEMPT_ID,
    round_id: ROUND_ID,
    round_index: state.round_index,
    launch_attempt: state.round_lineage?.launch_attempt ?? 1,
    expected_round_revision: state.round_lineage?.native_row_revision ?? 0,
    transport_schema_version: 2 as const,
    model: 'deepseek-v4-flash' as const,
    thinking_mode: 'high' as const,
    visible_history_sha256: SHA,
    visible_message_count: 0,
    project_context_sha256: null,
    root: state.root,
    registry_version: 1 as const,
    toolset_sha256: state.toolset_sha256,
    transcript: state.transcript,
  };
  const evidence = validateAgentControllerPreflight(input);
  if (evidence === null) throw new Error('invalid test preflight');
  return evidence;
}

describe('AgentRoundReducer high-level evidence boundary', () => {
  test.each(['run_program', 'start_runtime_service'])('maps a frozen conversation grant for %s without inventing an approval token', name => {
    const grantId = '99999999-9999-4999-8999-999999999999';
    const state: AgentRoundState = { ...initialState(), tool_registry_version: 3, phase: 'round_in_flight',
      root: { ...root, capabilities: ['file_read', 'guest_service'] }, frozen_grant_ids: [grantId],
      round_lineage: { ...initialState().round_lineage!, status: 'active', native_row_revision: 1 } };
    const controllerCas = cas(0, 0, 1), checkpoint = { schema_version: 1, journal_revision: 0, session_generation: 1, session_sha256: SHA };
    const request = { schema_version: 2, operation_id: OPERATION_ID, controller_cas: controllerCas, committed_checkpoint: checkpoint,
      task_id: TASK_ID, conversation_id: CONVERSATION_ID, attempt_id: ATTEMPT_ID, round_id: ROUND_ID, round_index: 0,
      expected_round_revision: 1, transcript, root: state.root, registry_version: 3, toolset_sha256: SHA,
      policy_version: 'agent-v1', expected_batch_revision: 0, expected_reserved_write_bytes: 0 };
    const projection = { schema_version: 2, call_index: 0, call_id: 'granted-run', name, arguments_sha256: SHA,
      idempotency_key: SHA, safe_summary_key: `agent.${name}`, access: 'conversation_confirm', approval_state: 'bound',
      approval_token: null, approval_reference: grantId, execution_status: 'intent', execution_revision: 1,
      native_row_revision: 1, receipt: null, approval_preview: { schema_version: 1, kind: name, paths: ['server.js'],
        content_bytes: null, prior: null, diff_preview: null, diff_truncated: false } };
    const evidence = validateAgentStoreTransition({ operation: 'prepare_agent_tool_batch', request, result: {
      schema_version: 2, status: 'prepared', operation_id: OPERATION_ID, observed_checkpoint: checkpoint,
      receipt: { schema_version: 2, task_id: TASK_ID, attempt_id: ATTEMPT_ID, round_id: ROUND_ID, round_index: 0,
        batch_kind: 'write_batch', batch_revision: 1, manifest_sha256: SHA, transcript, calls: [projection],
        batch_new_write_bytes: 0, reserved_write_bytes: 0, effect_gate: 'closed' },
    } });
    if (evidence === null || evidence.kind !== 'prepare_agent_tool_batch') throw new Error('invalid grant batch');
    const frozen = reduceAgentRound(state, { type: 'freeze_batch', evidence }, T0);
    expect(frozen.accepted).toBe(true);
    expect(frozen.state.batch[0]).toMatchObject({ approval_decision: 'allow_conversation', approval_token: null, approval_reference: grantId });
    expect(parsePersistedAgentAttemptJournalV3(frozen.state)).toEqual(frozen.state);
    expect(reduceAgentRound({ ...state, frozen_grant_ids: [] }, { type: 'freeze_batch', evidence }, T0).accepted).toBe(false);
    const execution = validateAgentControllerPreflight({ schema_version: 1, source: 'completion_controller', kind: 'begin_execution',
      operation_id: OPERATION_ID, base_cas: { ...controllerCas, expected_controller_generation: frozen.state.controller_generation }, task_id: TASK_ID, conversation_id: CONVERSATION_ID, attempt_id: ATTEMPT_ID,
      round_id: ROUND_ID, round_index: 0, batch_kind: 'write_batch', batch_revision: 1, manifest_sha256: SHA,
      call_index: 0, call_id: projection.call_id, name, arguments_sha256: SHA, idempotency_key: SHA,
      expected_execution_revision: 1, transcript, root: state.root, access: 'conversation_confirm', approval_state: 'bound',
      approval_reference: grantId, source_event_id: OPERATION_ID });
    if (execution === null || execution.kind !== 'begin_execution') throw new Error('invalid grant execution');
    const executing = reduceAgentRound(frozen.state, { type: 'execution_intent', evidence: execution }, T0);
    expect(executing.accepted).toBe(true);
    expect(executing.state.phase).toBe('execution_intent');
    expect(parsePersistedAgentAttemptJournalV3(executing.state).batch[0]?.approval_decision).toBe('allow_conversation');
  });
  test('keeps a declined runtime installation denied and continues to the next round', () => {
    const call: AgentRoundState['batch'][number] = {
      schema_version: 3, call_index: 0, call_id: 'install', name: 'install_runtime_environment',
      arguments_sha256: SHA, safe_summary_key: 'agent.install_runtime_environment', access: 'conversation_confirm',
      approval_token: 'install-approval', approval_decision: 'pending', approval_reference: null,
      idempotency_key: null, native_row_revision: 1, receipt: null,
    };
    const state: AgentRoundState = { ...initialState(), tool_registry_version: 3, phase: 'approval_pending',
      root: { ...root, capabilities: ['file_read', 'guest_service'] }, batch: [call], call_index: 0,
      round_lineage: { ...initialState().round_lineage!, status: 'completed', native_row_revision: 1 } };
    const evidence = validateAgentControllerPreflight({
      schema_version: 1, source: 'completion_controller', kind: 'decide_approval', operation_id: OPERATION_ID,
      base_cas: cas(0, 0, 1), conversation_id: CONVERSATION_ID, task_id: TASK_ID, attempt_id: ATTEMPT_ID,
      round_id: ROUND_ID, round_index: 0, batch_revision: 1, manifest_sha256: SHA,
      call_index: 0, call_id: call.call_id, name: call.name, arguments_sha256: SHA, approval_token: call.approval_token,
      decision: 'denied', source_event_id: OPERATION_ID, access: 'conversation_confirm',
      workspace_id: root.workspace_id, project_id: null, binding_revision: 1, root_fingerprint_sha256: SHA,
      policy_version: 'agent-v1', registry_version: 3, tool_family: 'guest_service', grant: null,
    });
    if (evidence === null || evidence.kind !== 'decide_approval') throw new Error('invalid denial preflight');
    const denied = reduceAgentRound(state, { type: 'decide_approval', evidence }, T0);
    expect(denied.accepted).toBe(true);
    expect(denied.state.batch[0]).toMatchObject({ approval_decision: 'denied', approval_token: null, approval_reference: null });
    // The native bind result adds this protected denied receipt before the next round.
    const settled: AgentRoundState = { ...denied.state, batch: [{ ...denied.state.batch[0]!, receipt: {
      schema_version: 1, call_id: call.call_id, name: call.name, arguments_sha256: SHA, result_sha256: SHA,
      result_bytes: 50, truncated: false, duration_ms: 0, outcome: 'denied',
      failure_code: 'E_AGENT_DENIED_BY_USER', approval_reference: null,
    } }] };
    const next = reduceAgentRound(settled, { type: 'next_round', round_id: OPERATION_ID, round_index: 1 }, T0);
    expect(next.accepted).toBe(true);
    expect(next.state).toMatchObject({ phase: 'ready_for_round', batch: [], round_index: 1, tool_registry_version: 3 });
    const event = { schema_version: 2 as const, event_id: 'call', attempt_id: ATTEMPT_ID, seq: 1,
      kind: 'tool_call' as const, round_index: 0, call_id: call.call_id, status: 'approval' as const,
      safe_summary_key: call.safe_summary_key, arguments_sha256: SHA, result_sha256: null, approval_reference: null,
      failure_code: null, created_at: T0 };
    expect(projectToolActivity([event, { ...event, event_id: 'result', seq: 2, kind: 'tool_result', status: 'denied',
      result_sha256: SHA, failure_code: 'E_AGENT_DENIED_BY_USER' }], ATTEMPT_ID)[0]).toMatchObject({
      name: call.name, status: 'error', denied: true, failureCode: 'E_AGENT_DENIED_BY_USER',
    });
  });
  test.each([
    ['ready_for_round', 'ready', true],
    ['round_in_flight', 'active', true],
    ['batch_frozen', 'completed', true],
    ['approval_pending', 'completed', true],
    ['execution_intent', 'cancel_requested', true],
    ['tool_result_pending', 'completed', true],
    ['final_response', 'completed', true],
    ['cancelled', 'cancelled', true],
    ['failed', 'failed_retryable', true],
    ['unknown', 'unknown', true],
    ['ambiguous', 'ambiguous', true],
  ] as const)('uses shared phase lineage matrix %s/%s', (phase, lineage, expected) => {
    expect(isAgentPhaseLineageValid(phase, lineage)).toBe(expected);
  });

  test('accepts a mapped complete-round result and advances only the V3 journal', () => {
    const state = initialState();
    const evidence = beginRoundPreflight(state);
    const action = { type: 'start_round', evidence } as const;
    expect(normalizeAgentRoundAction(action)).not.toBeNull();
    const reduced = reduceAgentRound(state, action, T0);
    expect(reduced.accepted).toBe(true);
    expect(reduced.state.phase).toBe('round_in_flight');
    expect(reduced.state.round_lineage?.round_id).toBe(ROUND_ID);
    expect(reduced.state.round_lineage?.native_row_revision).toBeNull();
    expect(reduced.state.batch).toEqual([]);
  });

  test('binds execution preflight to the selected call and native revision', () => {
    const executionRoot: AgentRuntimeRootV1 = {
      ...root,
      capabilities: ['file_read', 'file_write'],
    };
    const call: AgentRoundState['batch'][number] = {
      schema_version: 3,
      call_index: 0,
      call_id: 'call-1',
      name: 'write_file',
      arguments_sha256: SHA,
      safe_summary_key: 'agent.write_file',
      access: 'conversation_confirm',
      approval_token: 'approval-token',
      approval_decision: 'allow_once',
      approval_reference: '88888888-8888-4888-8888-888888888888',
      idempotency_key: null,
      native_row_revision: 1,
      receipt: null,
    };
    const state: AgentRoundState = {
      ...initialState(),
      controller_generation: 3,
      root: executionRoot,
      phase: 'batch_frozen',
      round_lineage: {
        ...initialState().round_lineage!,
        status: 'completed',
        native_row_revision: 1,
      },
      batch: [call],
      call_index: 0,
    };
    const input = {
      schema_version: 1 as const,
      source: 'completion_controller' as const,
      kind: 'begin_execution' as const,
      operation_id: '77777777-7777-4777-8777-777777777777',
      base_cas: cas(3, 0, 1),
      task_id: TASK_ID,
      conversation_id: CONVERSATION_ID,
      attempt_id: ATTEMPT_ID,
      round_id: ROUND_ID,
      round_index: 0,
      batch_kind: 'write_batch' as const,
      batch_revision: 1,
      manifest_sha256: SHA,
      call_index: 0,
      call_id: call.call_id,
      name: call.name,
      arguments_sha256: call.arguments_sha256,
      idempotency_key: 'b'.repeat(64),
      expected_execution_revision: 1,
      transcript: state.transcript,
      root: executionRoot,
      access: call.access,
      approval_state: 'bound' as const,
      approval_reference: call.approval_reference,
      source_event_id: '77777777-7777-4777-8777-777777777777',
    };
    const evidence = validateAgentControllerPreflight(input);
    if (evidence === null || evidence.kind !== 'begin_execution') {
      throw new Error('invalid execution preflight fixture');
    }
    const accepted = reduceAgentRound(
      state,
      { type: 'execution_intent', evidence },
      T0,
    );
    expect(accepted.accepted).toBe(true);
    expect(accepted.state.phase).toBe('execution_intent');
    expect(accepted.state.batch[0]?.idempotency_key).toBe('b'.repeat(64));
    expect(accepted.state.batch[0]?.native_row_revision).toBe(1);
    const staleRevision = validateAgentControllerPreflight({
      ...input,
      expected_execution_revision: 2,
    });
    if (staleRevision === null || staleRevision.kind !== 'begin_execution') {
      throw new Error('invalid stale execution preflight fixture');
    }
    expect(
      reduceAgentRound(state, { type: 'execution_intent', evidence: staleRevision }, T0),
    ).toEqual({ state, accepted: false });
  });

  test('rejects conflict, raw pair, and malformed evidence without transition', () => {
    const state = initialState();
    const valid = beginRoundPreflight(state);
    const malformed = {
      ...valid,
      kind: 'conflict',
    };
    const rawPair = {
      operation: 'complete_agent_round_v2',
      request: valid,
      result: valid,
    };
    expect(normalizeAgentRoundAction({ type: 'start_round', evidence: malformed })).toBeNull();
    expect(normalizeAgentRoundAction({
      type: 'start_round',
      evidence: rawPair,
    })).toBeNull();
    expect(reduceAgentRoundEvent(state, { type: 'start_round', evidence: malformed }, T0)).toEqual({ state, accepted: false });
  });

  test('does not retain the removed low-level action fields', () => {
    const state = initialState();
    for (const action of [
      { type: 'start_round', round_id: ROUND_ID, round_index: 0, native_row_revision: 1 },
      { type: 'freeze_batch', calls: [], old_proof: null },
      { type: 'cancel', old_proof: null },
    ]) {
      expect(normalizeAgentRoundAction(action)).toBeNull();
    }
    expect(reduceAgentRound(state, { type: 'next_call' }, T0).accepted).toBe(false);
  });
});

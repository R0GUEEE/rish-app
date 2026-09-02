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

import {
  validateAgentControllerPreflight,
  type AgentControllerPreflightV1,
} from '../src/agent/AgentControllerPreflight';
import { RUNTIME_AGENT_TOOLS } from '../src/agent/tool-registry';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const OPERATION_ID = '44aa4444-4444-4444-8444-444444444444';
const ROUND_ID = '55555555-5555-4555-8555-555555555555';
const WORKSPACE_ID = '66666666-6666-4666-8666-666666666666';
const PROJECT_ID = '77777777-7777-4777-8777-777777777777';
const TRANSCRIPT_ID = '88888888-8888-4888-8888-888888888888';
const GRANT_ID = '99999999-9999-4999-8999-999999999999';
const APPROVAL_REFERENCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);

const baseCas = {
  schema_version: 1 as const,
  conversation_id: CONVERSATION_ID,
  task_id: TASK_ID,
  attempt_id: ATTEMPT_ID,
  expected_controller_generation: 2,
  expected_journal_revision: 3,
  expected_session_generation: 4,
  expected_session_sha256: SHA_A,
};

const transcript = {
  schema_version: 1 as const,
  transcript_ref: TRANSCRIPT_ID,
  generation: 2,
  transcript_sha256: SHA_B,
  transcript_bytes: 42,
};

const root = {
  schema_version: 1 as const,
  kind: 'project' as const,
  workspace_id: WORKSPACE_ID,
  workspace_binding_revision: 5,
  project_id: PROJECT_ID,
  root_fingerprint_sha256: SHA_C,
  capabilities: [
    'file_read',
    'file_write',
    'git_status',
    'git_commit',
    'git_push',
  ] as const,
};

const common = {
  schema_version: 1 as const,
  source: 'completion_controller' as const,
  operation_id: OPERATION_ID,
  base_cas: baseCas,
  conversation_id: CONVERSATION_ID,
  task_id: TASK_ID,
  attempt_id: ATTEMPT_ID,
};

const beginRound = {
  ...common,
  kind: 'begin_round' as const,
  round_id: ROUND_ID,
  round_index: 1,
  launch_attempt: 1,
  expected_round_revision: 0,
  transport_schema_version: 3 as const,
  model: 'deepseek-v4-flash' as const,
  thinking_mode: 'high' as const,
  visible_history_sha256: SHA_D,
  visible_message_count: 12,
  project_context_sha256: SHA_A,
  transcript,
  root,
  registry_version: 1 as const,
  toolset_sha256: SHA_B,
};

const grant = {
  schema_version: 2 as const,
  grant_id: GRANT_ID,
  conversation_id: CONVERSATION_ID,
  workspace_id: WORKSPACE_ID,
  project_id: PROJECT_ID,
  binding_revision: 5,
  root_fingerprint_sha256: SHA_C,
  tool_family: 'file_write' as const,
  registry_version: 1 as const,
  policy_version: 'agent-v1',
  issued_for: {
    schema_version: 1 as const,
    task_id: TASK_ID,
    attempt_id: ATTEMPT_ID,
  },
  created_at: '2026-08-31T12:00:00.000Z',
};

const decideApproval = {
  ...common,
  kind: 'decide_approval' as const,
  round_id: ROUND_ID,
  round_index: 1,
  batch_revision: 2,
  manifest_sha256: SHA_C,
  call_index: 0,
  call_id: 'call-1',
  name: 'write_file',
  arguments_sha256: SHA_D,
  approval_token: 'approval-token-1',
  decision: 'allow_conversation' as const,
  source_event_id: OPERATION_ID,
  access: 'conversation_confirm' as const,
  workspace_id: WORKSPACE_ID,
  project_id: PROJECT_ID,
  binding_revision: 5,
  root_fingerprint_sha256: SHA_C,
  policy_version: 'agent-v1' as const,
  registry_version: 1 as const,
  tool_family: 'file_write' as const,
  grant,
};

const beginExecution = {
  ...common,
  kind: 'begin_execution' as const,
  round_id: ROUND_ID,
  round_index: 1,
  batch_kind: 'write_batch' as const,
  batch_revision: 2,
  manifest_sha256: SHA_C,
  call_index: 0,
  call_id: 'call-1',
  name: 'write_file',
  arguments_sha256: SHA_D,
  idempotency_key: SHA_A,
  expected_execution_revision: 1,
  transcript,
  root,
  access: 'conversation_confirm' as const,
  approval_state: 'bound' as const,
  approval_reference: APPROVAL_REFERENCE,
  source_event_id: OPERATION_ID,
};

const requestCancel = {
  ...common,
  kind: 'request_cancel' as const,
  target: {
    schema_version: 2 as const,
    kind: 'tool' as const,
    task_id: TASK_ID,
    attempt_id: ATTEMPT_ID,
    round_id: ROUND_ID,
    round_index: 1,
    call_index: 0,
    call_id: 'call-1',
    idempotency_key: SHA_A,
  },
  cancel_token: {
    schema_version: 2 as const,
    issuer: 'completion_controller' as const,
    source_event_id: OPERATION_ID,
    token: OPERATION_ID,
    task_id: TASK_ID,
    attempt_id: ATTEMPT_ID,
    expected_phase: 'execution_intent' as const,
    reason_code: 'E_AGENT_CANCELLED' as const,
  },
  expected_round_revision: null,
  expected_execution_revision: 2,
  expected_transcript: transcript,
  root,
};

const cases = [
  ['begin_round', beginRound],
  ['decide_approval', decideApproval],
  ['begin_execution', beginExecution],
  ['request_cancel', requestCancel],
] as const;

describe('AgentControllerPreflight', () => {
  test.each(RUNTIME_AGENT_TOOLS.filter(name => name !== 'list_runtime_environments'))('binds %s to v3 guest-service approval and execution', name => {
    const approval = { ...decideApproval, name, registry_version: 3,
      tool_family: 'guest_service', grant: { ...grant, registry_version: 3, tool_family: 'guest_service' } };
    expect(validateAgentControllerPreflight(approval)?.kind).toBe('decide_approval');
    for (const registryVersion of [1, 2]) {
      expect(validateAgentControllerPreflight({ ...approval, registry_version: registryVersion,
        grant: { ...approval.grant, registry_version: registryVersion } })).toBeNull();
    }
    expect(validateAgentControllerPreflight({ ...approval, grant: { ...approval.grant, registry_version: 2 } })).toBeNull();
    const execution = { ...beginExecution, name, root: { ...root, capabilities: ['guest_service'] } };
    expect(validateAgentControllerPreflight(execution)?.kind).toBe('begin_execution');
    expect(validateAgentControllerPreflight({ ...execution, root: { ...root, capabilities: ['file_read'] } })).toBeNull();
    expect(validateAgentControllerPreflight({ ...execution, batch_kind: 'read_only_batch', manifest_sha256: null })).toBeNull();
  });

  test('lists environments through automatic file-read access only', () => {
    const execution = { ...beginExecution, name: 'list_runtime_environments', batch_kind: 'read_only_batch',
      manifest_sha256: null, access: 'auto', approval_state: 'not_required', approval_reference: null,
      root: { ...root, capabilities: ['file_read'] } };
    expect(validateAgentControllerPreflight(execution)?.kind).toBe('begin_execution');
    expect(validateAgentControllerPreflight({ ...execution, root: { ...root, capabilities: ['guest_service'] } })).toBeNull();
  });
  test.each(cases)('accepts the exact %s safe seed', (kind, input) => {
    const mapped = validateAgentControllerPreflight(input);
    expect(mapped).not.toBeNull();
    expect(mapped?.kind).toBe(kind);
    expect(mapped?.operation_id).toBe(OPERATION_ID);
    expect(mapped?.base_cas).toEqual(baseCas);
  });

  test.each(cases)('rejects forbidden evidence on %s', (_kind, input) => {
    expect(validateAgentControllerPreflight({
      ...input,
      receipt: null,
    })).toBeNull();
  });

  test.each(cases)('rejects CAS identity mismatch on %s', (_kind, input) => {
    expect(validateAgentControllerPreflight({
      ...input,
      base_cas: { ...baseCas, attempt_id: ROUND_ID },
    })).toBeNull();
  });

  test('defensively clones and freezes branch-specific authority objects', () => {
    const mappedRound = validateAgentControllerPreflight(beginRound) as Extract<
      AgentControllerPreflightV1,
      { kind: 'begin_round' }
    >;
    const mappedApproval = validateAgentControllerPreflight(decideApproval) as Extract<
      AgentControllerPreflightV1,
      { kind: 'decide_approval' }
    >;
    const mappedExecution = validateAgentControllerPreflight(beginExecution) as Extract<
      AgentControllerPreflightV1,
      { kind: 'begin_execution' }
    >;
    const mappedCancel = validateAgentControllerPreflight(requestCancel) as Extract<
      AgentControllerPreflightV1,
      { kind: 'request_cancel' }
    >;
    expect(mappedRound.root).not.toBe(beginRound.root);
    expect(mappedRound.transcript).not.toBe(beginRound.transcript);
    expect(mappedApproval.grant).not.toBe(decideApproval.grant);
    expect(mappedApproval.grant?.issued_for).not.toBe(decideApproval.grant.issued_for);
    expect(mappedExecution.root).not.toBe(beginExecution.root);
    expect(mappedExecution.transcript).not.toBe(beginExecution.transcript);
    expect(mappedCancel.target).not.toBe(requestCancel.target);
    expect(mappedCancel.cancel_token).not.toBe(requestCancel.cancel_token);
    expect(Object.isFrozen(mappedRound.root)).toBe(true);
    expect(Object.isFrozen(mappedApproval.grant?.issued_for)).toBe(true);
    expect(Object.isFrozen(mappedExecution.transcript)).toBe(true);
    expect(Object.isFrozen(mappedCancel.target)).toBe(true);
  });

  test('returns a defensive, deeply immutable copy', () => {
    const capabilities = [...root.capabilities];
    const input = {
      ...beginRound,
      base_cas: { ...baseCas },
      root: { ...root, capabilities },
      transcript: { ...transcript },
    };
    const mapped = validateAgentControllerPreflight(input);
    expect(mapped?.kind).toBe('begin_round');
    capabilities.pop();
    input.base_cas.expected_controller_generation = 99;
    expect((mapped as Extract<AgentControllerPreflightV1, { kind: 'begin_round' }>).root.capabilities).toHaveLength(5);
    expect(mapped?.base_cas.expected_controller_generation).toBe(2);
    expect(Object.isFrozen(mapped)).toBe(true);
    expect(Object.isFrozen(mapped?.base_cas)).toBe(true);
    expect(Object.isFrozen((mapped as Extract<AgentControllerPreflightV1, { kind: 'begin_round' }>).root.capabilities)).toBe(true);
  });

  test.each([
    ['result', { status: 'completed' }],
    ['receipt', { outcome: 'ok' }],
    ['observed_checkpoint', { session_generation: 4 }],
    ['owner', { generation: 1 }],
    ['launch_id', 'native-launch'],
    ['native_task_id', 'native-task'],
    ['raw_result', 'secret'],
  ])('rejects forbidden top-level %s material', (key, value) => {
    expect(
      validateAgentControllerPreflight({ ...beginRound, [key]: value }),
    ).toBeNull();
  });

  test.each([
    ['non-canonical operation id', { ...beginRound, operation_id: OPERATION_ID.toUpperCase() }],
    ['CAS identity mismatch', { ...beginRound, base_cas: { ...baseCas, task_id: ROUND_ID } }],
    ['CAS unknown key', { ...beginRound, base_cas: { ...baseCas, owner_generation: 1 } }],
    ['V2 context digest', { ...beginRound, transport_schema_version: 2, project_context_sha256: SHA_A }],
    ['V3 workspace root', {
      ...beginRound,
      root: {
        ...root,
        kind: 'workspace',
        project_id: null,
        capabilities: ['file_read'],
      },
    }],
    ['unsafe revision', { ...beginRound, expected_round_revision: Number.MAX_SAFE_INTEGER }],
  ])('rejects %s', (_name, input) => {
    expect(validateAgentControllerPreflight(input)).toBeNull();
  });

  test.each([
    [8, true],
    [9, false],
  ] as const)('enforces launch_attempt %i at the 1..8 boundary', (launchAttempt, accepted) => {
    expect(validateAgentControllerPreflight({
      ...beginRound,
      launch_attempt: launchAttempt,
    }) !== null).toBe(accepted);
  });

  test.each([
    ['write_file once', {
      ...decideApproval,
      decision: 'allow_once',
      grant: null,
    }],
    ['git_commit conversation', {
      ...decideApproval,
      name: 'git_commit',
      tool_family: 'git_commit',
      grant: { ...grant, tool_family: 'git_commit' },
    }],
    ['git_push conversation', {
      ...decideApproval,
      name: 'git_push',
      access: 'conversation_confirm',
      tool_family: 'git_push',
      grant: { ...grant, tool_family: 'git_push' },
    }],
  ])('accepts approval authority for %s', (_name, input) => {
    expect(validateAgentControllerPreflight(input)?.kind).toBe('decide_approval');
  });

  test.each([
    ['event/operation mismatch', { ...decideApproval, source_event_id: ROUND_ID }],
    ['grant on once decision', { ...decideApproval, decision: 'allow_once' }],
    ['missing conversation grant', { ...decideApproval, grant: null }],
    ['issued-for mismatch', {
      ...decideApproval,
      grant: { ...grant, issued_for: { ...grant.issued_for, task_id: ROUND_ID } },
    }],
    ['tool-family mismatch', { ...decideApproval, tool_family: 'git_commit' }],
    ['access mismatch', { ...decideApproval, access: 'confirm_once' }],
    ['unknown tool', { ...decideApproval, name: 'delete_everything' }],
    ['git_push without project', {
      ...decideApproval,
      name: 'git_push',
      access: 'conversation_confirm',
      tool_family: 'git_push',
      project_id: null,
      grant: { ...grant, tool_family: 'git_push', project_id: null },
    }],
  ])('rejects approval %s', (_name, input) => {
    expect(validateAgentControllerPreflight(input)).toBeNull();
  });

  test.each([
    ['workspace', { workspace_id: ROUND_ID }],
    ['project', { project_id: ROUND_ID }],
    ['binding revision', { binding_revision: 6 }],
    ['root fingerprint', { root_fingerprint_sha256: SHA_D }],
    ['policy', { policy_version: 'agent-v2' }],
  ])('rejects approval grant/seed %s mismatch', (_name, mismatch) => {
    expect(validateAgentControllerPreflight({
      ...decideApproval,
      ...mismatch,
    })).toBeNull();
  });

  test.each([
    ['list_dir', 'read_only_batch', null, 'auto', 'not_required', null],
    ['list_dir', 'write_batch', SHA_C, 'auto', 'not_required', null],
    ['read_file', 'read_only_batch', null, 'auto', 'not_required', null],
    ['git_status', 'read_only_batch', null, 'auto', 'not_required', null],
    ['write_file', 'write_batch', SHA_C, 'conversation_confirm', 'bound', APPROVAL_REFERENCE],
    ['git_commit', 'write_batch', SHA_C, 'conversation_confirm', 'bound', APPROVAL_REFERENCE],
    ['git_push', 'write_batch', SHA_C, 'conversation_confirm', 'bound', APPROVAL_REFERENCE],
  ] as const)(
    'accepts execution authority for %s in %s',
    (name, batchKind, manifest, access, approvalState, approvalReference) => {
      expect(validateAgentControllerPreflight({
        ...beginExecution,
        name,
        batch_kind: batchKind,
        manifest_sha256: manifest,
        access,
        approval_state: approvalState,
        approval_reference: approvalReference,
      })?.kind).toBe('begin_execution');
    },
  );

  test('accepts CGI execution only with the guest_service capability and approval', () => {
    const serviceRoot = {
      ...root,
      capabilities: [...root.capabilities, 'guest_service'] as const,
    };
    expect(validateAgentControllerPreflight({
      ...beginExecution,
      name: 'start_guest_cgi',
      root: serviceRoot,
    })?.kind).toBe('begin_execution');
    expect(validateAgentControllerPreflight({
      ...beginExecution,
      name: 'start_guest_cgi',
      root,
    })).toBeNull();
  });

  test.each([
    ['event/operation mismatch', { ...beginExecution, source_event_id: ROUND_ID }],
    ['write batch without manifest', { ...beginExecution, manifest_sha256: null }],
    ['read batch with manifest', { ...beginExecution, batch_kind: 'read_only_batch' }],
    ['non-UUID approval reference', { ...beginExecution, approval_reference: 'approval-ref' }],
    ['unknown tool', { ...beginExecution, name: 'delete_everything' }],
    ['write auto access', { ...beginExecution, access: 'auto' }],
    ['write not-required state', { ...beginExecution, approval_state: 'not_required' }],
    ['write missing approval reference', { ...beginExecution, approval_reference: null }],
    ['write tool in read-only batch', {
      ...beginExecution,
      batch_kind: 'read_only_batch',
      manifest_sha256: null,
    }],
    ['read bound state', {
      ...beginExecution,
      name: 'read_file',
      batch_kind: 'read_only_batch',
      manifest_sha256: null,
      access: 'auto',
      approval_state: 'bound',
      approval_reference: null,
    }],
    ['read approval reference', {
      ...beginExecution,
      name: 'read_file',
      batch_kind: 'read_only_batch',
      manifest_sha256: null,
      access: 'auto',
      approval_state: 'not_required',
    }],
    ['git_push once-only access', {
      ...beginExecution,
      name: 'git_push',
      access: 'confirm_once',
    }],
  ])('rejects execution %s', (_name, input) => {
    expect(validateAgentControllerPreflight(input)).toBeNull();
  });

  test.each([
    ['list_dir', 'file_read', 'read_only_batch', null, 'auto', 'not_required', null],
    ['read_file', 'file_read', 'read_only_batch', null, 'auto', 'not_required', null],
    ['git_status', 'git_status', 'read_only_batch', null, 'auto', 'not_required', null],
    ['write_file', 'file_write', 'write_batch', SHA_C, 'conversation_confirm', 'bound', APPROVAL_REFERENCE],
    ['git_commit', 'git_commit', 'write_batch', SHA_C, 'conversation_confirm', 'bound', APPROVAL_REFERENCE],
    ['git_push', 'git_push', 'write_batch', SHA_C, 'conversation_confirm', 'bound', APPROVAL_REFERENCE],
  ] as const)(
    'rejects %s when root lacks %s capability',
    (name, capability, batchKind, manifest, access, approvalState, approvalReference) => {
      expect(validateAgentControllerPreflight({
        ...beginExecution,
        name,
        batch_kind: batchKind,
        manifest_sha256: manifest,
        access,
        approval_state: approvalState,
        approval_reference: approvalReference,
        root: {
          ...root,
          capabilities: root.capabilities.filter(entry => entry !== capability),
        },
      })).toBeNull();
    },
  );

  test.each([
    ['token/operation mismatch', {
      ...requestCancel,
      cancel_token: { ...requestCancel.cancel_token, token: ROUND_ID },
    }],
    ['target identity mismatch', {
      ...requestCancel,
      target: { ...requestCancel.target, task_id: ROUND_ID },
    }],
    ['tool carrying round revision', { ...requestCancel, expected_round_revision: 3 }],
    ['tool missing execution revision', { ...requestCancel, expected_execution_revision: null }],
    ['attempt with revisions', {
      ...requestCancel,
      target: {
        schema_version: 2,
        kind: 'attempt',
        task_id: TASK_ID,
        attempt_id: ATTEMPT_ID,
      },
      cancel_token: {
        ...requestCancel.cancel_token,
        expected_phase: 'approval_pending',
      },
    }],
    ['attempt with round revision', {
      ...requestCancel,
      target: {
        schema_version: 2,
        kind: 'attempt',
        task_id: TASK_ID,
        attempt_id: ATTEMPT_ID,
      },
      expected_round_revision: 3,
      expected_execution_revision: null,
    }],
    ['round with execution revision', {
      ...requestCancel,
      target: {
        schema_version: 2,
        kind: 'round',
        task_id: TASK_ID,
        attempt_id: ATTEMPT_ID,
        round_id: ROUND_ID,
        round_index: 1,
      },
      cancel_token: {
        ...requestCancel.cancel_token,
        expected_phase: 'round_in_flight',
      },
      expected_round_revision: 3,
    }],
    ['round with execution phase', {
      ...requestCancel,
      target: {
        schema_version: 2,
        kind: 'round',
        task_id: TASK_ID,
        attempt_id: ATTEMPT_ID,
        round_id: ROUND_ID,
        round_index: 1,
      },
      expected_round_revision: 3,
      expected_execution_revision: null,
    }],
    ['tool with round phase', {
      ...requestCancel,
      cancel_token: {
        ...requestCancel.cancel_token,
        expected_phase: 'round_in_flight',
      },
    }],
  ])('rejects cancellation %s', (_name, input) => {
    expect(validateAgentControllerPreflight(input)).toBeNull();
  });

  test.each([
    'round_in_flight',
    'approval_pending',
    'execution_intent',
    'tool_result_pending',
  ] as const)(
    'accepts attempt cancellation for %s only without row revisions',
    expectedPhase => {
      expect(validateAgentControllerPreflight({
        ...requestCancel,
        target: {
          schema_version: 2,
          kind: 'attempt',
          task_id: TASK_ID,
          attempt_id: ATTEMPT_ID,
        },
        cancel_token: {
          ...requestCancel.cancel_token,
          expected_phase: expectedPhase,
        },
        expected_round_revision: null,
        expected_execution_revision: null,
      })?.kind).toBe('request_cancel');
    },
  );

  test('accepts the exact round cancellation revision shape', () => {
    expect(validateAgentControllerPreflight({
      ...requestCancel,
      target: {
        schema_version: 2,
        kind: 'round',
        task_id: TASK_ID,
        attempt_id: ATTEMPT_ID,
        round_id: ROUND_ID,
        round_index: 1,
      },
      cancel_token: {
        ...requestCancel.cancel_token,
        expected_phase: 'round_in_flight',
      },
      expected_round_revision: 3,
      expected_execution_revision: null,
    })?.kind).toBe('request_cancel');
  });

  test('accepts a first-round target with expected_round_revision zero', () => {
    expect(validateAgentControllerPreflight({
      ...requestCancel,
      target: {
        schema_version: 2,
        kind: 'round',
        task_id: TASK_ID,
        attempt_id: ATTEMPT_ID,
        round_id: ROUND_ID,
        round_index: 1,
      },
      cancel_token: {
        ...requestCancel.cancel_token,
        expected_phase: 'round_in_flight',
      },
      expected_round_revision: 0,
      expected_execution_revision: null,
    })?.kind).toBe('request_cancel');
  });

  test.each([-1, Number.NaN])(
    'rejects invalid round cancellation revision %s',
    expectedRoundRevision => {
      expect(validateAgentControllerPreflight({
        ...requestCancel,
        target: {
          schema_version: 2,
          kind: 'round',
          task_id: TASK_ID,
          attempt_id: ATTEMPT_ID,
          round_id: ROUND_ID,
          round_index: 1,
        },
        cancel_token: {
          ...requestCancel.cancel_token,
          expected_phase: 'round_in_flight',
        },
        expected_round_revision: expectedRoundRevision,
        expected_execution_revision: null,
      })).toBeNull();
    },
  );

  test('rejects tool cancellation at execution revision zero', () => {
    expect(validateAgentControllerPreflight({
      ...requestCancel,
      expected_execution_revision: 0,
    })).toBeNull();
  });

  test('accepts a tool target while tool_result_pending', () => {
    expect(validateAgentControllerPreflight({
      ...requestCancel,
      cancel_token: {
        ...requestCancel.cancel_token,
        expected_phase: 'tool_result_pending',
      },
    })?.kind).toBe('request_cancel');
  });

  test('rejects accessors and nested forbidden fields without invoking them', () => {
    let invoked = false;
    const accessor = { ...beginRound } as Record<string, unknown>;
    Object.defineProperty(accessor, 'task_id', {
      enumerable: true,
      get() {
        invoked = true;
        return TASK_ID;
      },
    });
    expect(validateAgentControllerPreflight(accessor)).toBeNull();
    expect(invoked).toBe(false);
    expect(validateAgentControllerPreflight({
      ...requestCancel,
      target: { ...requestCancel.target, receipt: null },
    })).toBeNull();
  });
});

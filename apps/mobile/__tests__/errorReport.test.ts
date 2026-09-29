import { buildErrorReport } from '../src/diagnostics/errorReport';

// What a person wrote never reaches the report: not the message, not a file
// name, not a tool's arguments, not a relay address. What does is the
// failure's shape -- codes, phases, tool names, counts, short ids.
test('a report carries the failure and nothing a person wrote', () => {
  const conversation = {
    id: '10101010-1010-4101-8101-101010101010',
    modelId: 'deepseek-v4-flash',
    thinkingMode: 'max',
    workspaceId: 'w', projectId: null,
    title: 'SECRET TITLE about pelicans',
    messages: [{ id: 'm', role: 'user', text: 'SECRET-USER-TEXT draw a pelican', attachments: [{ name: 'secret-plan.pdf' }] }],
    turns: [{ turnId: 't', attemptIds: ['40404040-4040-4404-8404-404040404040'] }],
    attempts: [{
      attemptId: '40404040-4040-4404-8404-404040404040', turnId: 't', status: 'failed',
      failureCode: 'E_AGENT_ROUND_AMBIGUOUS', harnessId: 'dsh', modelId: 'deepseek-v4-flash',
      thinkingMode: 'max', rounds: [], journalRevision: 4,
      agent: {
        phase: 'ambiguous', controller_generation: 3, round_index: 0, reserved_write_bytes: 0,
        round_lineage: { status: 'ambiguous', launch_attempt: 1, native_row_revision: 5 },
        batch: [{ name: 'write_file', approval_decision: 'allow_once', receipt: null, arguments_sha256: 'a'.repeat(64) }],
      },
    }],
  } as never;
  const report = buildErrorReport({
    now: '2026-09-30T08:00:00.000Z',
    build: { build: '9f19451', platform: 'android', os: '13', api: 33, device: 'Google Pixel XL' },
    notice: 'E_COMPLETION_NATIVE',
    controller: {
      phase: 'resume_available', failureCode: 'E_COMPLETION_NATIVE',
      failureDiagnostic: 'agent_runtime/v1 operation=recover_agent_attempt kind=refused code=E_AGENT_NATIVE cause=Refused site=AndroidAgentRecoveryService.recover:212',
      attemptId: '40404040-4040-4404-8404-404040404040', roundId: null,
    },
    providerFailure: { code: 'E_COMPLETION_HTTP_STATUS', httpStatus: 502 },
    conversation,
    sessionEvents: [
      { attempt_id: '40404040-4040-4404-8404-404040404040', kind: 'round', status: 'running', round_index: 0, failure_code: null },
      { attempt_id: '40404040-4040-4404-8404-404040404040', kind: 'terminal', status: 'failed', round_index: null, failure_code: 'E_AGENT_ROUND_AMBIGUOUS' },
    ] as never,
  });
  for (const expected of [
    'build: 9f19451 · android 13 (API 33) · Google Pixel XL',
    'notice: E_COMPLETION_NATIVE',
    'site=AndroidAgentRecoveryService.recover:212',
    'provider: E_COMPLETION_HTTP_STATUS HTTP 502',
    'thinking=max', 'workspace=yes',
    'phase=ambiguous', 'lineage=ambiguous launch=1 rev=5',
    'calls=[write_file:allow_once:-]',
    'round/running/r0 · terminal/failed/E_AGENT_ROUND_AMBIGUOUS',
  ]) expect(report).toContain(expected);
  for (const secret of ['SECRET', 'pelican', 'secret-plan', 'aaaaaaaa']) {
    expect(report).not.toContain(secret);
  }
});

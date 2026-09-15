import { projectToolActivity } from '../src/components/toolActivityProjection';
import type { AgentFailureCode, SessionEventV2 } from '../src/state/types';

const base = { schema_version: 2 as const, attempt_id: 'a', round_index: null, created_at: '2026-09-09T00:00:00.000Z' };
test('projects interleaved real tool events per attempt with bounded safe details', () => {
  const blocks = projectToolActivity([
    { ...base, schema_version: 2, event_id: 'c1', seq: 1, kind: 'tool_call', call_id: 't1', status: 'running', safe_summary_key: 'agent.read_file', arguments_sha256: null, result_sha256: null, approval_reference: null, failure_code: null },
    { ...base, schema_version: 2, event_id: 'c2', seq: 2, kind: 'tool_call', call_id: 't2', status: 'running', safe_summary_key: 'agent.list_dir', arguments_sha256: null, result_sha256: null, approval_reference: null, failure_code: null },
    { ...base, schema_version: 2, event_id: 'r1', seq: 3, kind: 'tool_result', call_id: 't1', status: 'ok', safe_summary_key: 'agent.read_file', arguments_sha256: null, result_sha256: null, approval_reference: null, failure_code: null, created_at: '2026-09-09T00:00:00.120Z' },
    { ...base, schema_version: 2, event_id: 'r2', seq: 4, kind: 'tool_result', call_id: 't2', status: 'denied', safe_summary_key: 'agent.list_dir', arguments_sha256: null, result_sha256: null, approval_reference: null, failure_code: null },
    { ...base, schema_version: 2, attempt_id: 'other', event_id: 'x', seq: 1, kind: 'tool_result', call_id: 't1', status: 'ok', safe_summary_key: 'agent.read_file', arguments_sha256: null, result_sha256: null, approval_reference: null, failure_code: null },
  ], 'a');
  expect(blocks.map(block => block.type)).toEqual(['tool-call', 'tool-call']);
  expect(blocks[0]).toMatchObject({ status: 'success', arguments: '' });
  expect(blocks[0]).toMatchObject({ durationMs: 120 });
  expect(blocks[1]).toMatchObject({ status: 'error' });
});

test('keeps ambiguous results unknown and scopes round cancellation', () => {
  const blocks = projectToolActivity([
    { schema_version: 2, event_id: 'c1', attempt_id: 'a', seq: 1, kind: 'tool_call', round_index: 1, call_id: 'one', status: 'running', safe_summary_key: 'agent.read_file', arguments_sha256: null, result_sha256: null, approval_reference: null, failure_code: null, created_at: '2026-09-09T00:00:00Z' },
    { schema_version: 2, event_id: 'c2', attempt_id: 'a', seq: 2, kind: 'tool_call', round_index: 2, call_id: 'two', status: 'running', safe_summary_key: 'agent.list_dir', arguments_sha256: null, result_sha256: null, approval_reference: null, failure_code: null, created_at: '2026-09-09T00:00:00Z' },
    { schema_version: 2, event_id: 'x', attempt_id: 'a', seq: 3, kind: 'terminal', round_index: 1, call_id: null, status: 'unknown', safe_summary_key: null, arguments_sha256: null, result_sha256: null, approval_reference: null, failure_code: null, created_at: '2026-09-09T00:00:01Z' },
  ], 'a');
  expect(blocks[0]).toMatchObject({ status: 'unknown' });
  expect(blocks[1]).toMatchObject({ status: 'running' });
});

const callEvent: SessionEventV2 = {
  ...base, event_id: 'call', seq: 1, kind: 'tool_call', round_index: 1,
  call_id: 'write', status: 'running', safe_summary_key: 'agent.write_file',
  arguments_sha256: 'a'.repeat(64), result_sha256: null,
  approval_reference: null, failure_code: null,
};

test.each<[SessionEventV2['status'], AgentFailureCode, string, boolean | undefined]>([
  ['denied', 'E_AGENT_BAD_ARGUMENTS', 'error', true],
  ['denied', 'E_AGENT_BAD_PATH', 'error', true],
  ['denied', 'E_AGENT_CAPABILITY', 'error', true],
  ['denied', 'E_AGENT_DENIED_BY_USER', 'error', true],
  ['failed', 'E_AGENT_TOOL_FAILED', 'error', undefined],
  ['ambiguous', 'E_AGENT_EXECUTION_AMBIGUOUS', 'unknown', undefined],
])('retains %s / %s from the tool result without requiring output', (status, failureCode, projectedStatus, denied) => {
  const result: SessionEventV2 = {
    ...callEvent, event_id: 'result', seq: 2, kind: 'tool_result',
    result_sha256: 'b'.repeat(64), status, failure_code: failureCode,
  };
  const blocks = projectToolActivity([result, callEvent], 'a');
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({
    status: projectedStatus, failureCode, denied, durationMs: 0, arguments: '',
  });
});

test('keeps missing failure details missing instead of inventing an error code', () => {
  const blocks = projectToolActivity([
    callEvent,
    { ...callEvent, event_id: 'result', seq: 2, kind: 'tool_result', status: 'failed' },
  ], 'a');
  expect(blocks[0]).toMatchObject({ status: 'error', failureCode: undefined });
});

test('associates error codes with the exact attempt, round, and call only', () => {
  const blocks = projectToolActivity([
    callEvent,
    { ...callEvent, event_id: 'second-round', seq: 2, round_index: 2 },
    { ...callEvent, event_id: 'other-attempt', seq: 3, attempt_id: 'other', kind: 'tool_result', status: 'failed', failure_code: 'E_AGENT_BAD_PATH' },
    { ...callEvent, event_id: 'first-result', seq: 4, kind: 'tool_result', status: 'failed', failure_code: 'E_AGENT_TOOL_FAILED' },
    { ...callEvent, event_id: 'terminal', seq: 5, kind: 'terminal', call_id: null, round_index: null, status: 'failed', failure_code: 'E_AGENT_CONFLICT' },
  ], 'a');
  expect(blocks[0]).toMatchObject({ status: 'error', failureCode: 'E_AGENT_TOOL_FAILED' });
  expect(blocks[1]).toMatchObject({ status: 'unknown', failureCode: undefined });
});

test('retains a call-specific terminal failure without attributing it to a peer', () => {
  const blocks = projectToolActivity([
    callEvent,
    { ...callEvent, event_id: 'peer', seq: 2, call_id: 'read' },
    { ...callEvent, event_id: 'terminal', seq: 3, kind: 'terminal', status: 'failed', failure_code: 'E_AGENT_CONFLICT' },
  ], 'a');
  expect(blocks[0]).toMatchObject({ status: 'unknown', failureCode: 'E_AGENT_CONFLICT' });
  expect(blocks[1]).toMatchObject({ status: 'running', failureCode: undefined });
});

import { projectToolActivity } from '../src/components/toolActivityProjection';

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

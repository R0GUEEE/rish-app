import { parseAgentAttemptPresentation } from '../src/agent/AgentRoundPresentation';
import { agentTextSHA256 } from '../src/completion/SessionPersistence';
import { projectAgentActivity } from '../src/components/agentActivityProjection';
import type { PersistedSessionEventV3 } from '../src/state/types';

const owner = '10000000-0000-4000-8000-000000000001';
const attempt = '10000000-0000-4000-8000-000000000002';
function round(index: number, kind: 'tool_batch' | 'final' = 'tool_batch', text = 'I will inspect the file.', reasoning = 'Provider reasoning') {
  return { round_id: `20000000-0000-4000-8000-00000000000${index}`, round_index: index, kind, text, reasoning,
    assistant_text_sha256: agentTextSHA256(text)!, reasoning_text_sha256: agentTextSHA256(reasoning)! };
}
function payload(rounds = [round(0), round(1, 'final', 'Done.', 'Final reasoning')]) {
  return { schema_version: 1 as const, conversation_id: owner, attempt_id: attempt, rounds };
}
const events: PersistedSessionEventV3[] = [{
  schema_version: 2, event_id: 'call', attempt_id: attempt, seq: 1, kind: 'tool_call', round_index: 0,
  call_id: 'read', status: 'running', safe_summary_key: 'agent.read_file', arguments_sha256: null,
  result_sha256: null, approval_reference: null, failure_code: null, created_at: '2026-09-10T00:00:00Z',
}, {
  schema_version: 2, event_id: 'result', attempt_id: attempt, seq: 2, kind: 'tool_result', round_index: 0,
  call_id: 'read', status: 'ok', safe_summary_key: 'agent.read_file', arguments_sha256: null,
  result_sha256: null, approval_reference: null, failure_code: null, created_at: '2026-09-10T00:00:01Z',
}];

test('restores exact provider material, ordered before tools, with no final duplication', () => {
  const restored = parseAgentAttemptPresentation(JSON.parse(JSON.stringify(payload())), owner, attempt)!;
  expect(restored).not.toBeNull();
  const blocks = projectAgentActivity(events, attempt, restored, true);
  expect(blocks.map(block => block.type)).toEqual(['reasoning', 'text', 'tool-call']);
  expect(blocks[2]).toMatchObject({ status: 'success', durationMs: 1000 });
  expect(projectAgentActivity(events, attempt, restored, true)).toEqual(blocks);
  expect(projectAgentActivity(events, attempt, restored).map(block => block.type)).toEqual(['reasoning', 'text', 'tool-call', 'reasoning', 'text']);
});

test('rejects cross-owner, changed provider text, duplicate round and unknown fields', () => {
  expect(parseAgentAttemptPresentation(payload(), 'other', attempt)).toBeNull();
  expect(parseAgentAttemptPresentation(payload(), owner, 'other')).toBeNull();
  expect(parseAgentAttemptPresentation(payload([{ ...round(0), text: 'tampered' }]), owner, attempt)).toBeNull();
  expect(parseAgentAttemptPresentation(payload([round(0), round(0)]), owner, attempt)).toBeNull();
  expect(parseAgentAttemptPresentation({ ...payload(), untrusted: true }, owner, attempt)).toBeNull();
});

test('does not fabricate prose for empty provider output or unavailable projections', () => {
  const empty = payload([round(0, 'tool_batch', '', '')]);
  expect(projectAgentActivity(events, attempt, empty).map(block => block.type)).toEqual(['tool-call']);
  expect(projectAgentActivity(events, attempt).map(block => block.type)).toEqual(['tool-call']);
  expect(projectAgentActivity(events, 'other', empty)).toEqual([]);
});

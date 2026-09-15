import type { AgentPolicyDescriptor } from '../src/native/agent-policy';
import type { AgentConversationGrantV2 } from '../src/state';
import { projectAgentPolicy } from '../src/components/agent-policy-projection';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const conversationId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const policy: AgentPolicyDescriptor = {
  schema_version: 1, workspace_id: workspaceId, workspace_binding_revision: 3, project_id: null,
  root_fingerprint_sha256: 'a'.repeat(64), registry_version: 2, policy_version: 'agent-v1',
  capabilities: ['file_read', 'file_write', 'guest_service'],
  tools: [
    { name: 'list_dir', access: 'auto' }, { name: 'read_file', access: 'auto' },
    { name: 'write_file', access: 'conversation_confirm' },
    { name: 'start_guest_cgi', access: 'conversation_confirm' },
    { name: 'stop_guest_cgi', access: 'conversation_confirm' },
  ],
  budget: { max_single_write_bytes: 32768, max_batch_write_bytes: 524288, max_attempt_write_bytes: 4194304 },
};
const context = {
  workspaceId, bindingRevision: 3, projectId: null, conversationId,
  status: 'ready' as const, policy, grants: [],
};
const grant: AgentConversationGrantV2 = {
  schema_version: 2, grant_id: '44444444-4444-4444-8444-444444444444', conversation_id: conversationId,
  workspace_id: workspaceId, project_id: null, binding_revision: 3,
  root_fingerprint_sha256: policy.root_fingerprint_sha256, tool_family: 'guest_service',
  registry_version: 2, policy_version: 'agent-v1',
  issued_for: { schema_version: 1, task_id: 'task', attempt_id: 'attempt' },
  created_at: '2026-09-15T00:00:00Z',
};

test('native policy shows services before a task and after it finishes without an attempt dependency', () => {
  const result = projectAgentPolicy(context);
  expect(result.status).toBe('ready');
  expect(result.capabilities).toContain('guest_service');
  expect(result.toolAccess.start_guest_cgi).toBe('conversation_confirm');
  expect(result.toolAccess.stop_guest_cgi).toBe('conversation_confirm');
  expect(result.toolAccess.git_status).toBe('not_enabled');
  expect(result.budget).toEqual(policy.budget);
});

test('Git access uses native modes instead of a hardcoded push approval mode', () => {
  const result = projectAgentPolicy({ ...context, projectId, policy: {
    ...policy, project_id: projectId, capabilities: [...policy.capabilities, 'git_status', 'git_commit', 'git_push'],
    tools: [...policy.tools, { name: 'git_status', access: 'auto' },
      { name: 'git_commit', access: 'conversation_confirm' }, { name: 'git_push', access: 'conversation_confirm' }],
  } });
  expect(result.gitProjectRequired).toBe(false);
  expect(result.toolAccess.git_status).toBe('auto');
  expect(result.toolAccess.git_push).toBe('conversation_confirm');
});

test('only current matching conversation grants change confirmation display', () => {
  const result = projectAgentPolicy({ ...context, grants: [grant] });
  expect(result.grants).toEqual([grant]);
  expect(result.toolAccess.start_guest_cgi).toBe('conversation_allowed');
  expect(result.toolAccess.stop_guest_cgi).toBe('conversation_allowed');
  expect(result.toolAccess.write_file).toBe('conversation_confirm');
});

test.each<Partial<AgentConversationGrantV2>>([
  { conversation_id: 'other' }, { workspace_id: 'other' }, { project_id: projectId },
  { binding_revision: 2 }, { root_fingerprint_sha256: 'b'.repeat(64) }, { registry_version: 1 },
])('does not show a stale or differently scoped grant as effective: %j', override => {
  const result = projectAgentPolicy({ ...context, grants: [{ ...grant, ...override }] });
  expect(result.grants).toEqual([]);
  expect(result.toolAccess.start_guest_cgi).toBe('conversation_confirm');
});

test('does not turn a once-only native tool into a conversation grant', () => {
  const result = projectAgentPolicy({ ...context, grants: [grant], policy: {
    ...policy, tools: [{ name: 'start_guest_cgi', access: 'confirm_once' }],
  } });
  expect(result.grants).toEqual([]);
  expect(result.toolAccess.start_guest_cgi).toBe('confirm_once');
});

test.each(['loading', 'error', 'unavailable', 'idle'] as const)('does not infer access while native status is %s', status => {
  const result = projectAgentPolicy({ ...context, status, grants: [grant] });
  expect(result.capabilities).toEqual([]);
  expect(result.budget).toBeNull();
  expect(result.grants).toEqual([]);
  expect(new Set(Object.values(result.toolAccess))).toEqual(new Set([status === 'loading' ? 'checking' : 'unverified']));
});

test.each([
  { workspaceId: 'other' }, { bindingRevision: 4 }, { projectId }, { policy: null },
])('hides a previous binding response synchronously: %j', override => {
  const result = projectAgentPolicy({ ...context, ...override });
  expect(result.status).toBe('loading');
  expect(result.capabilities).toEqual([]);
  expect(result.toolAccess.read_file).toBe('checking');
});

test('a verified unsupported feature is unavailable, not an unverified or user-denied permission', () => {
  const result = projectAgentPolicy({ ...context, policy: { ...policy, capabilities: ['file_read'],
    tools: [{ name: 'read_file', access: 'auto' }] } });
  expect(result.toolAccess.start_guest_cgi).toBe('unavailable');
  expect(result.toolAccess.write_file).toBe('unavailable');
});

test('no workspace never shows stale capabilities or budgets', () => {
  const result = projectAgentPolicy({ ...context, workspaceId: null });
  expect(result.status).toBe('unbound');
  expect(result.budget).toBeNull();
  expect(result.capabilities).toEqual([]);
});


const runtimeTools = [
  { name: 'list_runtime_environments', access: 'auto' },
  { name: 'install_runtime_environment', access: 'conversation_confirm' },
  { name: 'run_program', access: 'conversation_confirm' },
  { name: 'start_runtime_service', access: 'conversation_confirm' },
  { name: 'stop_runtime_service', access: 'conversation_confirm' },
] as const;
const runtimeMutations = runtimeTools.slice(1);

test('runtime listing is automatic and all four native runtime mutations require confirmation', () => {
  const result = projectAgentPolicy({ ...context, policy: {
    ...policy, registry_version: 3, tools: [...policy.tools, ...runtimeTools],
  } });
  expect(result.toolAccess.list_runtime_environments).toBe('auto');
  for (const tool of runtimeMutations) expect(result.toolAccess[tool.name]).toBe('conversation_confirm');
});

test('only a matching v3 guest-service grant covers new runtime mutations', () => {
  const runtimePolicy: AgentPolicyDescriptor = { ...policy, registry_version: 3, tools: runtimeTools };
  const granted = projectAgentPolicy({ ...context, policy: runtimePolicy,
    grants: [{ ...grant, registry_version: 3 }] });
  expect(granted.toolAccess.list_runtime_environments).toBe('auto');
  for (const tool of runtimeMutations) expect(granted.toolAccess[tool.name]).toBe('conversation_allowed');
  for (const staleGrant of [grant, { ...grant, registry_version: 1 as const }]) {
    const result = projectAgentPolicy({ ...context, policy: runtimePolicy, grants: [staleGrant] });
    expect(result.grants).toEqual([]);
    for (const tool of runtimeMutations) expect(result.toolAccess[tool.name]).toBe('conversation_confirm');
  }
});

test.each([1, 2] as const)('legacy registry v%i never derives runtime availability from a guest-service grant', registry_version => {
  const result = projectAgentPolicy({ ...context, policy: { ...policy, registry_version },
    grants: [{ ...grant, registry_version }] });
  for (const tool of runtimeTools) expect(result.toolAccess[tool.name]).toBe('unavailable');
});

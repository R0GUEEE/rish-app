import {
  agentToolAccess,
  projectAgentPolicy,
} from '../src/components/agent-policy-projection';

type PolicyContext = Parameters<typeof projectAgentPolicy>[0];
const descriptor: NonNullable<PolicyContext['descriptor']> = {
  schema_version: 2,
  workspace_id: 'workspace-a',
  binding_revision: 3,
  display_name: 'Preview',
  origin: 'rish_created',
  status: 'ok',
  capabilities: { read: true, write: true, git: false, project_context: false, files_visible: true },
  created_at: '2026-09-14T00:00:00Z',
  last_opened_at: '2026-09-14T00:00:00Z',
};
const context: PolicyContext = {
  workspaceId: 'workspace-a',
  projectId: null,
  descriptor,
  binding: { schemaVersion: 1, workspaceId: 'workspace-a', bindingRevision: 3, projectId: null },
};
const attempt: NonNullable<PolicyContext['attempt']> = {
  status: 'sending',
  workspaceId: 'workspace-a',
  workspaceBindingRevision: 3,
  agent: {
    phase: 'round_in_flight',
    tool_registry_version: 2,
    root: {
      schema_version: 1,
      kind: 'workspace',
      workspace_id: 'workspace-a',
      workspace_binding_revision: 3,
      project_id: null,
      root_fingerprint_sha256: 'a'.repeat(64),
      capabilities: ['file_read', 'file_write', 'guest_service'],
    },
  },
};

test('file access does not imply service build support or Git project authority', () => {
  const projection = projectAgentPolicy(context);
  expect(projection.gitProjectRequired).toBe(true);
  expect(projection.capabilities).toEqual(['file_read', 'file_write']);
  expect(agentToolAccess(projection.capabilities, projection.guestServiceVerified)).toEqual({
    list_dir: 'auto', read_file: 'auto', write_file: 'conversation_confirm',
    git_status: 'durable_deny', git_commit: 'durable_deny', git_push: 'durable_deny',
    start_guest_cgi: 'unverified', stop_guest_cgi: 'unverified',
  });
});

test('a current matching native root and registry can verify guest-service availability', () => {
  const projection = projectAgentPolicy({ ...context, attempt });
  expect(projection.guestServiceVerified).toBe(true);
  expect(projection.capabilities).toContain('guest_service');
  const access = agentToolAccess(projection.capabilities, projection.guestServiceVerified);
  expect(access.start_guest_cgi).toBe('conversation_confirm');
  expect(access.stop_guest_cgi).toBe('conversation_confirm');
  expect(access.git_commit).toBe('durable_deny');
});

test.each([
  { ...attempt.agent!, tool_registry_version: 1 as const },
  { ...attempt.agent!, root: { ...attempt.agent!.root, capabilities: ['file_read', 'file_write'] as const } },
])('a verified runtime without the service feature or registry shows unavailable', agent => {
  const projection = projectAgentPolicy({ ...context, attempt: { ...attempt, agent } });
  expect(projection.guestServiceVerified).toBe(true);
  expect(projection.capabilities).not.toContain('guest_service');
  expect(agentToolAccess(projection.capabilities, projection.guestServiceVerified).start_guest_cgi).toBe('durable_deny');
});

test.each<Partial<PolicyContext>>([
  { attempt: null },
  { attempt: { ...attempt, agent: null } },
  { attempt: { ...attempt, status: 'completed' } },
  { attempt: { ...attempt, status: 'failed' } },
  { attempt: { ...attempt, workspaceId: 'another-workspace' } },
  { attempt: { ...attempt, workspaceBindingRevision: 2 } },
  { attempt: { ...attempt, agent: { ...attempt.agent!, phase: 'unknown' } } },
  { attempt: { ...attempt, agent: { ...attempt.agent!, root: { ...attempt.agent!.root, workspace_binding_revision: 2 } } } },
  { attempt: { ...attempt, agent: { ...attempt.agent!, root: { ...attempt.agent!.root, project_id: 'another-project' } } } },
  { descriptor: { ...descriptor, binding_revision: 4 } },
  { descriptor: { ...descriptor, status: 'revoked' } },
  { binding: null },
])('missing, historic, or mismatched evidence does not claim service is denied or supported: %j', override => {
  const projection = projectAgentPolicy({ ...context, attempt, ...override });
  expect(projection.guestServiceVerified).toBe(false);
  expect(projection.capabilities).not.toContain('guest_service');
  expect(agentToolAccess(projection.capabilities, projection.guestServiceVerified).start_guest_cgi).toBe('unverified');
});

test('Git access still requires a bound project with the workspace Git capability', () => {
  const projection = projectAgentPolicy({
    ...context,
    projectId: 'project-a',
    binding: { ...context.binding!, projectId: 'project-a' },
    descriptor: { ...descriptor, capabilities: { ...descriptor.capabilities, git: true, project_context: true } },
  });
  expect(projection.gitProjectRequired).toBe(false);
  const access = agentToolAccess(projection.capabilities, projection.guestServiceVerified);
  expect(access.git_status).toBe('auto');
  expect(access.git_commit).toBe('conversation_confirm');
  expect(access.git_push).toBe('confirm_once');
  expect(access.start_guest_cgi).toBe('unverified');
  const withoutGit = projectAgentPolicy({ ...context, projectId: 'project-a' });
  expect(withoutGit.capabilities).not.toContain('git_status');
});

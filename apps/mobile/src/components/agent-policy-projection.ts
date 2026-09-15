import type { AgentPolicyDescriptor } from '../native/agent-policy';
import type { AgentConversationGrantV2 } from '../state';

export const AGENT_POLICY_TOOLS = [
  'list_dir', 'read_file', 'write_file', 'git_status', 'git_commit',
  'git_push', 'start_guest_cgi', 'stop_guest_cgi',
  'list_runtime_environments', 'install_runtime_environment', 'run_program',
  'start_runtime_service', 'stop_runtime_service',
] as const;
export type PolicyTool = (typeof AGENT_POLICY_TOOLS)[number];
export type AgentPolicyAccess =
  | 'auto' | 'conversation_confirm' | 'confirm_once' | 'durable_deny'
  | 'conversation_allowed' | 'not_enabled' | 'unavailable' | 'unverified' | 'checking';
export type AgentPolicyViewStatus =
  'unbound' | 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

type PolicyContext = {
  readonly workspaceId: string | null;
  readonly bindingRevision: number | null;
  readonly projectId: string | null;
  readonly conversationId: string | null;
  readonly status: Exclude<AgentPolicyViewStatus, 'unbound'>;
  readonly policy: AgentPolicyDescriptor | null;
  readonly grants: readonly AgentConversationGrantV2[];
};

function grantFamily(tool: PolicyTool): AgentConversationGrantV2['tool_family'] | null {
  if (tool === 'write_file') return 'file_write';
  if (tool === 'git_commit' || tool === 'git_push') return tool;
  if (tool === 'start_guest_cgi' || tool === 'stop_guest_cgi' ||
      tool === 'install_runtime_environment' || tool === 'run_program' ||
      tool === 'start_runtime_service' || tool === 'stop_runtime_service') return 'guest_service';
  return null;
}

/** Current display metadata only. Every execution still revalidates natively. */
export function projectAgentPolicy(context: PolicyContext) {
  const { workspaceId, bindingRevision, projectId, conversationId, policy } = context;
  const matches = policy !== null && policy.workspace_id === workspaceId &&
    policy.workspace_binding_revision === bindingRevision && policy.project_id === projectId;
  const status: AgentPolicyViewStatus = workspaceId === null ? 'unbound'
    : context.status === 'ready' && !matches ? 'loading' : context.status;
  const current = status === 'ready' && matches ? policy : null;
  const grants = current === null ? [] : context.grants.filter(grant =>
    grant.conversation_id === conversationId && grant.workspace_id === workspaceId &&
    grant.project_id === projectId && grant.binding_revision === bindingRevision &&
    grant.root_fingerprint_sha256 === current.root_fingerprint_sha256 &&
    grant.registry_version === current.registry_version && grant.policy_version === current.policy_version &&
    current.tools.some(tool => tool.access === 'conversation_confirm' &&
      grantFamily(tool.name) === grant.tool_family),
  );
  const toolAccess = Object.fromEntries(AGENT_POLICY_TOOLS.map(name => {
    let access: AgentPolicyAccess;
    if (current === null) {
      access = status === 'unbound' ? 'unavailable' : status === 'loading' ? 'checking' : 'unverified';
    } else {
      const nativeTool = current.tools.find(tool => tool.name === name);
      access = nativeTool?.access ?? (name.startsWith('git_') && projectId === null
        ? 'not_enabled' : 'unavailable');
      if (access === 'conversation_confirm' && grants.some(grant => grant.tool_family === grantFamily(name)))
        access = 'conversation_allowed';
    }
    return [name, access];
  })) as Record<PolicyTool, AgentPolicyAccess>;
  return {
    status,
    capabilities: current?.capabilities ?? [],
    budget: current?.budget ?? null,
    toolAccess,
    grants,
    gitProjectRequired: workspaceId !== null && projectId === null,
  };
}

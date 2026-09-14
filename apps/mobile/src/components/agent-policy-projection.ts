import type { WorkspaceDescriptorV2 } from '../native/LocalWorkspaces';
import type {
  AgentCapability,
  ConversationWorkspaceBindingV1,
  PersistedAgentAttemptJournalV3,
  TurnAttemptV1,
} from '../state';

export const AGENT_POLICY_TOOLS = [
  'list_dir', 'read_file', 'write_file', 'git_status', 'git_commit',
  'git_push', 'start_guest_cgi', 'stop_guest_cgi',
] as const;
export type PolicyTool = (typeof AGENT_POLICY_TOOLS)[number];
export type AgentPolicyAccess =
  | 'auto'
  | 'conversation_confirm'
  | 'confirm_once'
  | 'durable_deny'
  | 'unverified';

type PolicyAttempt = Pick<TurnAttemptV1, 'status' | 'workspaceId' | 'workspaceBindingRevision'> & {
  readonly agent?: Pick<PersistedAgentAttemptJournalV3, 'root' | 'tool_registry_version' | 'phase'> | null;
};
type PolicyContext = {
  readonly workspaceId: string | null;
  readonly projectId: string | null;
  readonly binding?: ConversationWorkspaceBindingV1 | null;
  readonly descriptor?: WorkspaceDescriptorV2;
  readonly attempt?: PolicyAttempt | null;
};

/** Display only. Native still validates the root and registry before execution. */
export function projectAgentPolicy({ workspaceId, projectId, binding, descriptor, attempt }: PolicyContext) {
  const boundProjectId = binding?.projectId ?? projectId;
  const projectBound = boundProjectId !== null;
  const capabilities: AgentCapability[] = workspaceId === null ? [] : [
    ...(descriptor === undefined || descriptor.capabilities.read ? ['file_read' as const] : []),
    ...(descriptor === undefined || descriptor.capabilities.write ? ['file_write' as const] : []),
    ...((descriptor === undefined || descriptor.capabilities.git) && projectBound
      ? ['git_status', 'git_commit', 'git_push'] as const : []),
  ];
  const journal = attempt?.agent;
  // RuntimeProof has no guest-service feature flag. Do not infer build support
  // from file access or an old attempt that may predate an app update/rebinding.
  const guestServiceVerified = workspaceId !== null && binding != null &&
    binding.workspaceId === workspaceId &&
    (attempt?.status === 'prepared' || attempt?.status === 'sending') &&
    attempt.workspaceId === workspaceId &&
    attempt.workspaceBindingRevision === binding.bindingRevision &&
    journal != null &&
    ['ready_for_round', 'round_in_flight', 'batch_frozen', 'approval_pending',
      'execution_intent', 'tool_result_pending'].includes(journal.phase) &&
    journal.root.workspace_id === workspaceId &&
    journal.root.workspace_binding_revision === binding.bindingRevision &&
    journal.root.project_id === boundProjectId &&
    journal.root.kind === (projectBound ? 'project' : 'workspace') &&
    (descriptor === undefined || (descriptor.status === 'ok' &&
      descriptor.workspace_id === workspaceId &&
      descriptor.binding_revision === binding.bindingRevision));
  if (guestServiceVerified && journal.tool_registry_version === 2 &&
      journal.root.capabilities.includes('guest_service')) {
    capabilities.push('guest_service');
  }
  return {
    capabilities,
    guestServiceVerified,
    gitProjectRequired: workspaceId !== null && !projectBound,
  };
}

export function agentToolAccess(
  capabilities: readonly AgentCapability[],
  guestServiceVerified = false,
): Record<PolicyTool, AgentPolicyAccess> {
  const has = (capability: AgentCapability) => capabilities.includes(capability);
  const serviceAccess = !guestServiceVerified ? 'unverified'
    : has('guest_service') ? 'conversation_confirm' : 'durable_deny';
  return {
    list_dir: has('file_read') ? 'auto' : 'durable_deny',
    read_file: has('file_read') ? 'auto' : 'durable_deny',
    write_file: has('file_write') ? 'conversation_confirm' : 'durable_deny',
    git_status: has('git_status') ? 'auto' : 'durable_deny',
    git_commit: has('git_commit') ? 'conversation_confirm' : 'durable_deny',
    git_push: has('git_push') ? 'confirm_once' : 'durable_deny',
    start_guest_cgi: serviceAccess,
    stop_guest_cgi: serviceAccess,
  };
}

import type { AgentConversationGrantV2, AgentRegistryVersion } from '../state/types';

export const RUNTIME_AGENT_TOOLS = [
  'list_runtime_environments', 'install_runtime_environment', 'run_program',
  'start_runtime_service', 'stop_runtime_service',
] as const;

export const GUEST_SERVICE_AGENT_TOOLS = [
  'start_guest_cgi', 'stop_guest_cgi', 'install_runtime_environment',
  'run_program', 'start_runtime_service', 'stop_runtime_service',
] as const;

export const ALL_AGENT_AUTO_TOOLS = [
  'list_dir', 'read_file', 'git_status', 'list_runtime_environments',
] as const;
export const ALL_AGENT_CONFIRM_TOOLS = [
  'write_file', 'git_commit', 'git_push', ...GUEST_SERVICE_AGENT_TOOLS,
] as const;
export const ALL_AGENT_TOOL_NAMES = [...ALL_AGENT_AUTO_TOOLS, ...ALL_AGENT_CONFIRM_TOOLS] as const;

export function isRuntimeAgentTool(name: unknown): boolean {
  return typeof name === 'string' && (RUNTIME_AGENT_TOOLS as readonly string[]).includes(name);
}
export function isGuestServiceAgentTool(name: unknown): boolean {
  return typeof name === 'string' && (GUEST_SERVICE_AGENT_TOOLS as readonly string[]).includes(name);
}
export function agentToolRegistryCompatible(name: unknown, version: AgentRegistryVersion): boolean {
  if (isRuntimeAgentTool(name)) return version === 3;
  if (name === 'start_guest_cgi' || name === 'stop_guest_cgi') return version >= 2;
  return true;
}
export function agentRegistryToolLimit(version: AgentRegistryVersion): number {
  return version === 3 ? 13 : version === 2 ? 8 : 6;
}
export function agentToolGrantFamily(name: unknown): AgentConversationGrantV2['tool_family'] | null {
  if (name === 'write_file') return 'file_write';
  if (name === 'git_commit') return 'git_commit';
  if (name === 'git_push') return 'git_push';
  return isGuestServiceAgentTool(name) ? 'guest_service' : null;
}

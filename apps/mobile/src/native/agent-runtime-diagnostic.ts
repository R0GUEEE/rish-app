/** Display-only provenance. Never persisted or used as recovery authority. */
export type AgentRuntimeDiagnostic =
  `agent_runtime/v1 operation=complete_agent_round_v2 kind=${
    | 'persistence'
    | 'unavailable'
    | 'exception'
    | 'unknown'}`;

export function parseAgentRuntimeDiagnostic(value: unknown): AgentRuntimeDiagnostic | null {
  return typeof value === 'string' &&
    /^(?:agent_runtime\/v1 operation=complete_agent_round_v2 kind=(?:persistence|unavailable|exception|unknown))$/u.exec(value)?.[0] === value
    ? value as AgentRuntimeDiagnostic : null;
}

/** Accept only the complete fixed native marker; reject text around it. */
export function agentRuntimeDiagnosticFromError(error: unknown): AgentRuntimeDiagnostic | null {
  if (typeof error !== 'object' || error === null) return null;
  try {
    // Do not evaluate native or caller-supplied accessors.
    const ownValue = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
    };
    if (ownValue('code') !== 'E_AGENT_PERSISTENCE') return null;
    const diagnostic = parseAgentRuntimeDiagnostic(ownValue('diagnostic'));
    if (diagnostic !== null) return diagnostic;
    const message = ownValue('message');
    const prefix = 'E_AGENT_PERSISTENCE\n';
    return typeof message === 'string' && message.startsWith(prefix)
      ? parseAgentRuntimeDiagnostic(message.slice(prefix.length)) : null;
  } catch {
    return null;
  }
}

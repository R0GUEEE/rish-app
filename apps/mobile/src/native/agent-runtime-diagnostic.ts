/**
 * Display-only provenance. Never persisted or used as recovery authority.
 *
 * Value-free by construction: which native operation, what kind of failure,
 * the stable code, the class of what threw and the app method it threw in --
 * never a message, a path or anything a person wrote. It is what turns a
 * bare E_COMPLETION_NATIVE in a tester's screenshot into a place in the code
 * (beta report, 2026-09-29).
 */
export type AgentRuntimeDiagnostic = string & { readonly __agentRuntimeDiagnostic: true };

/** The native operations that answer with a diagnostic. */
const OPERATIONS = [
  'prepare_agent_attempt', 'complete_agent_round_v2', 'prepare_agent_tool_batch',
  'bind_agent_approval', 'execute_agent_tool', 'interrupt_agent_attempt',
  'cancel_agent_attempt', 'query_agent_attempt', 'query_agent_tool',
  'recover_agent_attempt', 'finalize_agent_attempt', 'discard_agent_attempt',
  'query_agent_cleanup',
];

const DIAGNOSTIC = new RegExp(
  `^agent_runtime/v1 operation=(?:${OPERATIONS.join('|')}) ` +
    'kind=(?:persistence|unavailable|exception|unknown|refused)' +
    '(?: code=E_[A-Z0-9_]{1,48})?' +
    '(?: cause=[A-Za-z0-9_$]{1,64})?' +
    '(?: site=[A-Za-z0-9_.$:]{1,120})?$',
  'u',
);

export function parseAgentRuntimeDiagnostic(value: unknown): AgentRuntimeDiagnostic | null {
  return typeof value === 'string' && value.length <= 400 && DIAGNOSTIC.test(value)
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
    const code = ownValue('code');
    if (typeof code !== 'string' || !/^E_[A-Z0-9_]{1,48}$/u.test(code)) return null;
    const diagnostic = parseAgentRuntimeDiagnostic(ownValue('diagnostic'));
    if (diagnostic !== null) return diagnostic;
    const message = ownValue('message');
    const prefix = `${code}\n`;
    return typeof message === 'string' && message.startsWith(prefix)
      ? parseAgentRuntimeDiagnostic(message.slice(prefix.length)) : null;
  } catch {
    return null;
  }
}

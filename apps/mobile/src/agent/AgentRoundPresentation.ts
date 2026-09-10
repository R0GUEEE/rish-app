import { NativeModules, TurboModuleRegistry } from 'react-native';
import { agentTextSHA256 } from '../completion/SessionPersistence';

/** Read-only display material. It never enters the session authority or model history. */
export type AgentRoundPresentation = {
  readonly round_id: string;
  readonly round_index: number;
  readonly kind: 'tool_batch' | 'final' | 'blocked';
  readonly text: string;
  readonly reasoning: string;
  readonly assistant_text_sha256: string;
  readonly reasoning_text_sha256: string;
};
export type AgentAttemptPresentation = {
  readonly schema_version: 1;
  readonly conversation_id: string;
  readonly attempt_id: string;
  readonly rounds: readonly AgentRoundPresentation[];
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
export function parseAgentAttemptPresentation(
  value: unknown,
  conversationId: string,
  attemptId: string,
): AgentAttemptPresentation | null {
  if (!exact(value, ['schema_version', 'conversation_id', 'attempt_id', 'rounds']) ||
      value.schema_version !== 1 || value.conversation_id !== conversationId ||
      value.attempt_id !== attemptId || !Array.isArray(value.rounds) || value.rounds.length > 8) return null;
  const ids = new Set<string>();
  const indexes = new Set<number>();
  let totalCharacters = 0;
  for (const round of value.rounds) {
    if (!exact(round, ['round_id', 'round_index', 'kind', 'text', 'reasoning', 'assistant_text_sha256', 'reasoning_text_sha256']) ||
        typeof round.round_id !== 'string' || !uuid.test(round.round_id) ||
        typeof round.round_index !== 'number' || !Number.isSafeInteger(round.round_index) || round.round_index < 0 || round.round_index > 7 ||
        !['tool_batch', 'final', 'blocked'].includes(String(round.kind)) ||
        typeof round.text !== 'string' || round.text.length > 2 * 1024 * 1024 ||
        typeof round.reasoning !== 'string' || round.reasoning.length > 2 * 1024 * 1024 ||
        typeof round.assistant_text_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(round.assistant_text_sha256) ||
        typeof round.reasoning_text_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(round.reasoning_text_sha256) ||
        agentTextSHA256(round.text) !== round.assistant_text_sha256 ||
        agentTextSHA256(round.reasoning) !== round.reasoning_text_sha256 ||
        ids.has(round.round_id) || indexes.has(round.round_index)) return null;
    totalCharacters += round.text.length + round.reasoning.length;
    if (totalCharacters > 2 * 1024 * 1024) return null;
    ids.add(round.round_id); indexes.add(round.round_index);
  }
  return value as unknown as AgentAttemptPresentation;
}
export async function readAgentAttemptPresentation(
  conversationId: string,
  attemptId: string,
): Promise<AgentAttemptPresentation | null> {
  if (!uuid.test(conversationId) || !uuid.test(attemptId)) return null;
  try {
    let candidate: unknown;
    let native: { read_agent_round_presentations?: (request: unknown) => Promise<unknown> } | null = null;
    try { candidate = TurboModuleRegistry.get('AgentRuntime'); } catch {}
    candidate ??= NativeModules.AgentRuntime;
    if (candidate !== null && typeof candidate === 'object') native = candidate;
    if (typeof native?.read_agent_round_presentations !== 'function') return null;
    const result: unknown = await native.read_agent_round_presentations({
      schema_version: 1, conversation_id: conversationId, attempt_id: attemptId,
    });
    return parseAgentAttemptPresentation(result, conversationId, attemptId);
  } catch {
    // Optional presentation must not alter execution, retry, or persistence.
    return null;
  }
}

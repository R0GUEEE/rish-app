import type { ChatState } from '../state/types';

/**
 * The causes the core names when a provider refused a round in full -- a
 * status line came back, so the request was turned away and no reply was
 * made. Nothing else qualifies: an ambiguity, a transport failure or a
 * refusal raised while the request was being built says nothing about
 * whether a fresh attempt would repeat something.
 */
export const PROVIDER_REFUSAL_CODES = [
  'E_AGENT_PROVIDER_CREDENTIAL',
  'E_AGENT_PROVIDER_FORBIDDEN',
  'E_AGENT_PROVIDER_NOT_FOUND',
  'E_AGENT_PROVIDER_RATE_LIMITED',
  'E_AGENT_PROVIDER_REFUSED',
] as const;

const REFUSALS = new Set<string>(PROVIDER_REFUSAL_CODES);

/**
 * True when a failed agent attempt may be asked again as a fresh attempt in
 * the same turn.
 *
 * An agent attempt is normally never retried that way: a new attempt starts
 * the turn over, and any tool an earlier round ran would run again. A round
 * the provider refused on the turn's *first* round, before any tool call,
 * approval or write reservation, has no such history -- starting over is
 * exactly what the person would do by sending the message again, which is
 * all a relay being set up needs. Every condition is read from durable state:
 *
 * - the attempt is the conversation's latest and its turn's latest, settled
 *   `failed` with one of the five refusal causes;
 * - its journal ended `failed` on round 0 with a failed_retryable lineage,
 *   no batch, no call, no frozen grant and no reserved write;
 * - it recorded no round, active round or assistant message;
 * - its session events are only round and terminal events -- no tool call,
 *   tool result or approval ever happened;
 * - its transcript cleanup has been acknowledged, which is native's
 *   confirmation that the attempt's residue was discarded.
 */
export function refusedAttemptRetryable(
  state: ChatState,
  conversationId: string,
  attemptId: string,
): boolean {
  const conversation = state.conversations[conversationId];
  if (conversation === undefined) return false;
  const attempt = conversation.attempts.at(-1);
  if (attempt === undefined || attempt.attemptId !== attemptId) return false;
  const turn = conversation.turns.find(item => item.turnId === attempt.turnId);
  if (turn === undefined || turn.attemptIds.at(-1) !== attemptId) return false;
  if (
    attempt.status !== 'failed' ||
    attempt.failureCode === null ||
    !REFUSALS.has(attempt.failureCode) ||
    attempt.rounds.length !== 0 ||
    attempt.activeRound !== null ||
    attempt.assistantMessageId !== null
  ) return false;
  const journal = attempt.agent;
  if (
    journal === undefined ||
    journal === null ||
    journal.schema_version !== 3 ||
    journal.phase !== 'failed' ||
    journal.round_index !== 0 ||
    journal.round_lineage === null ||
    journal.round_lineage.round_index !== 0 ||
    journal.round_lineage.status !== 'failed_retryable' ||
    journal.batch.length !== 0 ||
    journal.call_index !== null ||
    journal.frozen_grant_ids.length !== 0 ||
    journal.reserved_write_bytes !== 0
  ) return false;
  const events = (state.sessionEvents ?? []).filter(event => event.attempt_id === attemptId);
  if (events.some(event => event.kind !== 'round' && event.kind !== 'terminal')) return false;
  if ((state.agentTranscriptCleanupOutbox ?? []).some(entry => entry.attempt_id === attemptId)) {
    return false;
  }
  return true;
}

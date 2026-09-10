import type { AgentAttemptPresentation } from '../agent/AgentRoundPresentation';
import type { PersistedSessionEventV3 } from '../state/types';
import type { StructuredBlock } from './StructuredContent';
import { projectToolActivity } from './toolActivityProjection';

/** Merge provider material before its tools; final messages retain their existing owner. */
export function projectAgentActivity(
  events: readonly PersistedSessionEventV3[],
  attemptId: string,
  presentation?: AgentAttemptPresentation,
  hasFinalMessage = false,
): StructuredBlock[] {
  const tools = projectToolActivity(events, attemptId);
  if (presentation === undefined || presentation.attempt_id !== attemptId) return tools;
  const eventRounds = new Map(events.filter(event => event.attempt_id === attemptId).map(event => [event.event_id, event.round_index]));
  const indexes = new Set<number>();
  for (const tool of tools) { const index = eventRounds.get(tool.id); if (index !== undefined && index !== null) indexes.add(index); }
  for (const round of presentation.rounds) indexes.add(round.round_index);
  const blocks = tools.filter(tool => eventRounds.get(tool.id) == null);
  for (const index of [...indexes].sort((a, b) => a - b)) {
    const round = presentation.rounds.find(item => item.round_index === index);
    if (round !== undefined && !(hasFinalMessage && round.kind === 'final')) {
      const id = `round-${attemptId}-${round.round_id}`;
      if (round.reasoning.trim()) blocks.push({ id: `${id}-reasoning`, type: 'reasoning', text: round.reasoning });
      if (round.text.trim()) blocks.push({ id: `${id}-text`, type: 'text', text: round.text });
    }
    blocks.push(...tools.filter(tool => eventRounds.get(tool.id) === index));
  }
  return blocks;
}

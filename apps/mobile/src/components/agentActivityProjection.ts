import type { AgentAttemptPresentation } from '../agent/AgentRoundPresentation';
import type { AgentRoundPreviewState } from '../agent/AgentRoundPreview';
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

/**
 * Blocks for streamed previews of rounds that are not durable yet. A round
 * disappears from here the moment its validated presentation or any of its
 * session events exist, so preview and durable material never show twice.
 */
export function projectRoundPreviews(
  previews: Readonly<Record<string, AgentRoundPreviewState>>,
  attemptId: string,
  events: readonly PersistedSessionEventV3[],
  presentation: AgentAttemptPresentation | undefined,
  labels: { readonly thinking: string },
): StructuredBlock[] {
  // Text and reasoning become durable with the validated presentation; each
  // tool card only when its own call is persisted as a tool event (one by
  // one, as the batch executes). Every piece of the preview yields to its
  // own durable counterpart so nothing shows twice and nothing blinks out
  // before its replacement exists.
  const presentedRounds = new Set<number>();
  if (presentation !== undefined && presentation.attempt_id === attemptId) {
    for (const round of presentation.rounds) presentedRounds.add(round.round_index);
  }
  const durableCalls = new Set<string>();
  for (const event of events) {
    if (event.attempt_id === attemptId && event.round_index !== null && event.round_index !== undefined &&
        (event.kind === 'tool_call' || event.kind === 'tool_result') && event.call_id !== null) {
      durableCalls.add(`${event.round_index}:${event.call_id}`);
    }
  }
  const blocks: StructuredBlock[] = [];
  const rounds = Object.values(previews)
    .filter(preview => preview.correlation.attemptId === attemptId)
    .sort((a, b) => a.correlation.roundIndex - b.correlation.roundIndex);
  for (const preview of rounds) {
    const { roundId, roundIndex } = preview.correlation;
    if (preview.ended?.status === 'failed') continue;
    const id = `preview-${attemptId}-${roundId}`;
    if (!presentedRounds.has(roundIndex)) {
      if (preview.reasoning.trim()) {
        blocks.push({ id: `${id}-reasoning`, type: 'reasoning', text: preview.reasoning });
      } else if (preview.text.trim() === '' && preview.toolCalls.length === 0) {
        blocks.push({ id: `${id}-activity`, type: 'activity', label: labels.thinking });
      }
      if (preview.text.trim()) blocks.push({ id: `${id}-text`, type: 'text', text: preview.text, reveal: true });
    }
    for (const call of preview.toolCalls) {
      if (call.id !== null && durableCalls.has(`${roundIndex}:${call.id}`)) continue;
      blocks.push({
        id: `${id}-call-${call.index}`,
        type: 'tool-call',
        name: call.name ?? '…',
        arguments: call.arguments,
        status: 'pending',
      });
    }
  }
  return blocks;
}

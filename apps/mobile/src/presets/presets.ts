/**
 * Agent presets: a named bundle of the round settings a person reuses.
 *
 * A preset pins the three things that change what a round is -- the model, how
 * hard it thinks, and what it may write -- and nothing else. It deliberately
 * does not carry a system prompt or a tool allowlist: those do not exist as
 * per-conversation settings yet, and a preset that quietly claimed to set them
 * would promise more than the round honours.
 *
 * Everything here is pure. Applying a preset is expressed as the chat actions
 * it would dispatch, so the rule lives in one testable place rather than in
 * whichever screen happens to own a button.
 */
import { isHarnessModelId, type HarnessModelId } from '../harness/types';
import {
  TOOL_PERMISSION_MODES,
  type ToolPermissionMode,
} from '../preferences/types';
import {
  CONVERSATION_THINKING_MODES,
  type ConversationThinkingMode,
} from '../state/types';

/** How many presets are kept. Reaching it refuses rather than evicting. */
export const MAX_AGENT_PRESETS = 50;
export const MAX_PRESET_NAME_LENGTH = 60;
export const MAX_PRESET_ID_LENGTH = 64;

export type AgentPreset = {
  readonly id: string;
  readonly name: string;
  readonly modelId: HarnessModelId;
  readonly thinkingMode: ConversationThinkingMode;
  readonly toolPermission: ToolPermissionMode;
};

const thinkingModes: ReadonlySet<string> = new Set(CONVERSATION_THINKING_MODES);
const toolPermissions: ReadonlySet<string> = new Set(TOOL_PERMISSION_MODES);

export function isConversationThinkingMode(
  value: unknown,
): value is ConversationThinkingMode {
  return typeof value === 'string' && thinkingModes.has(value);
}

export function isPresetToolPermission(
  value: unknown,
): value is ToolPermissionMode {
  return typeof value === 'string' && toolPermissions.has(value);
}

/**
 * A preset id has to be usable as a map key and bounded; names are what a
 * person reads, so they are trimmed and may not be blank or carry control
 * characters that would render as nothing.
 */
export function isPresetId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PRESET_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function isPresetName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_PRESET_NAME_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function isAgentPreset(value: unknown): value is AgentPreset {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length !== 5) return false;
  return (
    isPresetId(raw.id) &&
    isPresetName(raw.name) &&
    isHarnessModelId(raw.modelId) &&
    isConversationThinkingMode(raw.thinkingMode) &&
    isPresetToolPermission(raw.toolPermission)
  );
}

/** A preset, or null when any field is not something the round could honour. */
export function createAgentPreset(input: {
  readonly id: unknown;
  readonly name: unknown;
  readonly modelId: unknown;
  readonly thinkingMode: unknown;
  readonly toolPermission: unknown;
}): AgentPreset | null {
  const candidate = {
    id: input.id,
    name: typeof input.name === 'string' ? input.name.trim() : input.name,
    modelId: input.modelId,
    thinkingMode: input.thinkingMode,
    toolPermission: input.toolPermission,
  };
  return isAgentPreset(candidate) ? (candidate as AgentPreset) : null;
}

export function findAgentPreset(
  presets: readonly AgentPreset[],
  id: string,
): AgentPreset | null {
  return presets.find(preset => preset.id === id) ?? null;
}

/**
 * Adds a preset, or replaces the one with the same id in place.
 *
 * Replacing keeps its position rather than moving it to the end, because a
 * list that reorders itself when a name is corrected is a list nobody can
 * find anything in twice. Adding is refused once the bound is reached.
 */
export function upsertAgentPreset(
  presets: readonly AgentPreset[],
  preset: AgentPreset,
): readonly AgentPreset[] {
  if (!isAgentPreset(preset)) return presets;
  const at = presets.findIndex(existing => existing.id === preset.id);
  if (at >= 0) {
    if (presets[at] === preset) return presets;
    const next = presets.slice();
    next[at] = preset;
    return next;
  }
  if (presets.length >= MAX_AGENT_PRESETS) return presets;
  return [...presets, preset];
}

export function removeAgentPreset(
  presets: readonly AgentPreset[],
  id: string,
): readonly AgentPreset[] {
  const next = presets.filter(preset => preset.id !== id);
  return next.length === presets.length ? presets : next;
}

export function renameAgentPreset(
  presets: readonly AgentPreset[],
  id: string,
  name: string,
): readonly AgentPreset[] {
  const existing = findAgentPreset(presets, id);
  if (existing === null || !isPresetName(name)) return presets;
  const trimmed = name.trim();
  if (existing.name === trimmed) return presets;
  return upsertAgentPreset(presets, { ...existing, name: trimmed });
}

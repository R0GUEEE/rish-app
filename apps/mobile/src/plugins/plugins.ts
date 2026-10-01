/**
 * Plugins: capability packs a person adds, and the tools they offer the Agent.
 *
 * A plugin is a declaration, not a binary. On iOS nothing loads third-party
 * executable code into the app, and the Agent's tool table is frozen in the
 * native core -- its canonical bytes are the `toolset_sha256` every stored
 * authority is bound to. So a plugin says which tools it would offer and which
 * existing capability each one needs; this app records, validates and shows
 * that, and the native registry has to admit the declarations before the model
 * can be told the calls exist. `pluginToolPosture` is what the manager reads to
 * say which of those two states it is in, so the screen never shows a switch
 * that quietly does nothing.
 *
 * Everything here is pure: adding, removing and enabling are expressed as the
 * list they would produce, so the rules live in one testable place rather than
 * in whichever sheet owns a button.
 */
import { ALL_AGENT_TOOL_NAMES } from '../agent/tool-registry';

/** How many plugins are kept. Reaching it refuses rather than evicting. */
export const MAX_PLUGINS = 25;
/** How many tools one plugin may declare. */
export const MAX_PLUGIN_TOOLS = 16;
/**
 * Ids and tool names are bounded on their own, and the name the provider sees
 * -- `id__tool` -- is bounded by the 64 character function-name budget, which
 * is the rule that actually has to hold.
 */
export const MAX_PLUGIN_ID_LENGTH = 40;
export const MAX_PLUGIN_TOOL_NAME_LENGTH = 40;
export const MAX_PLUGIN_NAME_LENGTH = 60;
export const MAX_PLUGIN_VERSION_LENGTH = 32;
export const MAX_PLUGIN_DESCRIPTION_LENGTH = 512;
/**
 * A tool description travels to the provider inside the request, and that
 * transport limit is 1,024 characters: a longer guest-CGI description once
 * rejected every Agent request before dispatch.
 */
export const MAX_PLUGIN_TOOL_DESCRIPTION_LENGTH = 1024;
/** The provider-facing function-name budget. */
export const MAX_OFFERED_TOOL_NAME_LENGTH = 64;
/**
 * The registry version whose tool table would admit plugin tools.
 *
 * The Agent's current table is v3 (runtime environments) and does not. The
 * manager compares against this so that a person is told the truth about
 * whether their plugins can reach the Agent yet.
 */
export const PLUGIN_TOOL_REGISTRY_VERSION = 4;
/** The separator between a plugin id and one of its tool names. */
export const PLUGIN_TOOL_SEPARATOR = '__';

/**
 * What a plugin tool could need, mirroring the native core's capability list.
 *
 * A plugin may only ask for something the Agent already knows how to check:
 * inventing a capability here would describe a permission nothing enforces.
 */
export const PLUGIN_CAPABILITIES = [
  'file_read',
  'file_write',
  'git_status',
  'git_commit',
  'git_push',
  'guest_service',
] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export type PluginTool = {
  /** The bare name, unique inside its plugin. */
  readonly name: string;
  readonly description: string;
  readonly capability: PluginCapability;
  /** True when a call would have to be confirmed before it runs. */
  readonly requiresApproval: boolean;
};

export type Plugin = {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly tools: readonly PluginTool[];
};

const PLUGIN_IDENTIFIER = /^[a-z][a-z0-9_]*$/u;
const capabilities: ReadonlySet<string> = new Set(PLUGIN_CAPABILITIES);
const builtinToolNames: ReadonlySet<string> = new Set(ALL_AGENT_TOOL_NAMES);

function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function isPluginId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_PLUGIN_ID_LENGTH &&
    PLUGIN_IDENTIFIER.test(value)
  );
}

export function isPluginName(value: unknown): value is string {
  return boundedText(value, MAX_PLUGIN_NAME_LENGTH);
}

export function isPluginVersion(value: unknown): value is string {
  return boundedText(value, MAX_PLUGIN_VERSION_LENGTH);
}

export function isPluginDescription(value: unknown): value is string {
  return boundedText(value, MAX_PLUGIN_DESCRIPTION_LENGTH);
}

export function isPluginCapability(value: unknown): value is PluginCapability {
  return typeof value === 'string' && capabilities.has(value);
}

/**
 * Whether a bare tool name may be declared.
 *
 * It may not shadow a tool the app already offers -- two tools with one name
 * is a call nobody can attribute -- and the name it is offered under has to
 * fit the provider's function-name budget, which `isOfferedToolName` checks
 * for the pair rather than for the name alone.
 */
export function isPluginToolName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_PLUGIN_TOOL_NAME_LENGTH &&
    PLUGIN_IDENTIFIER.test(value) &&
    !builtinToolNames.has(value)
  );
}

export function isPluginToolDescription(value: unknown): value is string {
  return boundedText(value, MAX_PLUGIN_TOOL_DESCRIPTION_LENGTH);
}

export function isPluginTool(value: unknown): value is PluginTool {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 4) return false;
  return (
    isPluginToolName(raw.name) &&
    isPluginToolDescription(raw.description) &&
    isPluginCapability(raw.capability) &&
    typeof raw.requiresApproval === 'boolean'
  );
}

export function isPlugin(value: unknown): value is Plugin {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 6) return false;
  if (
    !isPluginId(raw.id) ||
    !isPluginName(raw.name) ||
    !isPluginVersion(raw.version) ||
    !isPluginDescription(raw.description) ||
    typeof raw.enabled !== 'boolean' ||
    !Array.isArray(raw.tools) ||
    raw.tools.length > MAX_PLUGIN_TOOLS
  ) {
    return false;
  }
  const names = new Set<string>();
  for (const tool of raw.tools) {
    if (!isPluginTool(tool)) return false;
    if (names.has(tool.name)) return false;
    names.add(tool.name);
  }
  return true;
}

/**
 * The name the provider would see for one plugin tool.
 *
 * Namespaced so that two plugins may both declare `fetch`, and so that a
 * plugin can never be mistaken for a tool the app itself offers. A pair whose
 * result would not fit the provider's budget is refused when a plugin is
 * created or loaded, not silently truncated.
 */
export function pluginToolName(pluginId: string, toolName: string): string {
  return `${pluginId}${PLUGIN_TOOL_SEPARATOR}${toolName}`;
}

/** Whether the offered name would fit a provider request. */
export function isOfferedToolName(value: string): boolean {
  return (
    value.length <= MAX_OFFERED_TOOL_NAME_LENGTH &&
    /^[a-z0-9_]+$/u.test(value)
  );
}

export function createPlugin(input: {
  readonly id: unknown;
  readonly name: unknown;
  readonly version: unknown;
  readonly description: unknown;
  readonly enabled?: unknown;
  readonly tools: unknown;
}): Plugin | null {
  const candidate = {
    id: input.id,
    name: typeof input.name === 'string' ? input.name.trim() : input.name,
    version:
      typeof input.version === 'string' ? input.version.trim() : input.version,
    description:
      typeof input.description === 'string'
        ? input.description.trim()
        : input.description,
    enabled: input.enabled === undefined ? true : input.enabled,
    tools: input.tools,
  };
  if (!isPlugin(candidate)) return null;
  const tools = candidate.tools as readonly PluginTool[];
  return tools.some(tool => !isOfferedToolName(pluginToolName(candidate.id, tool.name)))
    ? null
    : (candidate as Plugin);
}

/** The whole list, or null when any entry is not a plugin the app could keep. */
export function normalizePlugins(value: unknown): readonly Plugin[] | null {
  if (!Array.isArray(value) || value.length > MAX_PLUGINS) return null;
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isPlugin(entry)) return null;
    if (ids.has(entry.id)) return null;
    ids.add(entry.id);
    for (const tool of entry.tools) {
      if (!isOfferedToolName(pluginToolName(entry.id, tool.name))) return null;
    }
  }
  return value as readonly Plugin[];
}

export function findPlugin(
  plugins: readonly Plugin[],
  id: string,
): Plugin | null {
  return plugins.find(plugin => plugin.id === id) ?? null;
}

/**
 * Adds a plugin, or replaces the one with the same id in place.
 *
 * Replacing keeps its position: a list that reorders itself when a version is
 * corrected is a list nobody can find anything in. A new plugin is refused
 * once the bound is reached rather than evicting someone's work.
 */
export function upsertPlugin(
  plugins: readonly Plugin[],
  plugin: Plugin,
): readonly Plugin[] {
  if (!isPlugin(plugin)) return plugins;
  const at = plugins.findIndex(entry => entry.id === plugin.id);
  if (at === -1) {
    return plugins.length >= MAX_PLUGINS ? plugins : [...plugins, plugin];
  }
  if (plugins[at] === plugin) return plugins;
  const next = [...plugins];
  next[at] = plugin;
  return next;
}

export function removePlugin(
  plugins: readonly Plugin[],
  id: string,
): readonly Plugin[] {
  const next = plugins.filter(plugin => plugin.id !== id);
  return next.length === plugins.length ? plugins : next;
}

/** Enables or disables one plugin; an unknown id changes nothing. */
export function setPluginEnabled(
  plugins: readonly Plugin[],
  id: string,
  enabled: boolean,
): readonly Plugin[] {
  const at = plugins.findIndex(plugin => plugin.id === id);
  if (at === -1 || plugins[at]!.enabled === enabled) return plugins;
  const next = [...plugins];
  next[at] = { ...plugins[at]!, enabled };
  return next;
}

export type PluginToolOffer = {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly offeredName: string;
  readonly tool: PluginTool;
};

/**
 * Every tool the enabled plugins would offer the Agent.
 *
 * Disabled plugins contribute nothing, which is the whole point of the switch:
 * an enabled plugin's tools are the ones a round would advertise.
 */
export function pluginToolOffers(
  plugins: readonly Plugin[],
): readonly PluginToolOffer[] {
  const offers: PluginToolOffer[] = [];
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    for (const tool of plugin.tools) {
      offers.push({
        pluginId: plugin.id,
        pluginName: plugin.name,
        offeredName: pluginToolName(plugin.id, tool.name),
        tool,
      });
    }
  }
  return offers;
}

/** The capabilities the enabled plugins would ask the Agent to check. */
export function pluginToolCapabilities(
  plugins: readonly Plugin[],
): readonly PluginCapability[] {
  const seen = new Set<PluginCapability>();
  for (const offer of pluginToolOffers(plugins)) seen.add(offer.tool.capability);
  return PLUGIN_CAPABILITIES.filter(capability => seen.has(capability));
}

export type PluginToolPosture = 'admitted' | 'awaiting_native' | 'unknown';

/**
 * Whether the Agent's tool table can carry plugin tools yet.
 *
 * `unknown` is the honest answer when the policy has not been read, because a
 * manager that claimed either state without asking would be guessing.
 */
export function pluginToolPosture(
  nativeRegistryVersion: number | null,
): PluginToolPosture {
  if (nativeRegistryVersion === null) return 'unknown';
  return nativeRegistryVersion >= PLUGIN_TOOL_REGISTRY_VERSION
    ? 'admitted'
    : 'awaiting_native';
}

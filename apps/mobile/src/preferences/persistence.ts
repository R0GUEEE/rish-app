import {
  APP_PREFERENCES_SCHEMA_VERSION,
  PreferencesValidationError,
  type AppPreferences,
  type MessageFeedbackPreferences,
  type MessageFeedbackRating,
  type PersistedAppPreferencesV1,
  type PreferencesHydrationResult,
} from './types';
import {
  createDefaultPreferences,
  isDefaultModelId,
  isFeedbackMessageId,
  isHarnessId,
  isLocalePreference,
  isMessageFeedbackRating,
  isMirrorCategory,
  isPinnedConversationId,
  isThemeMode,
  isThinkingMode,
  isToolPermissionMode,
  normalizeAgentPresets,
  normalizeMirrorBaseUrl,
} from './reducer';
import { normalizePlugins } from '../plugins/plugins';
import { normalizeSkills } from '../skills';
import { normalizeGitHttpsProxyUrl } from './gitProxy';
import {
  MAX_MESSAGE_FEEDBACK_ENTRIES,
  MAX_PINNED_CONVERSATIONS,
  type PinnedConversationPreferences,
} from './types';

type UnknownRecord = Record<string, unknown>;

const persistedKeys: ReadonlySet<string> = new Set([
  'schema_version',
  'theme_mode',
  'locale',
  'default_model',
  'selected_harness_id',
  'thinking_mode',
  'tool_permission',
  'show_reasoning',
  'auto_expand_tools',
  'confirm_destructive_file_actions',
  'git_https_proxy_url',
  'mirrors',
  'message_feedback',
  'pinned_conversations',
  'agent_presets',
  'plugins',
  'skills',
]);

function invalid(path: string, message: string): never {
  throw new PreferencesValidationError(path, message);
}

function record(value: unknown): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('$', 'must be an object');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return invalid('$', 'must not contain symbol properties');
  }
  const raw = value as UnknownRecord;
  const unknownKey = Object.keys(raw).find(key => !persistedKeys.has(key));
  if (unknownKey !== undefined) {
    return invalid(`$.${unknownKey}`, 'is not a recognized preference');
  }
  return raw;
}

function required(raw: UnknownRecord, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(raw, key)) {
    return invalid(`$.${key}`, 'is required');
  }
  return raw[key];
}

function boolean(raw: UnknownRecord, key: string): boolean {
  const value = required(raw, key);
  if (typeof value !== 'boolean') {
    return invalid(`$.${key}`, 'must be a boolean');
  }
  return value;
}

function decodeMirrors(value: unknown): AppPreferences['mirrors'] {
  if (value === undefined) {
    return createDefaultPreferences().mirrors;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('$.mirrors', 'must be an object');
  }
  const raw = value as UnknownRecord;
  const keys = Object.keys(raw);
  if (keys.length !== 3 || keys.some(key => !isMirrorCategory(key))) {
    return invalid('$.mirrors', 'must contain alpine, pip, and npm');
  }
  const decodeMirror = (category: 'alpine' | 'pip' | 'npm') => {
    const entry = raw[category];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return invalid(`$.mirrors.${category}`, 'must be an object');
    }
    const mirror = entry as UnknownRecord;
    if (typeof mirror.enabled !== 'boolean') {
      return invalid(`$.mirrors.${category}.enabled`, 'must be a boolean');
    }
    const baseUrl = normalizeMirrorBaseUrl(mirror.base_url);
    if (baseUrl === null) {
      return invalid(
        `$.mirrors.${category}.base_url`,
        'must be a safe HTTPS base URL',
      );
    }
    return { enabled: mirror.enabled, baseUrl };
  };
  return {
    alpine: decodeMirror('alpine'),
    pip: decodeMirror('pip'),
    npm: decodeMirror('npm'),
  };
}

function decode(input: unknown): unknown {
  if (typeof input !== 'string') {
    return input;
  }
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return invalid('$', 'must be valid JSON');
  }
}

function decodeGitHttpsProxyUrl(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = normalizeGitHttpsProxyUrl(value);
  if (normalized === null) {
    return invalid(
      '$.git_https_proxy_url',
      'must be null or a safe HTTP(S) proxy URL with an explicit port',
    );
  }
  return normalized;
}

/**
 * Ratings by message id.
 *
 * Absent is the ordinary case for a state written before this existed, so it
 * hydrates to empty rather than failing. Everything else is checked: a rating
 * is only ever one of the two known values, keyed by something that could be
 * a message id, and bounded so a hand-edited blob cannot make it unbounded.
 */
function decodeMessageFeedback(value: unknown): MessageFeedbackPreferences {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    return invalid('$.message_feedback', 'must be an object');
  }
  const raw = value as UnknownRecord;
  const keys = Object.keys(raw);
  if (keys.length > MAX_MESSAGE_FEEDBACK_ENTRIES) {
    return invalid(
      '$.message_feedback',
      `must hold at most ${MAX_MESSAGE_FEEDBACK_ENTRIES} ratings`,
    );
  }
  const feedback: Record<string, MessageFeedbackRating> = {};
  for (const key of keys) {
    if (!isFeedbackMessageId(key)) {
      return invalid(
        `$.message_feedback.${key}`,
        'must be keyed by a bounded printable message id',
      );
    }
    const rating = raw[key];
    if (!isMessageFeedbackRating(rating)) {
      return invalid(
        `$.message_feedback.${key}`,
        'must be up or down',
      );
    }
    feedback[key] = rating;
  }
  return feedback;
}

/**
 * The pinned conversations.
 *
 * Absent is the ordinary case for a state written before pinning existed, so
 * it hydrates to empty rather than failing. Anything present is held to the
 * same rule the reducer enforces — bounded, and each entry one conversation —
 * as a whole list, because a pin silently dropped on load is a shelf a person
 * arranged and the app quietly rearranged. Duplicate ids are refused for the
 * same reason: one conversation cannot be pinned twice.
 */
function decodePinnedConversations(
  value: unknown,
): PinnedConversationPreferences {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    return invalid(
      '$.pinned_conversations',
      'must be a list of conversation ids',
    );
  }
  if (value.length > MAX_PINNED_CONVERSATIONS) {
    return invalid(
      '$.pinned_conversations',
      `must hold at most ${MAX_PINNED_CONVERSATIONS} conversations`,
    );
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isPinnedConversationId(entry)) {
      return invalid(
        '$.pinned_conversations',
        'must hold bounded printable conversation ids',
      );
    }
    if (seen.has(entry)) {
      return invalid(
        '$.pinned_conversations',
        'must not repeat a conversation',
      );
    }
    seen.add(entry);
  }
  return value as PinnedConversationPreferences;
}

/**
 * The saved presets.
 *
 * Absent is the ordinary case for a state written before presets existed, so
 * it hydrates to empty rather than failing. Anything present is held to the
 * same rule the store applies: a bounded list of complete, uniquely named
 * presets, or the whole state is refused rather than partly read.
 */
function decodeAgentPresets(
  value: unknown,
): AppPreferences['agentPresets'] {
  if (value === undefined || value === null) return [];
  const presets = normalizeAgentPresets(value);
  if (presets === null) {
    return invalid(
      '$.agent_presets',
      'must be a bounded list of complete presets with unique ids',
    );
  }
  return presets;
}

/**
 * The saved plugins.
 *
 * Absent is the ordinary case for a state written before plugins existed, so
 * it hydrates to none rather than failing. Anything present is held to the
 * same rule the store applies -- a bounded list of complete, uniquely
 * identified plugins -- as a whole, because a plugin silently dropped on load
 * is a set of tools a person believes the Agent can call.
 */
function decodePlugins(value: unknown): AppPreferences['plugins'] {
  if (value === undefined || value === null) return [];
  const plugins = normalizePlugins(value);
  if (plugins === null) {
    return invalid(
      '$.plugins',
      'must be a bounded list of complete plugins with unique ids',
    );
  }
  return plugins;
}

/**
 * The saved skills.
 *
 * Absent is the ordinary case for a state written before skills existed, so it
 * hydrates to none rather than failing, and anything present is held to the
 * bound and the identifier rules the library applies.
 */
function decodeSkills(value: unknown): AppPreferences['skills'] {
  if (value === undefined || value === null) return [];
  const skills = normalizeSkills(value);
  if (skills === null) {
    return invalid(
      '$.skills',
      'must be a bounded list of complete skills with unique ids',
    );
  }
  return skills;
}

export function hydrateAppPreferences(input: unknown): AppPreferences {  const raw = record(decode(input));
  if (required(raw, 'schema_version') !== APP_PREFERENCES_SCHEMA_VERSION) {
    return invalid(
      '$.schema_version',
      `must equal ${APP_PREFERENCES_SCHEMA_VERSION}`,
    );
  }

  const themeMode = required(raw, 'theme_mode');
  if (!isThemeMode(themeMode)) {
    return invalid('$.theme_mode', 'must be system, light, or dark');
  }
  const locale = required(raw, 'locale');
  if (!isLocalePreference(locale)) {
    return invalid('$.locale', 'must be system, zh-CN, or en-US');
  }
  const defaultModel = required(raw, 'default_model');
  if (!isDefaultModelId(defaultModel)) {
    return invalid('$.default_model', 'is not a supported model');
  }
  const selectedHarnessId =
    raw.selected_harness_id === undefined ? 'dsh' : raw.selected_harness_id;
  if (!isHarnessId(selectedHarnessId)) {
    return invalid('$.selected_harness_id', 'is not a valid harness id');
  }
  const thinkingMode = required(raw, 'thinking_mode');
  if (!isThinkingMode(thinkingMode)) {
    return invalid('$.thinking_mode', 'must be off, high, or max');
  }
  const toolPermission = required(raw, 'tool_permission');
  if (!isToolPermissionMode(toolPermission)) {
    return invalid('$.tool_permission', 'must be read-only or workspace-write');
  }

  return {
    schemaVersion: APP_PREFERENCES_SCHEMA_VERSION,
    themeMode,
    locale,
    defaultModel,
    selectedHarnessId,
    thinkingMode,
    toolPermission,
    showReasoning: boolean(raw, 'show_reasoning'),
    autoExpandTools: boolean(raw, 'auto_expand_tools'),
    confirmDestructiveFileActions: boolean(
      raw,
      'confirm_destructive_file_actions',
    ),
    gitHttpsProxyUrl: decodeGitHttpsProxyUrl(raw.git_https_proxy_url),
    mirrors: decodeMirrors(raw.mirrors),
    messageFeedback: decodeMessageFeedback(raw.message_feedback),
    pinnedConversations: decodePinnedConversations(raw.pinned_conversations),
    agentPresets: decodeAgentPresets(raw.agent_presets),
    plugins: decodePlugins(raw.plugins),
    skills: decodeSkills(raw.skills),
  };
}

export function safeHydrateAppPreferences(
  input: unknown,
): PreferencesHydrationResult {
  try {
    return { ok: true, preferences: hydrateAppPreferences(input) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof PreferencesValidationError
          ? error
          : new PreferencesValidationError(
              '$',
              'could not hydrate preferences',
            ),
    };
  }
}

export function serializeAppPreferences(preferences: AppPreferences): string {
  const persisted: PersistedAppPreferencesV1 = {
    schema_version: APP_PREFERENCES_SCHEMA_VERSION,
    theme_mode: preferences.themeMode,
    locale: preferences.locale,
    default_model: preferences.defaultModel,
    selected_harness_id: preferences.selectedHarnessId,
    thinking_mode: preferences.thinkingMode,
    tool_permission: preferences.toolPermission,
    show_reasoning: preferences.showReasoning,
    auto_expand_tools: preferences.autoExpandTools,
    confirm_destructive_file_actions: preferences.confirmDestructiveFileActions,
    git_https_proxy_url: preferences.gitHttpsProxyUrl,
    mirrors: {
      alpine: {
        enabled: preferences.mirrors.alpine.enabled,
        base_url: preferences.mirrors.alpine.baseUrl,
      },
      pip: {
        enabled: preferences.mirrors.pip.enabled,
        base_url: preferences.mirrors.pip.baseUrl,
      },
      npm: {
        enabled: preferences.mirrors.npm.enabled,
        base_url: preferences.mirrors.npm.baseUrl,
      },
    },
    message_feedback: preferences.messageFeedback,
    pinned_conversations: preferences.pinnedConversations,
    agent_presets: preferences.agentPresets,
    plugins: preferences.plugins,
    skills: preferences.skills,
  };
  hydrateAppPreferences(persisted);
  return JSON.stringify(persisted);
}

import {
  APP_PREFERENCES_SCHEMA_VERSION,
  PreferencesValidationError,
  type AppPreferences,
  type PersistedAppPreferencesV1,
  type PreferencesHydrationResult,
} from './types';
import {
  createDefaultPreferences,
  isDefaultModelId,
  isHarnessId,
  isLocalePreference,
  isMirrorCategory,
  isThemeMode,
  isThinkingMode,
  isToolPermissionMode,
  normalizeMirrorBaseUrl,
} from './reducer';
import { normalizeGitHttpsProxyUrl } from './gitProxy';

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

export function hydrateAppPreferences(input: unknown): AppPreferences {
  const raw = record(decode(input));
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
  };
  hydrateAppPreferences(persisted);
  return JSON.stringify(persisted);
}

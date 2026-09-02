import {
  APP_PREFERENCES_SCHEMA_VERSION,
  DEFAULT_MODEL_IDS,
  LOCALE_PREFERENCES,
  MIRROR_CATEGORIES,
  THEME_MODES,
  THINKING_MODES,
  TOOL_PERMISSION_MODES,
  type AppPreferences,
  type DefaultModelId,
  type LocalePreference,
  type MirrorCategory,
  type MirrorPreferences,
  type PreferencesAction,
  type ThemeMode,
  type ThinkingMode,
  type ToolPermissionMode,
} from './types';
import { normalizeGitHttpsProxyUrl } from './gitProxy';

export { isGitHttpsProxyUrl, normalizeGitHttpsProxyUrl } from './gitProxy';

export const DEFAULT_MIRROR_URLS: Readonly<Record<MirrorCategory, string>> = {
  alpine: 'https://dl-cdn.alpinelinux.org/alpine/',
  pip: 'https://pypi.org/simple/',
  npm: 'https://registry.npmjs.org/',
};

export const DEFAULT_MIRROR_PREFERENCES: MirrorPreferences = {
  alpine: { enabled: false, baseUrl: DEFAULT_MIRROR_URLS.alpine },
  pip: { enabled: false, baseUrl: DEFAULT_MIRROR_URLS.pip },
  npm: { enabled: false, baseUrl: DEFAULT_MIRROR_URLS.npm },
};

export const DEFAULT_APP_PREFERENCES: AppPreferences = Object.freeze({
  schemaVersion: APP_PREFERENCES_SCHEMA_VERSION,
  themeMode: 'system',
  locale: 'system',
  defaultModel: 'deepseek-v4-flash',
  selectedHarnessId: 'dsh',
  thinkingMode: 'high',
  toolPermission: 'workspace-write',
  showReasoning: false,
  autoExpandTools: false,
  confirmDestructiveFileActions: true,
  gitHttpsProxyUrl: null,
  mirrors: DEFAULT_MIRROR_PREFERENCES,
});

const themes: ReadonlySet<string> = new Set(THEME_MODES);
const locales: ReadonlySet<string> = new Set(LOCALE_PREFERENCES);
const models: ReadonlySet<string> = new Set(DEFAULT_MODEL_IDS);
const thinkingModes: ReadonlySet<string> = new Set(THINKING_MODES);
const toolPermissionModes: ReadonlySet<string> = new Set(TOOL_PERMISSION_MODES);
const mirrorCategories: ReadonlySet<string> = new Set(MIRROR_CATEGORIES);

export function createDefaultPreferences(): AppPreferences {
  return {
    ...DEFAULT_APP_PREFERENCES,
    mirrors: {
      alpine: { ...DEFAULT_MIRROR_PREFERENCES.alpine },
      pip: { ...DEFAULT_MIRROR_PREFERENCES.pip },
      npm: { ...DEFAULT_MIRROR_PREFERENCES.npm },
    },
  };
}

export function isMirrorCategory(value: unknown): value is MirrorCategory {
  return typeof value === 'string' && mirrorCategories.has(value);
}

export function normalizeMirrorBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return null;
    }
    const normalized = parsed.toString();
    return normalized.endsWith('/') ? normalized : `${normalized}/`;
  } catch {
    return null;
  }
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && themes.has(value);
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return typeof value === 'string' && locales.has(value);
}

export function isDefaultModelId(value: unknown): value is DefaultModelId {
  return typeof value === 'string' && models.has(value);
}

export function isHarnessId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(value)
  );
}

export function isThinkingMode(value: unknown): value is ThinkingMode {
  return typeof value === 'string' && thinkingModes.has(value);
}

export function isToolPermissionMode(
  value: unknown,
): value is ToolPermissionMode {
  return typeof value === 'string' && toolPermissionModes.has(value);
}

function setPreference<Key extends keyof AppPreferences>(
  preferences: AppPreferences,
  key: Key,
  value: AppPreferences[Key],
): AppPreferences {
  return preferences[key] === value
    ? preferences
    : { ...preferences, [key]: value };
}

export function preferencesReducer(
  preferences: AppPreferences,
  action: PreferencesAction,
): AppPreferences {
  switch (action.type) {
    case 'preferences/set-theme':
      return isThemeMode(action.payload.themeMode)
        ? setPreference(preferences, 'themeMode', action.payload.themeMode)
        : preferences;
    case 'preferences/set-locale':
      return isLocalePreference(action.payload.locale)
        ? setPreference(preferences, 'locale', action.payload.locale)
        : preferences;
    case 'preferences/set-default-model':
      return isDefaultModelId(action.payload.defaultModel)
        ? setPreference(
            preferences,
            'defaultModel',
            action.payload.defaultModel,
          )
        : preferences;
    case 'preferences/set-selected-harness':
      return isHarnessId(action.payload.harnessId)
        ? setPreference(
            preferences,
            'selectedHarnessId',
            action.payload.harnessId,
          )
        : preferences;
    case 'preferences/set-thinking-mode':
      return isThinkingMode(action.payload.thinkingMode)
        ? setPreference(
            preferences,
            'thinkingMode',
            action.payload.thinkingMode,
          )
        : preferences;
    case 'preferences/set-tool-permission':
      return isToolPermissionMode(action.payload.toolPermission)
        ? setPreference(
            preferences,
            'toolPermission',
            action.payload.toolPermission,
          )
        : preferences;
    case 'preferences/set-show-reasoning':
      return typeof action.payload.showReasoning === 'boolean'
        ? setPreference(
            preferences,
            'showReasoning',
            action.payload.showReasoning,
          )
        : preferences;
    case 'preferences/set-auto-expand-tools':
      return typeof action.payload.autoExpandTools === 'boolean'
        ? setPreference(
            preferences,
            'autoExpandTools',
            action.payload.autoExpandTools,
          )
        : preferences;
    case 'preferences/set-confirm-destructive-file-actions':
      return typeof action.payload.confirm === 'boolean'
        ? setPreference(
            preferences,
            'confirmDestructiveFileActions',
            action.payload.confirm,
          )
        : preferences;
    case 'preferences/set-git-https-proxy-url': {
      const candidate = action.payload.gitHttpsProxyUrl;
      const normalized =
        candidate === null ? null : normalizeGitHttpsProxyUrl(candidate);
      return candidate === null || normalized !== null
        ? setPreference(preferences, 'gitHttpsProxyUrl', normalized)
        : preferences;
    }
    case 'preferences/set-mirror': {
      const { category, enabled, baseUrl } = action.payload;
      const normalized = normalizeMirrorBaseUrl(baseUrl);
      if (
        !isMirrorCategory(category) ||
        typeof enabled !== 'boolean' ||
        normalized === null
      ) {
        return preferences;
      }
      const current = preferences.mirrors[category];
      if (current.enabled === enabled && current.baseUrl === normalized) {
        return preferences;
      }
      return {
        ...preferences,
        mirrors: {
          ...preferences.mirrors,
          [category]: { enabled, baseUrl: normalized },
        },
      };
    }
    case 'preferences/reset': {
      const defaults = DEFAULT_APP_PREFERENCES;
      const alreadyDefault = (
        Object.keys(defaults) as Array<keyof AppPreferences>
      ).every(key =>
        key === 'mirrors'
          ? MIRROR_CATEGORIES.every(
              category =>
                preferences.mirrors[category].enabled ===
                  defaults.mirrors[category].enabled &&
                preferences.mirrors[category].baseUrl ===
                  defaults.mirrors[category].baseUrl,
            )
          : preferences[key] === defaults[key],
      );
      return alreadyDefault ? preferences : createDefaultPreferences();
    }
  }
}

export const selectThemeMode = (preferences: AppPreferences): ThemeMode =>
  preferences.themeMode;

export const selectLocalePreference = (
  preferences: AppPreferences,
): LocalePreference => preferences.locale;

export const selectDefaultModel = (
  preferences: AppPreferences,
): DefaultModelId => preferences.defaultModel;

export const selectThinkingMode = (preferences: AppPreferences): ThinkingMode =>
  preferences.thinkingMode;

export const selectToolPermission = (
  preferences: AppPreferences,
): ToolPermissionMode => preferences.toolPermission;

export const selectShowReasoning = (preferences: AppPreferences): boolean =>
  preferences.showReasoning;

export const selectAutoExpandTools = (preferences: AppPreferences): boolean =>
  preferences.autoExpandTools;

export const selectConfirmDestructiveFileActions = (
  preferences: AppPreferences,
): boolean => preferences.confirmDestructiveFileActions;

export const selectGitHttpsProxyUrl = (
  preferences: AppPreferences,
): string | null => preferences.gitHttpsProxyUrl;

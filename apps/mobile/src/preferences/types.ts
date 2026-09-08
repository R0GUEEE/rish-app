export const APP_PREFERENCES_SCHEMA_VERSION = 1 as const;

export const THEME_MODES = ['system', 'light', 'dark'] as const;
export const LOCALE_PREFERENCES = ['system', 'zh-CN', 'en-US'] as const;
export const RESOLVED_LOCALES = ['zh-CN', 'en-US'] as const;
export const DEFAULT_MODEL_IDS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash-vision-exp',
] as const;
export const THINKING_MODES = ['off', 'high', 'max'] as const;
export const TOOL_PERMISSION_MODES = ['read-only', 'workspace-write'] as const;
export const MIRROR_CATEGORIES = ['alpine', 'pip', 'npm'] as const;

export type ThemeMode = (typeof THEME_MODES)[number];
export type ResolvedTheme = Exclude<ThemeMode, 'system'>;
export type LocalePreference = (typeof LOCALE_PREFERENCES)[number];
export type ResolvedLocale = (typeof RESOLVED_LOCALES)[number];
export type DefaultModelId = import("../harness/types").DeepSeekModelId;
export type ThinkingMode = (typeof THINKING_MODES)[number];
export type ToolPermissionMode = (typeof TOOL_PERMISSION_MODES)[number];
export type MirrorCategory = (typeof MIRROR_CATEGORIES)[number];
export type MirrorPreference = {
  readonly enabled: boolean;
  readonly baseUrl: string;
};
export type MirrorPreferences = Readonly<
  Record<MirrorCategory, MirrorPreference>
>;

export type AppPreferences = {
  readonly schemaVersion: typeof APP_PREFERENCES_SCHEMA_VERSION;
  readonly themeMode: ThemeMode;
  readonly locale: LocalePreference;
  readonly defaultModel: DefaultModelId;
  readonly selectedHarnessId: string;
  readonly thinkingMode: ThinkingMode;
  readonly toolPermission: ToolPermissionMode;
  readonly showReasoning: boolean;
  readonly autoExpandTools: boolean;
  readonly confirmDestructiveFileActions: boolean;
  readonly gitHttpsProxyUrl: string | null;
  readonly mirrors: MirrorPreferences;
};

export type PersistedAppPreferencesV1 = {
  readonly schema_version: typeof APP_PREFERENCES_SCHEMA_VERSION;
  readonly theme_mode: ThemeMode;
  readonly locale: LocalePreference;
  readonly default_model: DefaultModelId;
  readonly selected_harness_id?: string;
  readonly thinking_mode: ThinkingMode;
  readonly tool_permission: ToolPermissionMode;
  readonly show_reasoning: boolean;
  readonly auto_expand_tools: boolean;
  readonly confirm_destructive_file_actions: boolean;
  readonly git_https_proxy_url?: string | null;
  readonly mirrors?: Readonly<
    Record<
      MirrorCategory,
      { readonly enabled: boolean; readonly base_url: string }
    >
  >;
};

export type PreferencesAction =
  | {
      readonly type: 'preferences/set-theme';
      readonly payload: { readonly themeMode: ThemeMode };
    }
  | {
      readonly type: 'preferences/set-locale';
      readonly payload: { readonly locale: LocalePreference };
    }
  | {
      readonly type: 'preferences/set-default-model';
      readonly payload: { readonly defaultModel: DefaultModelId };
    }
  | {
      readonly type: 'preferences/set-selected-harness';
      readonly payload: { readonly harnessId: string };
    }
  | {
      readonly type: 'preferences/set-thinking-mode';
      readonly payload: { readonly thinkingMode: ThinkingMode };
    }
  | {
      readonly type: 'preferences/set-tool-permission';
      readonly payload: { readonly toolPermission: ToolPermissionMode };
    }
  | {
      readonly type: 'preferences/set-show-reasoning';
      readonly payload: { readonly showReasoning: boolean };
    }
  | {
      readonly type: 'preferences/set-auto-expand-tools';
      readonly payload: { readonly autoExpandTools: boolean };
    }
  | {
      readonly type: 'preferences/set-confirm-destructive-file-actions';
      readonly payload: { readonly confirm: boolean };
    }
  | {
      readonly type: 'preferences/set-git-https-proxy-url';
      readonly payload: { readonly gitHttpsProxyUrl: string | null };
    }
  | {
      readonly type: 'preferences/set-mirror';
      readonly payload: {
        readonly category: MirrorCategory;
        readonly enabled: boolean;
        readonly baseUrl: string;
      };
    }
  | { readonly type: 'preferences/reset' };

export type PreferencesHydrationResult =
  | { readonly ok: true; readonly preferences: AppPreferences }
  | { readonly ok: false; readonly error: PreferencesValidationError };

export class PreferencesValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'PreferencesValidationError';
    this.path = path;
  }
}

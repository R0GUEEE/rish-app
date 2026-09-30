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
/** The most presets that are kept; see `MAX_AGENT_PRESETS` for the rule. */
export const MAX_PERSISTED_AGENT_PRESETS = 50 as const;
export type AgentPresetPreferences = readonly import('../presets/presets').AgentPreset[];
/** The ratings a person can leave on an assistant message. */
export const MESSAGE_FEEDBACK_RATINGS = ['up', 'down'] as const;
/**
 * How many ratings are kept. Feedback is stored apart from the chat state so
 * it needs no schema migration, which means nothing else prunes it: this bound
 * is what keeps the preference blob from growing for the life of the install.
 * The oldest rating is dropped first.
 */
export const MAX_MESSAGE_FEEDBACK_ENTRIES = 500 as const;
/** The longest message id a rating may be keyed by. */
export const MAX_FEEDBACK_MESSAGE_ID_LENGTH = 256 as const;
/**
 * The most conversations that can be pinned at once.
 *
 * A pin list is a curated shelf rather than history, so it is bounded the same
 * way feedback is: nothing else prunes it, and a hand-edited blob must not be
 * able to make it unbounded.
 */
export const MAX_PINNED_CONVERSATIONS = 50 as const;
/** The longest conversation id a pin may carry. */
export const MAX_PINNED_CONVERSATION_ID_LENGTH = 256 as const;

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
export type MessageFeedbackRating = (typeof MESSAGE_FEEDBACK_RATINGS)[number];
/** Ratings by message id. Absent means the person has not rated that message. */
export type MessageFeedbackPreferences = Readonly<
  Record<string, MessageFeedbackRating>
>;
/**
 * The conversations kept at the top of the drawer, most recently pinned first.
 *
 * Order is the order they were pinned, not the order they were last used: the
 * shelf is what a person arranged, and it must not rearrange itself while they
 * are working.
 */
export type PinnedConversationPreferences = readonly string[];

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
  readonly messageFeedback: MessageFeedbackPreferences;
  readonly pinnedConversations: PinnedConversationPreferences;
  readonly agentPresets: AgentPresetPreferences;
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
  readonly message_feedback?: MessageFeedbackPreferences;
  readonly pinned_conversations?: PinnedConversationPreferences;
  readonly agent_presets?: AgentPresetPreferences;
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
  | {
      readonly type: 'preferences/set-message-feedback';
      readonly payload: {
        readonly messageId: string;
        /** null clears the rating the person left. */
        readonly rating: MessageFeedbackRating | null;
      };
    }
  | {
      readonly type: 'preferences/set-conversation-pin';
      readonly payload: {
        readonly conversationId: string;
        /** false removes the pin; true adds or keeps it. */
        readonly pinned: boolean;
      };
    }
  | {
      readonly type: 'preferences/set-agent-presets';
      readonly payload: { readonly agentPresets: AgentPresetPreferences };
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

import { hydrateAppPreferences, serializeAppPreferences } from './persistence';
import { createDefaultPreferences, preferencesReducer } from './reducer';
import type {
  AppPreferences,
  DefaultModelId,
  LocalePreference,
  MessageFeedbackRating,
  MirrorCategory,
  PreferencesAction,
  ThemeMode,
  ThinkingMode,
  ToolPermissionMode,
} from './types';

export type PreferencesListener = (preferences: AppPreferences) => void;

export type PreferencesStoreOptions = {
  readonly initialPreferences?: AppPreferences;
};

export type PreferencesStore = {
  getState(): AppPreferences;
  dispatch(action: PreferencesAction): AppPreferences;
  subscribe(listener: PreferencesListener): () => void;
  setThemeMode(themeMode: ThemeMode): void;
  setLocale(locale: LocalePreference): void;
  setDefaultModel(defaultModel: DefaultModelId): void;
  setSelectedHarness(harnessId: string): void;
  setThinkingMode(thinkingMode: ThinkingMode): void;
  setToolPermission(toolPermission: ToolPermissionMode): void;
  setShowReasoning(showReasoning: boolean): void;
  setAutoExpandTools(autoExpandTools: boolean): void;
  setConfirmDestructiveFileActions(confirm: boolean): void;
  setGitHttpsProxyUrl(gitHttpsProxyUrl: string | null): void;
  setMirror(
    category: MirrorCategory,
    preference: { enabled: boolean; baseUrl: string },
  ): void;
  /** Pass null to clear the rating; pass the current one to leave it. */
  setMessageFeedback(
    messageId: string,
    rating: MessageFeedbackRating | null,
  ): void;
  reset(): void;
  serialize(): string;
  hydrate(input: unknown): AppPreferences;
};

function preferencesEqual(
  left: AppPreferences,
  right: AppPreferences,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.themeMode === right.themeMode &&
    left.locale === right.locale &&
    left.defaultModel === right.defaultModel &&
    left.selectedHarnessId === right.selectedHarnessId &&
    left.thinkingMode === right.thinkingMode &&
    left.toolPermission === right.toolPermission &&
    left.showReasoning === right.showReasoning &&
    left.autoExpandTools === right.autoExpandTools &&
    left.confirmDestructiveFileActions ===
      right.confirmDestructiveFileActions &&
    left.gitHttpsProxyUrl === right.gitHttpsProxyUrl &&
    (['alpine', 'pip', 'npm'] as const).every(
      category =>
        left.mirrors[category].enabled === right.mirrors[category].enabled &&
        left.mirrors[category].baseUrl === right.mirrors[category].baseUrl,
    ) &&
    // Feedback decides whether a rating control re-renders, so a changed
    // rating has to count as a change -- comparing the maps by reference
    // would let a re-created-but-equal map notify, and comparing nothing at
    // all would swallow every rating.
    (() => {
      const keys = Object.keys(left.messageFeedback);
      return (
        keys.length === Object.keys(right.messageFeedback).length &&
        keys.every(
          key => left.messageFeedback[key] === right.messageFeedback[key],
        )
      );
    })()
  );
}

export function createPreferencesStore(
  options: PreferencesStoreOptions = {},
): PreferencesStore {
  let preferences = options.initialPreferences ?? createDefaultPreferences();
  const listeners = new Set<PreferencesListener>();

  const publish = (next: AppPreferences): AppPreferences => {
    if (!preferencesEqual(preferences, next)) {
      preferences = next;
      listeners.forEach(listener => listener(preferences));
    }
    return preferences;
  };

  const dispatch = (action: PreferencesAction): AppPreferences =>
    publish(preferencesReducer(preferences, action));

  return {
    getState: () => preferences,
    dispatch,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setThemeMode: themeMode => {
      dispatch({ type: 'preferences/set-theme', payload: { themeMode } });
    },
    setLocale: locale => {
      dispatch({ type: 'preferences/set-locale', payload: { locale } });
    },
    setDefaultModel: defaultModel => {
      dispatch({
        type: 'preferences/set-default-model',
        payload: { defaultModel },
      });
    },
    setSelectedHarness: harnessId => {
      dispatch({
        type: 'preferences/set-selected-harness',
        payload: { harnessId },
      });
    },
    setThinkingMode: thinkingMode => {
      dispatch({
        type: 'preferences/set-thinking-mode',
        payload: { thinkingMode },
      });
    },
    setToolPermission: toolPermission => {
      dispatch({
        type: 'preferences/set-tool-permission',
        payload: { toolPermission },
      });
    },
    setShowReasoning: showReasoning => {
      dispatch({
        type: 'preferences/set-show-reasoning',
        payload: { showReasoning },
      });
    },
    setAutoExpandTools: autoExpandTools => {
      dispatch({
        type: 'preferences/set-auto-expand-tools',
        payload: { autoExpandTools },
      });
    },
    setConfirmDestructiveFileActions: confirm => {
      dispatch({
        type: 'preferences/set-confirm-destructive-file-actions',
        payload: { confirm },
      });
    },
    setGitHttpsProxyUrl: gitHttpsProxyUrl => {
      dispatch({
        type: 'preferences/set-git-https-proxy-url',
        payload: { gitHttpsProxyUrl },
      });
    },
    setMirror: (category, preference) => {
      dispatch({
        type: 'preferences/set-mirror',
        payload: { category, ...preference },
      });
    },
    reset: () => {
      dispatch({ type: 'preferences/reset' });
    },
    setMessageFeedback: (messageId, rating) => {
      dispatch({
        type: 'preferences/set-message-feedback',
        payload: { messageId, rating },
      });
    },
    serialize: () => serializeAppPreferences(preferences),
    hydrate: input => publish(hydrateAppPreferences(input)),
  };
}

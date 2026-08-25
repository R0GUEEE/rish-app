import {
  APP_PREFERENCES_SCHEMA_VERSION,
  DEFAULT_APP_PREFERENCES,
  FALLBACK_LOCALE,
  FALLBACK_THEME,
  PreferencesValidationError,
  TRANSLATIONS,
  createDefaultPreferences,
  createPreferencesStore,
  createTranslator,
  hydrateAppPreferences,
  normalizeSystemLocale,
  preferencesReducer,
  resolveLocalePreference,
  resolveSystemLocale,
  resolveThemeMode,
  safeHydrateAppPreferences,
  selectAutoExpandTools,
  selectConfirmDestructiveFileActions,
  selectDefaultModel,
  selectLocalePreference,
  selectResolvedLocale,
  selectResolvedTheme,
  selectShowReasoning,
  selectThemeMode,
  selectThinkingMode,
  selectToolPermission,
  serializeAppPreferences,
  t,
  translate,
  type AppPreferences,
  type PersistedAppPreferencesV1,
  type PreferencesAction,
} from '../src/preferences';

describe('app preferences reducer and selectors', () => {
  test('uses conservative local-first defaults', () => {
    const preferences = createDefaultPreferences();
    expect(preferences).toEqual({
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
      mirrors: {
        alpine: {
          enabled: false,
          baseUrl: 'https://dl-cdn.alpinelinux.org/alpine/',
        },
        pip: { enabled: false, baseUrl: 'https://pypi.org/simple/' },
        npm: { enabled: false, baseUrl: 'https://registry.npmjs.org/' },
      },
    });
    expect(preferences).not.toBe(DEFAULT_APP_PREFERENCES);
    expect(Object.isFrozen(DEFAULT_APP_PREFERENCES)).toBe(true);
  });

  test('updates every preference through typed actions', () => {
    const actions: PreferencesAction[] = [
      { type: 'preferences/set-theme', payload: { themeMode: 'light' } },
      { type: 'preferences/set-locale', payload: { locale: 'zh-CN' } },
      {
        type: 'preferences/set-default-model',
        payload: { defaultModel: 'deepseek-v4-pro' },
      },
      {
        type: 'preferences/set-selected-harness',
        payload: { harnessId: 'dsh' },
      },
      {
        type: 'preferences/set-thinking-mode',
        payload: { thinkingMode: 'max' },
      },
      {
        type: 'preferences/set-tool-permission',
        payload: { toolPermission: 'read-only' },
      },
      {
        type: 'preferences/set-show-reasoning',
        payload: { showReasoning: true },
      },
      {
        type: 'preferences/set-auto-expand-tools',
        payload: { autoExpandTools: true },
      },
      {
        type: 'preferences/set-confirm-destructive-file-actions',
        payload: { confirm: false },
      },
      {
        type: 'preferences/set-mirror',
        payload: {
          category: 'npm',
          enabled: true,
          baseUrl: 'https://registry.npmmirror.com',
        },
      },
    ];
    const preferences = actions.reduce(
      preferencesReducer,
      createDefaultPreferences(),
    );

    expect(selectThemeMode(preferences)).toBe('light');
    expect(selectLocalePreference(preferences)).toBe('zh-CN');
    expect(selectDefaultModel(preferences)).toBe('deepseek-v4-pro');
    expect(selectThinkingMode(preferences)).toBe('max');
    expect(selectToolPermission(preferences)).toBe('read-only');
    expect(selectShowReasoning(preferences)).toBe(true);
    expect(selectAutoExpandTools(preferences)).toBe(true);
    expect(selectConfirmDestructiveFileActions(preferences)).toBe(false);
    expect(preferences.mirrors.npm).toEqual({
      enabled: true,
      baseUrl: 'https://registry.npmmirror.com/',
    });
  });

  test('returns the same reference for no-op and malformed actions', () => {
    const preferences = createDefaultPreferences();
    expect(
      preferencesReducer(preferences, {
        type: 'preferences/set-theme',
        payload: { themeMode: 'system' },
      }),
    ).toBe(preferences);

    const malformed = {
      type: 'preferences/set-theme',
      payload: { themeMode: 'sepia' },
    } as unknown as PreferencesAction;
    expect(preferencesReducer(preferences, malformed)).toBe(preferences);
  });

  test('reset restores defaults and is a no-op when already default', () => {
    const defaults = createDefaultPreferences();
    expect(preferencesReducer(defaults, { type: 'preferences/reset' })).toBe(
      defaults,
    );
    const changed = preferencesReducer(defaults, {
      type: 'preferences/set-thinking-mode',
      payload: { thinkingMode: 'off' },
    });
    expect(preferencesReducer(changed, { type: 'preferences/reset' })).toEqual(
      defaults,
    );
  });
});

describe('strict preferences persistence', () => {
  function configuredPreferences(): AppPreferences {
    return {
      schemaVersion: 1,
      themeMode: 'dark',
      locale: 'zh-CN',
      defaultModel: 'deepseek-v4-pro',
      selectedHarnessId: 'dsh',
      thinkingMode: 'max',
      toolPermission: 'read-only',
      showReasoning: true,
      autoExpandTools: true,
      confirmDestructiveFileActions: false,
      mirrors: {
        alpine: {
          enabled: true,
          baseUrl: 'https://mirrors.example.com/alpine/',
        },
        pip: {
          enabled: true,
          baseUrl: 'https://mirrors.example.com/pypi/simple/',
        },
        npm: {
          enabled: false,
          baseUrl: 'https://registry.npmjs.org/',
        },
      },
    };
  }

  test('serializes deterministically and round-trips schema v1', () => {
    const preferences = configuredPreferences();
    const first = serializeAppPreferences(preferences);
    const second = serializeAppPreferences(preferences);
    const decoded = JSON.parse(first) as PersistedAppPreferencesV1;

    expect(first).toBe(second);
    expect(decoded).toEqual({
      schema_version: 1,
      theme_mode: 'dark',
      locale: 'zh-CN',
      default_model: 'deepseek-v4-pro',
      selected_harness_id: 'dsh',
      thinking_mode: 'max',
      tool_permission: 'read-only',
      show_reasoning: true,
      auto_expand_tools: true,
      confirm_destructive_file_actions: false,
      mirrors: {
        alpine: {
          enabled: true,
          base_url: 'https://mirrors.example.com/alpine/',
        },
        pip: {
          enabled: true,
          base_url: 'https://mirrors.example.com/pypi/simple/',
        },
        npm: {
          enabled: false,
          base_url: 'https://registry.npmjs.org/',
        },
      },
    });
    expect(hydrateAppPreferences(first)).toEqual(preferences);
  });

  test('hydrates pre-mirror schema v1 preferences with official defaults', () => {
    const legacy = JSON.parse(
      serializeAppPreferences(configuredPreferences()),
    ) as Record<string, unknown>;
    delete legacy.mirrors;
    const hydrated = hydrateAppPreferences(legacy);
    expect(hydrated.mirrors.alpine.baseUrl).toBe(
      'https://dl-cdn.alpinelinux.org/alpine/',
    );
    expect(hydrated.mirrors.npm.enabled).toBe(false);
  });

  test.each([
    ['invalid JSON', '{bad'],
    ['null', null],
    ['array', []],
    [
      'wrong schema',
      {
        ...JSON.parse(serializeAppPreferences(configuredPreferences())),
        schema_version: 2,
      },
    ],
    [
      'unknown property',
      {
        ...JSON.parse(serializeAppPreferences(configuredPreferences())),
        surprise: true,
      },
    ],
    [
      'missing property',
      (() => {
        const value = JSON.parse(
          serializeAppPreferences(configuredPreferences()),
        ) as Record<string, unknown>;
        delete value.show_reasoning;
        return value;
      })(),
    ],
    [
      'invalid theme',
      {
        ...JSON.parse(serializeAppPreferences(configuredPreferences())),
        theme_mode: 'sepia',
      },
    ],
    [
      'invalid locale',
      {
        ...JSON.parse(serializeAppPreferences(configuredPreferences())),
        locale: 'fr-FR',
      },
    ],
    [
      'invalid model',
      {
        ...JSON.parse(serializeAppPreferences(configuredPreferences())),
        default_model: 'deepseek-v3',
      },
    ],
    [
      'invalid thinking mode',
      {
        ...JSON.parse(serializeAppPreferences(configuredPreferences())),
        thinking_mode: 'medium',
      },
    ],
    [
      'non-boolean toggle',
      {
        ...JSON.parse(serializeAppPreferences(configuredPreferences())),
        auto_expand_tools: 1,
      },
    ],
  ])('rejects %s', (_label, input) => {
    expect(() => hydrateAppPreferences(input)).toThrow(
      PreferencesValidationError,
    );
  });

  test('safe hydration returns a typed path without throwing', () => {
    const result = safeHydrateAppPreferences({ schema_version: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(PreferencesValidationError);
      expect(result.error.path).toBe('$.theme_mode');
    }
  });
});

describe('system theme and locale resolution', () => {
  test.each([
    ['zh-Hans-CN', 'zh-CN'],
    ['zh_Hant_TW', 'zh-CN'],
    ['ZH-cn', 'zh-CN'],
    ['en-GB', 'en-US'],
    ['en_US', 'en-US'],
    ['fr-FR', null],
    ['', null],
    [null, null],
  ])('normalizes %p to %p', (input, expected) => {
    expect(normalizeSystemLocale(input)).toBe(expected);
  });

  test('supports native locale descriptors and first supported fallback', () => {
    expect(
      resolveSystemLocale([
        { languageTag: 'fr-FR' },
        { languageCode: 'zh', countryCode: 'SG' },
      ]),
    ).toBe('zh-CN');
    expect(resolveSystemLocale({ languageCode: 'en', countryCode: 'AU' })).toBe(
      'en-US',
    );
    expect(resolveSystemLocale(['fr-FR', 'de-DE'])).toBe(FALLBACK_LOCALE);
  });

  test('explicit locale and theme preferences override system values', () => {
    expect(resolveLocalePreference('zh-CN', ['en-US'])).toBe('zh-CN');
    expect(resolveLocalePreference('system', ['zh-Hans-CN'])).toBe('zh-CN');
    expect(resolveThemeMode('light', 'dark')).toBe('light');
    expect(resolveThemeMode('system', 'light')).toBe('light');
    expect(resolveThemeMode('system', null)).toBe(FALLBACK_THEME);

    const preferences = createDefaultPreferences();
    expect(selectResolvedLocale(preferences, ['zh-CN'])).toBe('zh-CN');
    expect(selectResolvedTheme(preferences, 'light')).toBe('light');
  });
});

describe('translations', () => {
  test('English and Simplified Chinese dictionaries have identical coverage', () => {
    const englishKeys = Object.keys(TRANSLATIONS['en-US']).sort();
    const chineseKeys = Object.keys(TRANSLATIONS['zh-CN']).sort();
    expect(chineseKeys).toEqual(englishKeys);
    expect(englishKeys.length).toBeGreaterThan(150);
    expect(Object.values(TRANSLATIONS['en-US']).every(Boolean)).toBe(true);
    expect(Object.values(TRANSLATIONS['zh-CN']).every(Boolean)).toBe(true);
  });

  test.each(['home', 'drawer', 'settings', 'runtime', 'files', 'messages'])(
    'contains major %s UI labels',
    namespace => {
      expect(
        Object.keys(TRANSLATIONS['en-US']).some(key =>
          key.startsWith(`${namespace}.`),
        ),
      ).toBe(true);
    },
  );

  test('interpolates parameters without erasing missing values', () => {
    expect(
      translate('en-US', 'drawer.openChat', { title: 'Local proof' }),
    ).toBe('Open chat Local proof');
    expect(
      translate('zh-CN', 'files.destructiveTitle', { name: 'notes.md' }),
    ).toBe('删除“notes.md”？');
    expect(translate('en-US', 'files.selectedCount')).toBe('{count} selected');
  });

  test('provides default and locale-bound t(key, params?) translators', () => {
    const zh = createTranslator('zh-CN');
    expect(t('settings.title')).toBe('Local by default');
    expect(zh('messages.toolRunning', { tool: 'rish' })).toBe('正在运行 rish…');
  });
});

describe('preferences store', () => {
  test('publishes only real changes and hydrates persisted settings', () => {
    const listener = jest.fn();
    const store = createPreferencesStore();
    const unsubscribe = store.subscribe(listener);

    store.setThemeMode('system');
    store.setThemeMode('dark');
    store.setLocale('zh-CN');
    store.setDefaultModel('deepseek-v4-pro');
    store.setThinkingMode('max');
    store.setShowReasoning(true);
    store.setAutoExpandTools(true);
    store.setConfirmDestructiveFileActions(false);

    expect(listener).toHaveBeenCalledTimes(7);
    const serialized = store.serialize();
    store.hydrate(serialized);
    expect(listener).toHaveBeenCalledTimes(7);

    store.reset();
    expect(listener).toHaveBeenCalledTimes(8);
    expect(store.getState()).toEqual(createDefaultPreferences());

    unsubscribe();
    store.setLocale('en-US');
    expect(listener).toHaveBeenCalledTimes(8);
  });
});

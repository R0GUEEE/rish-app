import {
  MAX_PLUGINS,
  MAX_PLUGIN_TOOL_ARGUMENTS,
  MAX_PLUGIN_TOOL_ARGUMENT_LENGTH,
  isPluginTool,
  isPluginToolExecution,
  pluginToolRunnable,
  MAX_PLUGIN_TOOLS,
  PLUGIN_TOOL_REGISTRY_VERSION,
  createPlugin,
  isPlugin,
  isPluginId,
  isPluginToolName,
  normalizePlugins,
  pluginToolCapabilities,
  pluginToolName,
  pluginToolOffers,
  pluginToolPosture,
  removePlugin,
  setPluginEnabled,
  upsertPlugin,
  type Plugin,
} from '../src/plugins/plugins';
import {
  createDefaultPreferences,
  createPreferencesStore,
  hydrateAppPreferences,
  preferencesReducer,
  selectPlugins,
  serializeAppPreferences,
  type AppPreferences,
} from '../src/preferences';

const tool = (name: string) => ({
  name,
  description: `Run ${name}.`,
  capability: 'file_read' as const,
  requiresApproval: false,
});

const plugin = (overrides: Partial<Plugin> = {}): Plugin =>
  createPlugin({
    id: 'sample',
    name: 'Sample',
    version: '1.0.0',
    description: 'A sample plugin.',
    tools: [tool('fetch')],
    ...overrides,
  })!;

const setPlugins = (
  preferences: AppPreferences,
  plugins: readonly Plugin[],
): AppPreferences =>
  preferencesReducer(preferences, {
    type: 'preferences/set-plugins',
    payload: { plugins },
  });

describe('plugin declaration validation', () => {
  test('an id is short, lower case and usable in a tool name', () => {
    expect(isPluginId('sample')).toBe(true);
    expect(isPluginId('web_tools_2')).toBe(true);
    expect(isPluginId('')).toBe(false);
    expect(isPluginId('Sample')).toBe(false);
    expect(isPluginId('2fast')).toBe(false);
    expect(isPluginId('has-dash')).toBe(false);
    expect(isPluginId('x'.repeat(41))).toBe(false);
  });

  test('a tool may not shadow a tool the app already offers', () => {
    expect(isPluginToolName('fetch')).toBe(true);
    expect(isPluginToolName('read_file')).toBe(false);
    expect(isPluginToolName('git_push')).toBe(false);
    expect(isPluginToolName('run_program')).toBe(false);
  });

  test('a plugin needs every field, and a bounded tool list', () => {
    expect(isPlugin(plugin())).toBe(true);
    expect(isPlugin({ ...plugin(), tools: [] })).toBe(true);
    expect(
      isPlugin({
        ...plugin(),
        tools: Array.from({ length: MAX_PLUGIN_TOOLS + 1 }, (_, index) =>
          tool(`t${index}`),
        ),
      }),
    ).toBe(false);
    expect(isPlugin({ ...plugin(), version: '' })).toBe(false);
    expect(isPlugin({ ...plugin(), enabled: 'yes' })).toBe(false);
    // Two tools under one name inside one plugin cannot both be offered.
    expect(isPlugin({ ...plugin(), tools: [tool('fetch'), tool('fetch')] })).toBe(
      false,
    );
  });

  test('creating trims what a person typed and refuses what cannot be offered', () => {
    const created = createPlugin({
      id: 'sample',
      name: '  Sample  ',
      version: ' 1.0.0 ',
      description: '  A sample plugin.  ',
      tools: [tool('fetch')],
    });
    expect(created).toEqual({
      id: 'sample',
      name: 'Sample',
      version: '1.0.0',
      description: 'A sample plugin.',
      enabled: true,
      tools: [tool('fetch')],
    });
    // The pair is what has to fit the provider's function-name budget: each
    // name is within its own bound and the offered name still is not.
    expect(
      createPlugin({
        id: 'p'.repeat(40),
        name: 'Long',
        version: '1.0.0',
        description: 'Long ids.',
        tools: [tool('t'.repeat(40))],
      }),
    ).toBeNull();
    expect(
      createPlugin({
        id: 'p'.repeat(30),
        name: 'Shorter',
        version: '1.0.0',
        description: 'A shorter pair.',
        tools: [tool('t'.repeat(30))],
      }),
    ).not.toBeNull();
  });
});

describe('plugin list rules', () => {
  test('a list is bounded, uniquely identified and complete', () => {
    expect(normalizePlugins([])).toEqual([]);
    expect(normalizePlugins([plugin()])).toHaveLength(1);
    expect(normalizePlugins([plugin(), plugin()])).toBeNull();
    expect(normalizePlugins([{ ...plugin(), name: '' }])).toBeNull();
    expect(normalizePlugins('plugins')).toBeNull();
    expect(
      normalizePlugins(
        Array.from({ length: MAX_PLUGINS + 1 }, (_, index) =>
          plugin({ id: `p${index}` }),
        ),
      ),
    ).toBeNull();
  });

  test('adding replaces in place, and a full list refuses a new plugin', () => {
    const first = plugin({ id: 'one' });
    const second = plugin({ id: 'two' });
    const list = upsertPlugin(upsertPlugin([], first), second);
    const corrected = upsertPlugin(list, plugin({ id: 'one', version: '2.0.0' }));
    expect(corrected.map(entry => entry.id)).toEqual(['one', 'two']);
    expect(corrected[0]!.version).toBe('2.0.0');

    const full = Array.from({ length: MAX_PLUGINS }, (_, index) =>
      plugin({ id: `p${index}` }),
    );
    expect(upsertPlugin(full, plugin({ id: 'extra' }))).toBe(full);
    // Replacing an existing entry is still allowed at the bound.
    expect(upsertPlugin(full, plugin({ id: 'p0', version: '9.9.9' }))[0]!.version)
      .toBe('9.9.9');
  });

  test('removing and enabling are no-ops when nothing would change', () => {
    const list = [plugin({ id: 'one' })];
    expect(removePlugin(list, 'missing')).toBe(list);
    expect(removePlugin(list, 'one')).toEqual([]);
    expect(setPluginEnabled(list, 'missing', false)).toBe(list);
    expect(setPluginEnabled(list, 'one', true)).toBe(list);
    const disabled = setPluginEnabled(list, 'one', false);
    expect(disabled[0]!.enabled).toBe(false);
    expect(disabled[0]!.tools).toEqual(list[0]!.tools);
  });
});

describe('what the enabled plugins would offer', () => {
  test('only enabled plugins contribute tools, under namespaced names', () => {
    const list = [
      plugin({ id: 'one', tools: [tool('fetch'), tool('store')] }),
      plugin({ id: 'two', enabled: false, tools: [tool('hidden')] }),
    ];
    const offers = pluginToolOffers(list);
    expect(offers.map(offer => offer.offeredName)).toEqual([
      pluginToolName('one', 'fetch'),
      pluginToolName('one', 'store'),
    ]);
    expect(offers[0]!.offeredName.length).toBeLessThanOrEqual(64);
    expect(
      pluginToolOffers(list).some(offer => offer.offeredName.includes('hidden')),
    ).toBe(false);
  });

  test('the capabilities are the ones enabled plugins ask for, in core order', () => {
    const list = [
      plugin({
        id: 'one',
        tools: [tool('fetch')],
      }),
      plugin({
        id: 'two',
        tools: [
          { ...tool('deploy'), capability: 'guest_service' as const },
          { ...tool('commit'), capability: 'git_commit' as const },
        ],
      }),
    ];
    expect(pluginToolCapabilities(list)).toEqual([
      'file_read',
      'git_commit',
      'guest_service',
    ]);
    expect(pluginToolCapabilities([])).toEqual([]);
  });

  test('the posture is honest about a table that does not admit plugins yet', () => {
    expect(pluginToolPosture(null)).toBe('unknown');
    expect(pluginToolPosture(PLUGIN_TOOL_REGISTRY_VERSION - 1)).toBe(
      'awaiting_native',
    );
    expect(pluginToolPosture(PLUGIN_TOOL_REGISTRY_VERSION)).toBe('admitted');
  });
});

describe('plugins as a preference', () => {
  test('starts with none', () => {
    expect(selectPlugins(createDefaultPreferences())).toEqual([]);
  });

  test('an equal-but-rebuilt list is not a change', () => {
    const preferences = setPlugins(createDefaultPreferences(), [plugin()]);
    expect(setPlugins(preferences, [preferences.plugins[0]!])).toBe(preferences);
    expect(setPlugins(preferences, [plugin()])).not.toBe(preferences);
  });

  test('an invalid list is refused rather than stored', () => {
    const preferences = setPlugins(createDefaultPreferences(), [plugin()]);
    expect(
      preferencesReducer(preferences, {
        type: 'preferences/set-plugins',
        payload: { plugins: [{ id: 'broken' } as unknown as Plugin] },
      }),
    ).toBe(preferences);
  });

  test('the whole list survives a save and load', () => {
    const preferences = setPlugins(createDefaultPreferences(), [plugin()]);
    expect(
      selectPlugins(hydrateAppPreferences(serializeAppPreferences(preferences))),
    ).toEqual(preferences.plugins);
  });

  test('a state written before plugins existed loads as none', () => {
    const serialized = JSON.parse(
      serializeAppPreferences(createDefaultPreferences()),
    ) as Record<string, unknown>;
    delete serialized.plugins;
    expect(selectPlugins(hydrateAppPreferences(serialized))).toEqual([]);
  });

  test('a stored list that breaks the rule is refused as a whole', () => {
    const withPlugins = (value: unknown): Record<string, unknown> => {
      const serialized = JSON.parse(
        serializeAppPreferences(createDefaultPreferences()),
      ) as Record<string, unknown>;
      serialized.plugins = value;
      return serialized;
    };
    expect(() =>
      hydrateAppPreferences(withPlugins([plugin(), plugin()])),
    ).toThrow();
    expect(() =>
      hydrateAppPreferences(withPlugins([{ id: 'broken' }])),
    ).toThrow();
    expect(() => hydrateAppPreferences(withPlugins('none'))).toThrow();
    expect(selectPlugins(hydrateAppPreferences(withPlugins([])))).toEqual([]);
  });

  test('the store enables, replaces and removes without extra notifications', () => {
    const store = createPreferencesStore();
    const listener = jest.fn();
    store.subscribe(listener);
    const added = plugin();

    store.savePlugin(added);
    store.setPluginEnabled(added.id, true);
    store.setPluginEnabled(added.id, false);
    store.deletePlugin('missing');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(selectPlugins(store.getState())).toEqual([
      { ...added, enabled: false },
    ]);

    store.deletePlugin(added.id);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(selectPlugins(store.getState())).toEqual([]);
  });
});

describe('a tool that says what it would run', () => {
  const mapped = {
    kind: 'guest_program' as const,
    environmentId: 'node',
    programPath: 'plugin-scripts/fetch_page.js',
    arguments: ['--json'],
  };

  test('the mapping is bounded and stays inside the run workspace', () => {
    expect(isPluginToolExecution(mapped)).toBe(true);
    expect(isPluginToolExecution({ ...mapped, environmentId: 'Node' })).toBe(
      false,
    );
    expect(isPluginToolExecution({ ...mapped, kind: 'native' })).toBe(false);
    expect(isPluginToolExecution({ ...mapped, programPath: '/etc/passwd' })).toBe(
      false,
    );
    expect(isPluginToolExecution({ ...mapped, programPath: '../secrets' })).toBe(
      false,
    );
    expect(isPluginToolExecution({ ...mapped, programPath: 'a//b' })).toBe(false);
    expect(
      isPluginToolExecution({
        ...mapped,
        arguments: Array.from(
          { length: MAX_PLUGIN_TOOL_ARGUMENTS + 1 },
          () => 'x',
        ),
      }),
    ).toBe(false);
    expect(
      isPluginToolExecution({
        ...mapped,
        arguments: ['x'.repeat(MAX_PLUGIN_TOOL_ARGUMENT_LENGTH + 1)],
      }),
    ).toBe(false);
  });

  test('a tool may say what it runs, and may also say nothing', () => {
    const withMapping = { ...tool('fetch'), execution: mapped };
    expect(isPluginTool(withMapping)).toBe(true);
    expect(pluginToolRunnable(withMapping)).toBe(true);
    expect(isPluginTool(tool('fetch'))).toBe(true);
    expect(pluginToolRunnable(tool('fetch'))).toBe(false);
    // A mapping the app could not run must not be accepted as one.
    expect(isPluginTool({ ...tool('fetch'), execution: { kind: 'binary' } })).toBe(
      false,
    );
  });

  test('a mapped tool still needs a capability the core can check', () => {
    expect(
      isPluginTool({ ...tool('fetch'), execution: mapped, capability: 'root' }),
    ).toBe(false);
  });
});

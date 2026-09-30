import {
  MAX_AGENT_PRESETS,
  MAX_PRESET_NAME_LENGTH,
  createAgentPreset,
  findAgentPreset,
  isAgentPreset,
  isPresetId,
  isPresetName,
  removeAgentPreset,
  renameAgentPreset,
  upsertAgentPreset,
  type AgentPreset,
} from '../src/presets/presets';
import {
  createDefaultPreferences,
  createPreferencesStore,
  hydrateAppPreferences,
  normalizeAgentPresets,
  selectAgentPresets,
  serializeAppPreferences,
  type AppPreferences,
} from '../src/preferences';

const preset = (overrides: Partial<AgentPreset> = {}): AgentPreset => ({
  id: 'preset-1',
  name: 'Careful refactor',
  modelId: 'deepseek-v4-pro',
  thinkingMode: 'max',
  toolPermission: 'read-only',
  ...overrides,
});

describe('preset field validation', () => {
  test('accepts a bounded printable id and rejects anything else', () => {
    expect(isPresetId('p1')).toBe(true);
    expect(isPresetId('')).toBe(false);
    expect(isPresetId('x'.repeat(65))).toBe(false);
    expect(isPresetId('x'.repeat(64))).toBe(true);
    expect(isPresetId('bad\u0000id')).toBe(false);
    expect(isPresetId(7)).toBe(false);
  });

  test('a name has to say something once trimmed', () => {
    expect(isPresetName('Review')).toBe(true);
    expect(isPresetName('  Review  ')).toBe(true);
    expect(isPresetName('')).toBe(false);
    expect(isPresetName('   ')).toBe(false);
    expect(isPresetName('x'.repeat(MAX_PRESET_NAME_LENGTH))).toBe(true);
    expect(isPresetName('x'.repeat(MAX_PRESET_NAME_LENGTH + 1))).toBe(false);
    expect(isPresetName('two\nlines')).toBe(false);
  });
});

describe('isAgentPreset', () => {
  test('accepts a complete preset', () => {
    expect(isAgentPreset(preset())).toBe(true);
  });

  test('refuses a preset that is missing or carrying extra fields', () => {
    const { toolPermission: _drop, ...missing } = preset();
    expect(isAgentPreset(missing)).toBe(false);
    expect(isAgentPreset({ ...preset(), extra: true })).toBe(false);
  });

  test('refuses a setting the round could not honour', () => {
    expect(isAgentPreset(preset({ modelId: 'not-a-model' }))).toBe(false);
    expect(isAgentPreset(preset({ thinkingMode: 'medium' as never }))).toBe(false);
    expect(isAgentPreset(preset({ toolPermission: 'anything' as never }))).toBe(false);
    expect(isAgentPreset(preset({ id: '' }))).toBe(false);
    expect(isAgentPreset(preset({ name: ' ' }))).toBe(false);
  });

  test('refuses anything that is not an object', () => {
    for (const value of [null, undefined, 'preset', 3, [], true]) {
      expect(isAgentPreset(value)).toBe(false);
    }
  });
});

describe('createAgentPreset', () => {
  test('trims the name it was given', () => {
    const created = createAgentPreset({
      id: 'p1',
      name: '  Tight scope  ',
      modelId: 'deepseek-v4-flash',
      thinkingMode: 'off',
      toolPermission: 'workspace-write',
    });
    expect(created?.name).toBe('Tight scope');
  });

  test('answers null rather than a half-valid preset', () => {
    expect(
      createAgentPreset({
        id: 'p1',
        name: '',
        modelId: 'deepseek-v4-flash',
        thinkingMode: 'off',
        toolPermission: 'workspace-write',
      }),
    ).toBeNull();
    expect(
      createAgentPreset({
        id: 'p1',
        name: 'ok',
        modelId: 'nope',
        thinkingMode: 'off',
        toolPermission: 'workspace-write',
      }),
    ).toBeNull();
  });
});

describe('upsertAgentPreset', () => {
  test('appends a new preset', () => {
    const list = upsertAgentPreset([], preset());
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(preset());
  });

  test('replaces in place, so a corrected preset does not jump the list', () => {
    const list = [preset({ id: 'a' }), preset({ id: 'b' }), preset({ id: 'c' })];
    const next = upsertAgentPreset(list, preset({ id: 'b', name: 'Renamed' }));
    expect(next.map(entry => entry.id)).toEqual(['a', 'b', 'c']);
    expect(next[1].name).toBe('Renamed');
  });

  test('is a no-op, by reference, when the preset is unchanged', () => {
    const only = preset();
    const list = [only];
    expect(upsertAgentPreset(list, only)).toBe(list);
  });

  test('refuses to grow past the bound instead of evicting one', () => {
    const full = Array.from({ length: MAX_AGENT_PRESETS }, (_, index) =>
      preset({ id: `p${index}` }),
    );
    expect(upsertAgentPreset(full, preset({ id: 'overflow' }))).toBe(full);
    // Replacing an existing one is still allowed when full.
    expect(upsertAgentPreset(full, preset({ id: 'p0', name: 'New' }))).toHaveLength(
      MAX_AGENT_PRESETS,
    );
  });

  test('refuses a preset that is not valid at all', () => {
    const list = [preset()];
    expect(upsertAgentPreset(list, preset({ id: '' }))).toBe(list);
  });
});

describe('remove and rename', () => {
  test('removes by id, and says so by reference when nothing matched', () => {
    const list = [preset({ id: 'a' }), preset({ id: 'b' })];
    expect(removeAgentPreset(list, 'a').map(entry => entry.id)).toEqual(['b']);
    expect(removeAgentPreset(list, 'missing')).toBe(list);
  });

  test('renames the one asked for and leaves the rest alone', () => {
    const list = [preset({ id: 'a', name: 'One' }), preset({ id: 'b', name: 'Two' })];
    const next = renameAgentPreset(list, 'a', '  First  ');
    expect(next[0].name).toBe('First');
    expect(next[1].name).toBe('Two');
  });

  test('refuses a blank name and an unknown id', () => {
    const list = [preset({ id: 'a' })];
    expect(renameAgentPreset(list, 'a', '   ')).toBe(list);
    expect(renameAgentPreset(list, 'nope', 'Fine')).toBe(list);
  });

  test('a rename to the same name changes nothing', () => {
    const list = [preset({ id: 'a', name: 'Same' })];
    expect(renameAgentPreset(list, 'a', 'Same')).toBe(list);
  });

  test('finds a preset by id', () => {
    const list = [preset({ id: 'a' }), preset({ id: 'b' })];
    expect(findAgentPreset(list, 'b')?.id).toBe('b');
    expect(findAgentPreset(list, 'c')).toBeNull();
  });
});

describe('normalizeAgentPresets', () => {
  test('accepts a bounded list of unique, complete presets', () => {
    const list = [preset({ id: 'a' }), preset({ id: 'b' })];
    expect(normalizeAgentPresets(list)).toBe(list);
    expect(normalizeAgentPresets([])).toEqual([]);
  });

  test('answers null rather than dropping what it cannot read', () => {
    expect(normalizeAgentPresets([preset(), { id: 'x' }])).toBeNull();
    expect(normalizeAgentPresets(preset())).toBeNull();
    expect(normalizeAgentPresets(null)).toBeNull();
  });

  test('refuses two presets under one id', () => {
    expect(normalizeAgentPresets([preset({ id: 'same' }), preset({ id: 'same' })])).toBeNull();
  });

  test('refuses a list past the bound', () => {
    const over = Array.from({ length: MAX_AGENT_PRESETS + 1 }, (_, index) =>
      preset({ id: `p${index}` }),
    );
    expect(normalizeAgentPresets(over)).toBeNull();
  });
});

describe('preset persistence', () => {
  const withPresets = (presets: readonly AgentPreset[]): AppPreferences => ({
    ...createDefaultPreferences(),
    agentPresets: presets,
  });

  test('round-trips through the persisted envelope', () => {
    const preferences = withPresets([preset({ id: 'a' }), preset({ id: 'b', name: 'Other' })]);
    const encoded = serializeAppPreferences(preferences);
    expect(JSON.parse(encoded).agent_presets).toHaveLength(2);
    expect(hydrateAppPreferences(encoded).agentPresets).toEqual(
      preferences.agentPresets,
    );
  });

  test('a state written before presets existed hydrates to none', () => {
    const legacy = JSON.parse(
      serializeAppPreferences(createDefaultPreferences()),
    ) as Record<string, unknown>;
    delete legacy.agent_presets;
    expect(hydrateAppPreferences(legacy).agentPresets).toEqual([]);
  });

  test('refuses a stored preset the round could not honour', () => {
    const encoded = JSON.parse(
      serializeAppPreferences(createDefaultPreferences()),
    ) as Record<string, unknown>;
    encoded.agent_presets = [{ id: 'a', name: 'ok', modelId: 'nope', thinkingMode: 'high', toolPermission: 'read-only' }];
    expect(() => hydrateAppPreferences(encoded)).toThrow(/agent_presets/u);
  });

  test('refuses a stored list with duplicate ids', () => {
    const encoded = JSON.parse(
      serializeAppPreferences(createDefaultPreferences()),
    ) as Record<string, unknown>;
    encoded.agent_presets = [preset({ id: 'dup' }), preset({ id: 'dup' })];
    expect(() => hydrateAppPreferences(encoded)).toThrow(/agent_presets/u);
  });
});

describe('presets through the preferences store', () => {
  test('saving one reaches subscribers', () => {
    const store = createPreferencesStore();
    const seen: AppPreferences[] = [];
    store.subscribe(preferences => seen.push(preferences));
    store.saveAgentPreset(preset({ id: 'a' }));
    expect(seen).toHaveLength(1);
    expect(selectAgentPresets(store.getState()).map(entry => entry.id)).toEqual(['a']);
  });

  test('saving a second one keeps both, and re-saving replaces in place', () => {
    const store = createPreferencesStore();
    store.saveAgentPreset(preset({ id: 'a', name: 'One' }));
    store.saveAgentPreset(preset({ id: 'b', name: 'Two' }));
    store.saveAgentPreset(preset({ id: 'a', name: 'First' }));
    expect(
      selectAgentPresets(store.getState()).map(entry => [entry.id, entry.name]),
    ).toEqual([
      ['a', 'First'],
      ['b', 'Two'],
    ]);
  });

  test('deleting one reaches subscribers and leaves the rest', () => {
    const store = createPreferencesStore();
    store.saveAgentPreset(preset({ id: 'a' }));
    store.saveAgentPreset(preset({ id: 'b' }));
    const seen: AppPreferences[] = [];
    store.subscribe(preferences => seen.push(preferences));
    store.deleteAgentPreset('a');
    expect(seen).toHaveLength(1);
    expect(selectAgentPresets(store.getState()).map(entry => entry.id)).toEqual(['b']);
  });

  test('deleting one that is not there notifies nobody', () => {
    const store = createPreferencesStore();
    store.saveAgentPreset(preset({ id: 'a' }));
    const seen: AppPreferences[] = [];
    store.subscribe(preferences => seen.push(preferences));
    store.deleteAgentPreset('missing');
    expect(seen).toHaveLength(0);
  });

  test('refuses to save a preset that is not valid', () => {
    const store = createPreferencesStore();
    store.saveAgentPreset(preset({ id: 'a' }));
    store.saveAgentPreset(preset({ id: '' }));
    expect(selectAgentPresets(store.getState())).toHaveLength(1);
  });

  test('survives a serialize and hydrate round-trip through the store', () => {
    const store = createPreferencesStore();
    store.saveAgentPreset(preset({ id: 'a', name: 'Kept' }));
    const reloaded = createPreferencesStore();
    reloaded.hydrate(store.serialize());
    expect(selectAgentPresets(reloaded.getState())[0].name).toBe('Kept');
  });

  test('reset clears presets along with everything else', () => {
    const store = createPreferencesStore();
    store.saveAgentPreset(preset({ id: 'a' }));
    store.reset();
    expect(selectAgentPresets(store.getState())).toEqual([]);
  });
});


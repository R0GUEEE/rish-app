import {
  MARKETPLACE_SCHEMA_VERSION,
  compareVersions,
  installPluginEntry,
  installSkillEntry,
  isMarketplaceEntry,
  marketplaceEntryId,
  marketplaceInstallState,
  parseMarketplaceCatalog,
  type MarketplaceEntry,
} from '../src/marketplace';
import { BUILTIN_MARKETPLACE } from '../src/marketplace';
import { upsertPlugin, type Plugin } from '../src/plugins/plugins';
import { upsertSkill, type Skill } from '../src/skills';

// Narrowed to the one kind it builds, so a test can reach the payload it is
// installing while the entry still satisfies the union every caller takes.
const skillEntry = (
  version = '1.0.0',
): Extract<MarketplaceEntry, { kind: 'skill' }> => ({
  kind: 'skill',
  publisher: 'Rish',
  summary: 'A skill.',
  skill: {
    id: 'release_notes',
    name: 'Release notes',
    version,
    description: 'Turn changes into notes.',
    instructions: 'Read the diff.',
  },
});

const pluginEntry = (
  version = '1.0.0',
): Extract<MarketplaceEntry, { kind: 'plugin' }> => ({
  kind: 'plugin',
  publisher: 'Rish',
  summary: 'A plugin.',
  plugin: {
    id: 'web_reader',
    name: 'Web reader',
    version,
    description: 'Reads a page.',
    enabled: false,
    tools: [
      {
        name: 'fetch_page',
        description: 'Fetch a page.',
        capability: 'file_read',
        requiresApproval: false,
      },
    ],
  },
});

const catalog = (entries: unknown[]) => ({
  schemaVersion: MARKETPLACE_SCHEMA_VERSION,
  source: 'Test catalog',
  entries,
});

describe('marketplace entries', () => {
  test('an entry is a kind, a publisher, a summary and one payload', () => {
    expect(isMarketplaceEntry(skillEntry())).toBe(true);
    expect(isMarketplaceEntry(pluginEntry())).toBe(true);
    expect(isMarketplaceEntry({ ...skillEntry(), kind: 'theme' })).toBe(false);
    expect(isMarketplaceEntry({ ...skillEntry(), publisher: '' })).toBe(false);
    expect(
      isMarketplaceEntry({ ...skillEntry(), skill: { id: 'broken' } }),
    ).toBe(false);
    // A payload that does not match its kind is not an entry.
    expect(
      isMarketplaceEntry({ ...skillEntry(), skill: undefined }),
    ).toBe(false);
  });

  test('the id and version shown come from whichever payload it carries', () => {
    expect(marketplaceEntryId(skillEntry())).toBe('release_notes');
    expect(marketplaceEntryId(pluginEntry())).toBe('web_reader');
  });
});

describe('versions', () => {
  test('numeric versions compare segment by segment', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.9.9', '2.0.0')).toBe(-1);
  });

  test('a version that is not a sequence of numbers has no ordering', () => {
    expect(compareVersions('2026-02-draft', '1.0.0')).toBeNull();
    expect(compareVersions('1.0.0', 'latest')).toBeNull();
  });

  test('an install state is install, nothing to do, or an update', () => {
    expect(marketplaceInstallState(skillEntry(), null)).toBe('not_installed');
    expect(marketplaceInstallState(skillEntry('1.0.0'), '1.0.0')).toBe(
      'installed',
    );
    expect(marketplaceInstallState(skillEntry('1.1.0'), '1.0.0')).toBe(
      'update_available',
    );
    // An older listing is not an update, and an unorderable one is not either.
    expect(marketplaceInstallState(skillEntry('0.9.0'), '1.0.0')).toBe(
      'installed',
    );
    expect(marketplaceInstallState(skillEntry('draft'), '1.0.0')).toBe(
      'installed',
    );
  });
});

describe('catalogs', () => {
  test('a catalog is validated as a whole', () => {
    expect(parseMarketplaceCatalog(catalog([skillEntry()]))).not.toBeNull();
    expect(
      parseMarketplaceCatalog(catalog([skillEntry(), skillEntry()])),
    ).toBeNull();
    expect(
      parseMarketplaceCatalog({
        ...catalog([skillEntry()]),
        schemaVersion: 99,
      }),
    ).toBeNull();
    expect(parseMarketplaceCatalog(catalog(['nope']))).toBeNull();
    expect(parseMarketplaceCatalog('catalog')).toBeNull();
    // The same id in the two libraries is not a duplicate.
    expect(
      parseMarketplaceCatalog(catalog([skillEntry(), pluginEntry()])),
    ).not.toBeNull();
  });

  test('the shipped catalog parses, and every entry of it can be installed', () => {
    expect(parseMarketplaceCatalog(BUILTIN_MARKETPLACE)).not.toBeNull();
    expect(BUILTIN_MARKETPLACE.entries.length).toBeGreaterThan(0);
    for (const entry of BUILTIN_MARKETPLACE.entries) {
      expect(isMarketplaceEntry(entry)).toBe(true);
      expect(marketplaceEntryId(entry).length).toBeGreaterThan(0);
    }
    const plugins: readonly Plugin[] = [];
    const skills: readonly Skill[] = [];
    const withPlugins = BUILTIN_MARKETPLACE.entries.reduce(
      (list, entry) => installPluginEntry(list, entry, upsertPlugin),
      plugins,
    );
    const withSkills = BUILTIN_MARKETPLACE.entries.reduce(
      (list, entry) => installSkillEntry(list, entry, upsertSkill),
      skills,
    );
    expect(withPlugins.length).toBe(1);
    expect(withSkills.length).toBe(2);
    expect(withPlugins[0]!.enabled).toBe(false);
  });
});

describe('installing', () => {
  test('an entry replaces the one with the same id and leaves the other kind alone', () => {
    const installed = upsertSkill([], skillEntry('1.0.0').skill);
    const updated = installSkillEntry(installed, skillEntry('1.1.0'), upsertSkill);
    expect(updated).toHaveLength(1);
    expect(updated[0]!.version).toBe('1.1.0');

    const plugins = installPluginEntry([], skillEntry(), upsertPlugin);
    expect(plugins).toEqual([]);
    expect(installSkillEntry(installed, pluginEntry(), upsertSkill)).toBe(
      installed,
    );
  });
});

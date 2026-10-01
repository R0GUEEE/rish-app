/**
 * The marketplace: entries a person can install into their plugin and skill
 * libraries, and the catalog this build ships with.
 *
 * The catalog is validated as a whole before any of it is shown, and an entry
 * is installed only after its own declaration passed the same rules the
 * managers apply by hand. The shipped catalog is bundled rather than fetched,
 * so nothing here is installed from anywhere; it carries the shape a remote
 * catalog would have to provide, and the parser is the only door in.
 */
import { isPlugin, type Plugin } from './plugins/plugins';
import { isSkill, type Skill } from './skills';

export const MARKETPLACE_SCHEMA_VERSION = 1;
/** How many entries one catalog may hold. */
export const MAX_CATALOG_ENTRIES = 200;
export const MAX_PUBLISHER_LENGTH = 60;
export const MAX_SUMMARY_LENGTH = 512;
export const MAX_SOURCE_LABEL_LENGTH = 60;

export type MarketplaceEntry =
  | {
      readonly kind: 'plugin';
      readonly publisher: string;
      readonly summary: string;
      readonly plugin: Plugin;
    }
  | {
      readonly kind: 'skill';
      readonly publisher: string;
      readonly summary: string;
      readonly skill: Skill;
    };

export type MarketplaceCatalog = {
  readonly schemaVersion: typeof MARKETPLACE_SCHEMA_VERSION;
  /** Where the catalog came from, as a label a person can read. */
  readonly source: string;
  readonly entries: readonly MarketplaceEntry[];
};

function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

export function isPublisher(value: unknown): value is string {
  return boundedText(value, MAX_PUBLISHER_LENGTH);
}

export function isSummary(value: unknown): value is string {
  return boundedText(value, MAX_SUMMARY_LENGTH);
}

export function isMarketplaceEntry(value: unknown): value is MarketplaceEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const raw = value as Record<string, unknown>;
  if (!isPublisher(raw.publisher) || !isSummary(raw.summary)) return false;
  if (raw.kind === 'plugin') {
    return (
      Object.keys(raw).length === 4 &&
      Object.prototype.hasOwnProperty.call(raw, 'plugin') &&
      isPlugin(raw.plugin)
    );
  }
  if (raw.kind === 'skill') {
    return (
      Object.keys(raw).length === 4 &&
      Object.prototype.hasOwnProperty.call(raw, 'skill') &&
      isSkill(raw.skill)
    );
  }
  return false;
}

/** The installed id of an entry, whichever library it belongs to. */
export function marketplaceEntryId(entry: MarketplaceEntry): string {
  return entry.kind === 'plugin' ? entry.plugin.id : entry.skill.id;
}

export function marketplaceEntryName(entry: MarketplaceEntry): string {
  return entry.kind === 'plugin' ? entry.plugin.name : entry.skill.name;
}

export function marketplaceEntryVersion(entry: MarketplaceEntry): string {
  return entry.kind === 'plugin' ? entry.plugin.version : entry.skill.version;
}

/**
 * Compares two dotted numeric versions.
 *
 * Returns null when either side is not a sequence of numbers: a comparison
 * that cannot be made is not an ordering, and claiming "newer" from a label
 * like `2026-02-draft` would be a guess.
 */
export function compareVersions(left: string, right: string): number | null {
  const numeric = /^\d+(?:\.\d+)*$/u;
  if (!numeric.test(left) || !numeric.test(right)) return null;
  const a = left.split('.').map(segment => Number(segment));
  const b = right.split('.').map(segment => Number(segment));
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export type MarketplaceInstallState =
  | 'not_installed'
  | 'installed'
  | 'update_available';

/**
 * What a listing offers. A version that cannot be compared counts as
 * installed: an entry that is already there is not something to reinstall on a
 * guess.
 */
export function marketplaceInstallState(
  entry: MarketplaceEntry,
  installedVersion: string | null,
): MarketplaceInstallState {
  if (installedVersion === null) return 'not_installed';
  const order = compareVersions(marketplaceEntryVersion(entry), installedVersion);
  return order !== null && order > 0 ? 'update_available' : 'installed';
}

/**
 * The whole catalog, or null when any part of it is not installable. Refused
 * as a whole rather than filtered, for the same reason the libraries are: a
 * listing silently missing from a marketplace is worse than one that reports
 * it could not be read.
 */
export function parseMarketplaceCatalog(
  value: unknown,
): MarketplaceCatalog | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 3) return null;
  if (raw.schemaVersion !== MARKETPLACE_SCHEMA_VERSION) return null;
  if (!boundedText(raw.source, MAX_SOURCE_LABEL_LENGTH)) return null;
  if (!Array.isArray(raw.entries) || raw.entries.length > MAX_CATALOG_ENTRIES) {
    return null;
  }
  const ids = new Set<string>();
  for (const entry of raw.entries) {
    if (!isMarketplaceEntry(entry)) return null;
    const id = `${entry.kind}:${marketplaceEntryId(entry)}`;
    if (ids.has(id)) return null;
    ids.add(id);
  }
  return {
    schemaVersion: MARKETPLACE_SCHEMA_VERSION,
    source: raw.source,
    entries: raw.entries as readonly MarketplaceEntry[],
  };
}

/** Installs a plugin entry, replacing the one with the same id. */
export function installPluginEntry(
  plugins: readonly Plugin[],
  entry: MarketplaceEntry,
  upsert: (plugins: readonly Plugin[], plugin: Plugin) => readonly Plugin[],
): readonly Plugin[] {
  return entry.kind === 'plugin' ? upsert(plugins, entry.plugin) : plugins;
}

/** Installs a skill entry, replacing the one with the same id. */
export function installSkillEntry(
  skills: readonly Skill[],
  entry: MarketplaceEntry,
  upsert: (skills: readonly Skill[], skill: Skill) => readonly Skill[],
): readonly Skill[] {
  return entry.kind === 'skill' ? upsert(skills, entry.skill) : skills;
}

/**
 * The catalog this build ships with.
 *
 * Bundled, not fetched: these entries exist to be browsed and installed
 * locally, and they carry exactly the shape a remote catalog would have to
 * provide. A shipped catalog is part of the build and a person cannot fix it,
 * so a broken one fails here rather than presenting a listing it cannot read.
 */
const RELEASE_NOTES = [
  'Write release notes for this workspace.',
  '',
  '1. Read `git status` and `git diff` for the staged and unstaged changes.',
  '2. Group the changes by what a reader would care about, not by file.',
  '3. For each group: one sentence on what changed and why, then the files.',
  '4. Call out anything a reader must do before upgrading.',
  '5. Do not describe changes you did not read; say what you could not see.',
].join('\n');

const CAREFUL_REVIEW = [
  'Review the pending changes and report what you find, not what you expect.',
  '',
  '- For every changed file, say what it does now and what it did before.',
  '- Name the riskiest change and the input that would break it.',
  '- Point at every place a failure is swallowed, and say what is lost.',
  '- Check that each new branch has a test, and name the ones that do not.',
  '- Report each finding as `path:line` with one sentence, most serious first.',
  '- If a finding is a guess, mark it as one; do not list it as a fact.',
].join('\n');

const SHIPPED: unknown = {
  schemaVersion: MARKETPLACE_SCHEMA_VERSION,
  source: 'Bundled with Rish',
  entries: [
    {
      kind: 'skill',
      publisher: 'Rish',
      summary: 'Turn the pending changes in a project into release notes.',
      skill: {
        id: 'release_notes',
        name: 'Release notes',
        version: '1.0.0',
        description: 'Group pending changes into notes a reader can follow.',
        instructions: RELEASE_NOTES,
      },
    },
    {
      kind: 'skill',
      publisher: 'Rish',
      summary: 'Review a diff for risk, swallowed failures and missing tests.',
      skill: {
        id: 'careful_review',
        name: 'Careful review',
        version: '1.0.0',
        description: 'Report findings with a path and a line, worst first.',
        instructions: CAREFUL_REVIEW,
      },
    },
    {
      kind: 'plugin',
      publisher: 'Rish',
      summary: 'Declares a page-reading tool for the Agent.',
      plugin: {
        id: 'web_reader',
        name: 'Web reader',
        version: '1.0.0',
        description: 'Asks the Agent to fetch a page and read its text.',
        enabled: false,
        tools: [
          {
            name: 'fetch_page',
            description: 'Fetch one page and return its readable text.',
            capability: 'file_read',
            requiresApproval: false,
          },
        ],
      },
    },
  ],
};

function loadShippedCatalog(): MarketplaceCatalog {
  const catalog = parseMarketplaceCatalog(SHIPPED);
  if (catalog === null) throw new Error('E_MARKETPLACE_CATALOG');
  return catalog;
}

export const BUILTIN_MARKETPLACE: MarketplaceCatalog = loadShippedCatalog();

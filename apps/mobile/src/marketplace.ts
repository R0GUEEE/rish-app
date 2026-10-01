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
import { canonicalJson, sha256HexOfText } from './sha256';
import { isSkill, type Skill } from './skills';

export const MARKETPLACE_SCHEMA_VERSION = 1;
/** How many entries one catalog may hold. */
export const MAX_CATALOG_ENTRIES = 200;
export const MAX_PUBLISHER_LENGTH = 60;
export const MAX_SUMMARY_LENGTH = 512;
export const MAX_SOURCE_LABEL_LENGTH = 60;
/**
 * The most catalog text a fetch will read.
 *
 * React Native's fetch has no streaming cap, so the body is read and then
 * measured: a server that sends more than this is refused after it answered,
 * not before.
 */
export const MAX_CATALOG_BYTES = 512 * 1024;
/** How long a catalog fetch may take. */
export const CATALOG_FETCH_TIMEOUT_MS = 15_000;

export type MarketplaceEntry =
  | {
      readonly kind: 'plugin';
      readonly publisher: string;
      readonly summary: string;
      /** `sha256:<hex>` over the payload; required of a fetched catalog. */
      readonly digest?: string;
      readonly plugin: Plugin;
    }
  | {
      readonly kind: 'skill';
      readonly publisher: string;
      readonly summary: string;
      readonly digest?: string;
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

export const MARKETPLACE_DIGEST_PREFIX = 'sha256:';

const MARKETPLACE_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export function isMarketplaceDigest(value: unknown): value is string {
  return typeof value === 'string' && MARKETPLACE_DIGEST.test(value);
}

export function isMarketplaceEntry(value: unknown): value is MarketplaceEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const raw = value as Record<string, unknown>;
  if (!isPublisher(raw.publisher) || !isSummary(raw.summary)) return false;
  const names = Object.keys(raw);
  if (names.length !== 4 && names.length !== 5) return false;
  if (names.length === 5 && !isMarketplaceDigest(raw.digest)) return false;
  if (raw.kind === 'plugin') {
    return (
      Object.prototype.hasOwnProperty.call(raw, 'plugin') && isPlugin(raw.plugin)
    );
  }
  if (raw.kind === 'skill') {
    return Object.prototype.hasOwnProperty.call(raw, 'skill') && isSkill(raw.skill);
  }
  return false;
}

/**
 * The digest an entry should carry: SHA-256 over its payload written
 * canonically, so the same declaration digests the same on every device and
 * a catalog cannot be reordered into a different digest.
 */
export function marketplaceEntryDigest(entry: MarketplaceEntry): string | null {
  const payload = entry.kind === 'plugin' ? entry.plugin : entry.skill;
  const canonical = canonicalJson(payload);
  return canonical === null
    ? null
    : `${MARKETPLACE_DIGEST_PREFIX}${sha256HexOfText(canonical)}`;
}

/** Why a catalog could not be accepted, or null when it can be. */
export type RemoteCatalogRefusal =
  | 'not_https'
  | 'insecure_redirect'
  | 'network'
  | 'timeout'
  | 'too_large'
  | 'invalid_catalog'
  | 'digest_missing'
  | 'digest_mismatch';

export type RemoteCatalogResult =
  | { readonly ok: true; readonly catalog: MarketplaceCatalog }
  | { readonly ok: false; readonly reason: RemoteCatalogRefusal };

/**
 * Reads a catalog that arrived over the network.
 *
 * Every entry must carry a digest of its payload and that digest must match,
 * because a catalog is fetched from somewhere this app does not control: what
 * is installed has to be what the publisher wrote, not what a server sent.
 * One entry that fails refuses the whole catalog, as everywhere else here.
 */
export function parseRemoteCatalog(value: unknown): RemoteCatalogResult {
  const catalog = parseMarketplaceCatalog(value);
  if (catalog === null) return { ok: false, reason: 'invalid_catalog' };
  for (const entry of catalog.entries) {
    if (entry.digest === undefined) {
      return { ok: false, reason: 'digest_missing' };
    }
    if (entry.digest !== marketplaceEntryDigest(entry)) {
      return { ok: false, reason: 'digest_mismatch' };
    }
  }
  return { ok: true, catalog };
}

export type CatalogFetchOptions = {
  /** Injected so the rules can be tested without a network. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
};

function httpsURL(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Fetches a catalog over HTTPS and reads it.
 *
 * Only HTTPS is accepted, no credentials travel with the request, and a
 * redirect that lands somewhere other than HTTPS is refused rather than
 * followed into plain text. Nothing is installed here: this returns a catalog
 * that passed its digests, and the person still chooses what to take.
 */
export async function fetchRemoteCatalog(
  url: string,
  options: CatalogFetchOptions = {},
): Promise<RemoteCatalogResult> {
  const parsed = httpsURL(url.trim());
  if (parsed === null) return { ok: false, reason: 'not_https' };
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? CATALOG_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // No `redirect` option: React Native does not type one, and following is
    // its default. Where the answer came from is checked below instead.
    const response = await doFetch(parsed.toString(), {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    const finalURL = response.url ?? '';
    if (finalURL.length > 0 && httpsURL(finalURL) === null) {
      return { ok: false, reason: 'insecure_redirect' };
    }
    if (!response.ok) return { ok: false, reason: 'network' };
    const text = await response.text();
    if (text.length > MAX_CATALOG_BYTES) {
      return { ok: false, reason: 'too_large' };
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, reason: 'invalid_catalog' };
    }
    return parseRemoteCatalog(body);
  } catch (error) {
    const aborted =
      typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'AbortError';
    return { ok: false, reason: aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
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
            // A plugin brings no code of its own: the tool is a mapping onto a
            // program the guest runs inside an installed environment.
            execution: {
              kind: 'guest_program',
              environmentId: 'node',
              programPath: 'plugin-scripts/fetch_page.js',
              arguments: [],
            },
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

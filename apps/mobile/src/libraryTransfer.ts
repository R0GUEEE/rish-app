/**
 * Carrying a library between installs: the export a person can share, and the
 * import that reads one back.
 *
 * A transfer is a document, not a catalog: it holds the entries themselves
 * rather than listings of them, and it is validated as a whole before any of
 * it reaches a library. Importing merges by id -- an entry that is already
 * there is replaced, so carrying a library to a second device and carrying it
 * back does not leave two of everything.
 */
import { normalizePlugins, type Plugin } from './plugins/plugins';
import { normalizeSkills, type Skill } from './skills';

export const LIBRARY_TRANSFER_SCHEMA_VERSION = 1;
/**
 * The most text an import will read. A pasted document is held in memory and
 * parsed twice, so it is bounded well below what a message may carry.
 */
export const MAX_TRANSFER_BYTES = 256 * 1024;
export const MAX_TRANSFER_ENTRIES = 100;

export type LibraryTransfer = {
  readonly schemaVersion: typeof LIBRARY_TRANSFER_SCHEMA_VERSION;
  readonly plugins: readonly Plugin[];
  readonly skills: readonly Skill[];
};

export type LibraryTransferResult =
  | { readonly ok: true; readonly transfer: LibraryTransfer }
  | { readonly ok: false; readonly reason: TransferRefusal };

export type TransferRefusal =
  | 'not_json'
  | 'not_a_transfer'
  | 'too_large'
  | 'invalid_entry';

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) bytes += 4;
    else if (unit >= 0xdc00 && unit <= 0xdfff) bytes += 3;
    else bytes += 3;
  }
  return bytes;
}

/** Whether a document could be read at all, before it is parsed. */
export function transferWithinBounds(text: string): boolean {
  return utf8Bytes(text) <= MAX_TRANSFER_BYTES;
}

/**
 * The document to share: the libraries as they are, in a stable order.
 *
 * Entries are written in the order the libraries hold them, so exporting the
 * same library twice produces the same bytes.
 */
export function serializeLibrary(
  plugins: readonly Plugin[],
  skills: readonly Skill[],
): string {
  const document: LibraryTransfer = {
    schemaVersion: LIBRARY_TRANSFER_SCHEMA_VERSION,
    plugins: [...plugins],
    skills: [...skills],
  };
  return JSON.stringify(document, null, 2);
}

/**
 * Reads a shared library back.
 *
 * Everything is checked before anything is imported: a transfer whose schema
 * version is not this one, whose entries are not complete, or that repeats an
 * id is refused as a whole, because a library half-loaded is worse than one
 * that says it could not be read.
 */
export function parseLibraryTransfer(input: unknown): LibraryTransferResult {
  const text = typeof input === 'string' ? input : null;
  if (text !== null && !transferWithinBounds(text)) {
    return { ok: false, reason: 'too_large' };
  }
  let value: unknown = input;
  if (text !== null) {
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, reason: 'not_json' };
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'not_a_transfer' };
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 3) {
    return { ok: false, reason: 'not_a_transfer' };
  }
  if (raw.schemaVersion !== LIBRARY_TRANSFER_SCHEMA_VERSION) {
    return { ok: false, reason: 'not_a_transfer' };
  }
  const pluginEntries = raw.plugins;
  const skillEntries = raw.skills;
  if (
    !Array.isArray(pluginEntries) ||
    !Array.isArray(skillEntries) ||
    pluginEntries.length + skillEntries.length > MAX_TRANSFER_ENTRIES
  ) {
    return { ok: false, reason: 'invalid_entry' };
  }
  const plugins = normalizePlugins(pluginEntries);
  const skills = normalizeSkills(skillEntries);
  if (plugins === null || skills === null) {
    return { ok: false, reason: 'invalid_entry' };
  }
  return {
    ok: true,
    transfer: {
      schemaVersion: LIBRARY_TRANSFER_SCHEMA_VERSION,
      plugins,
      skills,
    },
  };
}

/**
 * What importing a transfer would do to each library.
 *
 * Reported rather than applied so the caller can say what happened: how many
 * entries arrived, and how many replaced the ones already there.
 */
export type LibraryMergeSummary = {
  readonly added: number;
  readonly replaced: number;
};

export function summarizeLibraryMerge(
  existing: readonly { readonly id: string }[],
  incoming: readonly { readonly id: string }[],
): LibraryMergeSummary {
  const known = new Set(existing.map(entry => entry.id));
  let added = 0;
  let replaced = 0;
  for (const entry of incoming) {
    if (known.has(entry.id)) replaced += 1;
    else added += 1;
  }
  return { added, replaced };
}

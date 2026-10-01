import {
  LIBRARY_TRANSFER_SCHEMA_VERSION,
  MAX_TRANSFER_BYTES,
  MAX_TRANSFER_ENTRIES,
  parseLibraryTransfer,
  serializeLibrary,
  summarizeLibraryMerge,
  transferWithinBounds,
} from '../src/libraryTransfer';
import type { Plugin } from '../src/plugins/plugins';
import type { Skill } from '../src/skills';

const skill = (id: string, version = '1.0.0'): Skill => ({
  id,
  name: `Skill ${id}`,
  version,
  description: 'A skill.',
  instructions: 'Do the thing.',
});

const plugin = (id: string, version = '1.0.0'): Plugin => ({
  id,
  name: `Plugin ${id}`,
  version,
  description: 'A plugin.',
  enabled: false,
  tools: [
    {
      name: 'fetch_page',
      description: 'Fetch a page.',
      capability: 'file_read',
      requiresApproval: false,
    },
  ],
});

describe('exporting a library', () => {
  test('the document carries both libraries, in the order they are held', () => {
    const text = serializeLibrary([plugin('one')], [skill('a'), skill('b')]);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(LIBRARY_TRANSFER_SCHEMA_VERSION);
    expect((parsed.plugins as unknown[]).length).toBe(1);
    expect((parsed.skills as unknown[]).length).toBe(2);
  });

  test('exporting the same library twice produces the same bytes', () => {
    const first = serializeLibrary([plugin('one')], [skill('a')]);
    const second = serializeLibrary([plugin('one')], [skill('a')]);
    expect(first).toBe(second);
  });

  test('an empty library is still a document', () => {
    const result = parseLibraryTransfer(serializeLibrary([], []));
    expect(result).toEqual({
      ok: true,
      transfer: { schemaVersion: LIBRARY_TRANSFER_SCHEMA_VERSION, plugins: [], skills: [] },
    });
  });
});

describe('importing a library', () => {
  test('a shared document round-trips through the parser', () => {
    const text = serializeLibrary([plugin('one')], [skill('a')]);
    const result = parseLibraryTransfer(text);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.transfer.plugins[0]!.id).toBe('one');
    expect(result.transfer.skills[0]!.id).toBe('a');
  });

  test('what cannot be read is refused for the reason it could not be', () => {
    const notJson = parseLibraryTransfer('{oops');
    expect(notJson).toEqual({ ok: false, reason: 'not_json' });

    const wrongVersion = parseLibraryTransfer(
      JSON.stringify({ schemaVersion: 99, plugins: [], skills: [] }),
    );
    expect(wrongVersion).toEqual({ ok: false, reason: 'not_a_transfer' });

    const wrongShape = parseLibraryTransfer(
      JSON.stringify({ schemaVersion: LIBRARY_TRANSFER_SCHEMA_VERSION, plugins: [] }),
    );
    expect(wrongShape).toEqual({ ok: false, reason: 'not_a_transfer' });

    // One entry the library would refuse refuses the whole document.
    const broken = parseLibraryTransfer(
      JSON.stringify({
        schemaVersion: LIBRARY_TRANSFER_SCHEMA_VERSION,
        plugins: [],
        skills: [skill('a'), { ...skill('a'), name: '' }],
      }),
    );
    expect(broken).toEqual({ ok: false, reason: 'invalid_entry' });

    const repeated = parseLibraryTransfer(
      JSON.stringify({
        schemaVersion: LIBRARY_TRANSFER_SCHEMA_VERSION,
        plugins: [],
        skills: [skill('a'), skill('a')],
      }),
    );
    expect(repeated).toEqual({ ok: false, reason: 'invalid_entry' });
  });

  test('a document too large to read is refused before it is parsed', () => {
    expect(transferWithinBounds('x'.repeat(MAX_TRANSFER_BYTES))).toBe(true);
    expect(transferWithinBounds('x'.repeat(MAX_TRANSFER_BYTES + 1))).toBe(false);
    expect(parseLibraryTransfer('x'.repeat(MAX_TRANSFER_BYTES + 1))).toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  test('more entries than a library could hold is refused', () => {
    const tooMany = {
      schemaVersion: LIBRARY_TRANSFER_SCHEMA_VERSION,
      plugins: [],
      skills: Array.from({ length: MAX_TRANSFER_ENTRIES + 1 }, (_, index) =>
        skill(`s${index}`),
      ),
    };
    expect(parseLibraryTransfer(JSON.stringify(tooMany))).toEqual({
      ok: false,
      reason: 'invalid_entry',
    });
  });
});

describe('merging an imported library', () => {
  test('an id that is already there is replaced, a new one is added', () => {
    const summary = summarizeLibraryMerge(
      [{ id: 'one' }, { id: 'two' }],
      [{ id: 'two' }, { id: 'three' }],
    );
    expect(summary).toEqual({ added: 1, replaced: 1 });
  });

  test('nothing arriving is nothing to report', () => {
    expect(summarizeLibraryMerge([{ id: 'one' }], [])).toEqual({
      added: 0,
      replaced: 0,
    });
  });
});

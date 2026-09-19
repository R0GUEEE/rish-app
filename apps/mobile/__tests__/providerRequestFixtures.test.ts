import {
  isHarnessId,
  providerForHarness,
  type HarnessId,
} from '../src/harness/types';

declare const __dirname: string;

const nodeFs = jest.requireActual('node:fs') as {
  readFileSync(path: string, encoding: 'utf8'): string;
};
const nodePath = jest.requireActual('node:path') as {
  resolve(...paths: string[]): string;
};
const nodeCrypto = jest.requireActual('node:crypto') as {
  createHash(algorithm: string): {
    update(data: string, encoding: 'utf8'): { digest(encoding: 'hex'): string };
  };
};

/**
 * The frozen request bodies, shared with the native suites
 * (ProviderRequestFixtureTests.mm builds each one through its transport, and
 * Android replays the same fixture through its own). jest owns the contract
 * of the fixture itself: that every case records a digest of exactly the
 * body beside it, under exactly the encoding a receipt binds.
 *
 * That encoding is not this project's canonical JSON. It is sorted keys with
 * a forward slash written as an escape, which is what NSJSONSerialization
 * does and what the shipped receipts therefore contain. Re-deriving it here,
 * in a third language, is the point: a host that quietly writes a slash
 * plainly would record a different digest for the same round, and nothing
 * else in the suite would notice.
 */
const FIXTURES: ReadonlyArray<{ readonly file: string; readonly harnessId: HarnessId }> = [
  { file: 'deepseek-request-cases.json', harnessId: 'dsh' },
];

const THINKING_MODES = new Set(['off', 'high', 'max']);

type RequestCase = {
  readonly name: string;
  readonly model: string;
  readonly thinking_mode: string;
  readonly streaming: boolean;
  readonly messages: readonly Record<string, unknown>[];
  readonly tools: readonly Record<string, unknown>[];
  readonly body: Record<string, unknown>;
  readonly body_sha256: string;
};

function loadFixture(file: string): {
  readonly schema_version: number;
  readonly harness_id: string;
  readonly provider: string;
  readonly note: string;
  readonly cases: readonly RequestCase[];
} {
  const path = nodePath.resolve(__dirname, '../ios/RishTests/Fixtures', file);
  return JSON.parse(nodeFs.readFileSync(path, 'utf8'));
}

/** Sorted keys, compact, and a forward slash escaped. */
function receiptEncoding(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value).replace(/\//g, '\\/');
  if (Array.isArray(value)) return `[${value.map(receiptEncoding).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>).sort();
    return `{${entries
      .map(key => `${receiptEncoding(key)}:${receiptEncoding((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  throw new Error(`unsupported value: ${String(value)}`);
}

describe.each(FIXTURES)('frozen $file', ({ file, harnessId }) => {
  const fixture = loadFixture(file);

  test('names its harness and provider through the catalog', () => {
    expect(fixture.schema_version).toBe(1);
    expect(isHarnessId(fixture.harness_id)).toBe(true);
    expect(fixture.harness_id).toBe(harnessId);
    expect(fixture.provider).toBe(providerForHarness(harnessId));
    // The note is what tells the next reader why the digest is not the
    // canonical JSON they will reach for first.
    expect(fixture.note).toContain('slash');
  });

  test('records every case once, with an input a host can replay', () => {
    const names = fixture.cases.map(entry => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(3);
    for (const entry of fixture.cases) {
      expect(entry.model.length).toBeGreaterThan(0);
      expect(THINKING_MODES.has(entry.thinking_mode)).toBe(true);
      expect(typeof entry.streaming).toBe('boolean');
      expect(entry.messages.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.tools)).toBe(true);
      expect(entry.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('every digest is of the body recorded beside it', () => {
    for (const entry of fixture.cases) {
      const digest = nodeCrypto
        .createHash('sha256')
        .update(receiptEncoding(entry.body), 'utf8')
        .digest('hex');
      expect({ case: entry.name, digest }).toEqual({
        case: entry.name,
        digest: entry.body_sha256,
      });
    }
  });

  test('the body says back what the case asked for', () => {
    for (const entry of fixture.cases) {
      expect(entry.body.model).toBe(entry.model);
      expect(entry.body.stream).toBe(entry.streaming);
      expect(entry.body.messages).toEqual(entry.messages);
      if (entry.tools.length === 0) {
        expect(entry.body.tools).toBeUndefined();
      } else {
        expect(entry.body.tools).toEqual(entry.tools);
      }
    }
  });

  /**
   * The token ceiling is not one number. A round with tools has to be able to
   * return a whole file in its arguments, and a thinking round needs room for
   * the reasoning on top of that -- so it is four numbers, and a host that
   * picks one of them truncates the other three cases.
   */
  test('the token ceiling follows the round, not a constant', () => {
    const ceilings = new Map(
      fixture.cases.map(entry => [
        `${entry.tools.length > 0 ? 'tools' : 'plain'}/${entry.thinking_mode === 'off' ? 'off' : 'thinking'}`,
        entry.body.max_tokens,
      ]),
    );
    expect(ceilings.get('plain/off')).toBe(1024);
    expect(ceilings.get('plain/thinking')).toBe(4096);
    expect(ceilings.get('tools/off')).toBe(8192);
    expect(ceilings.get('tools/thinking')).toBe(16384);
  });

  test('a thinking round says so twice, and an unthinking one not at all', () => {
    for (const entry of fixture.cases) {
      const thinking = entry.body.thinking as { type: string };
      if (entry.thinking_mode === 'off') {
        expect(thinking).toEqual({ type: 'disabled' });
        expect(entry.body.reasoning_effort).toBeUndefined();
      } else {
        expect(thinking).toEqual({ type: 'enabled' });
        expect(entry.body.reasoning_effort).toBe(entry.thinking_mode);
      }
    }
  });
});

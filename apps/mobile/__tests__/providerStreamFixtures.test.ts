import {
  HARNESS_IDS,
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

/**
 * The recorded provider streams are shared with the native suite
 * (ProviderStreamFixtureTests.mm replays them through each SSE parser).
 * jest owns the contract of the fixture itself: which cases every provider
 * must record and which delta vocabulary a recorded case may expect, so a
 * provider dialect can never widen what reaches the streaming listener.
 */
const FINISH_REASONS = new Set(['stop', 'tool_calls', 'length', 'content_filter']);
const REQUIRED_CASES = [
  'text_stream',
  'tool_call_round',
  'event_split_across_chunks',
  'truncated_tail',
];
const FIXTURES: ReadonlyArray<{ readonly file: string; readonly harnessId: HarnessId }> = [
  { file: 'deepseek-stream-cases.json', harnessId: 'dsh' },
  { file: 'claude-stream-cases.json', harnessId: 'claude-code' },
  { file: 'codex-stream-cases.json', harnessId: 'codex' },
  { file: 'glm-stream-cases.json', harnessId: 'glm' },
];

type StreamCase = {
  readonly name: string;
  readonly chunks: readonly string[];
  readonly expected: readonly Record<string, unknown>[];
  readonly error: boolean;
};

function loadFixture(file: string): {
  readonly schema_version: number;
  readonly harness_id: string;
  readonly provider: string;
  readonly dialect: string;
  readonly cases: readonly StreamCase[];
} {
  const path = nodePath.resolve(__dirname, '../ios/RishTests/Fixtures', file);
  return JSON.parse(nodeFs.readFileSync(path, 'utf8'));
}

describe.each(FIXTURES)('recorded $file', ({ file, harnessId }) => {
  const fixture = loadFixture(file);

  test('names its harness and provider through the catalog', () => {
    expect(fixture.schema_version).toBe(1);
    expect(isHarnessId(fixture.harness_id)).toBe(true);
    expect(fixture.harness_id).toBe(harnessId);
    expect(fixture.provider).toBe(providerForHarness(harnessId));
    expect(fixture.dialect.length).toBeGreaterThan(0);
  });

  test('records every required scenario exactly once', () => {
    const names = fixture.cases.map(entry => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const required of REQUIRED_CASES) expect(names).toContain(required);
    expect(names.some(name => name.includes('reasoning') || name.includes('thinking'))).toBe(true);
    expect(fixture.cases.filter(entry => entry.error).length).toBeGreaterThan(0);
  });

  test.each(fixture.cases.map(entry => [entry.name, entry] as const))(
    'case %s stays inside the delta vocabulary',
    (_name, entry) => {
      expect(entry.chunks.length).toBeGreaterThan(0);
      for (const chunk of entry.chunks) {
        expect(typeof chunk).toBe('string');
        expect(chunk.length).toBeGreaterThan(0);
      }
      if (entry.error) {
        expect(entry.expected).toEqual([]);
        return;
      }
      let finished = false;
      let done = false;
      for (const delta of entry.expected) {
        expect(done).toBe(false);
        const keys = Object.keys(delta).sort();
        if (delta.type === 'done') {
          expect(keys).toEqual(['type']);
          done = true;
          continue;
        }
        expect(delta.type).toBe('delta');
        expect(finished).toBe(false);
        const payload = keys.filter(key => key !== 'type');
        expect(payload.length).toBeGreaterThan(0);
        for (const key of payload) {
          expect(['content', 'reasoning', 'finish_reason', 'tool_calls']).toContain(key);
          if (key === 'tool_calls') {
            // Streamed tool-call fragments: {index, id?, name?, arguments?},
            // assembled natively into the round's validated tool calls.
            const fragments = delta[key];
            expect(Array.isArray(fragments)).toBe(true);
            expect((fragments as unknown[]).length).toBeGreaterThan(0);
            expect((fragments as unknown[]).length).toBeLessThanOrEqual(16);
            for (const fragment of fragments as Record<string, unknown>[]) {
              const fragmentKeys = Object.keys(fragment).sort();
              expect(fragmentKeys).toContain('index');
              expect(Number.isInteger(fragment.index)).toBe(true);
              expect(fragment.index as number).toBeGreaterThanOrEqual(0);
              expect(fragment.index as number).toBeLessThanOrEqual(15);
              for (const fragmentKey of fragmentKeys.filter(item => item !== 'index')) {
                expect(['id', 'name', 'arguments']).toContain(fragmentKey);
                expect(typeof fragment[fragmentKey]).toBe('string');
                expect((fragment[fragmentKey] as string).length).toBeGreaterThan(0);
              }
            }
            continue;
          }
          expect(typeof delta[key]).toBe('string');
          expect((delta[key] as string).length).toBeGreaterThan(0);
        }
        if (typeof delta.finish_reason === 'string') {
          expect(FINISH_REASONS.has(delta.finish_reason)).toBe(true);
          finished = true;
        }
      }
    },
  );
});

test('every built-in harness has a recorded stream fixture', () => {
  expect(FIXTURES.map(entry => entry.harnessId).sort()).toEqual([...HARNESS_IDS].sort());
});

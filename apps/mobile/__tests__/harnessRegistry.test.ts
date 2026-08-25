import {
  BUILTIN_HARNESSES,
  DSH_HARNESS,
  createHarnessRegistry,
  type HarnessManifest,
} from '../src/harness';

test('registers DSH as the first built-in Rish harness', () => {
  expect(BUILTIN_HARNESSES.list()).toEqual([DSH_HARNESS]);
  expect(BUILTIN_HARNESSES.get('dsh')?.runtime).toEqual({
    kind: 'native-adapter',
    entrypoint: 'DshHarnessAdapter',
  });
  expect(BUILTIN_HARNESSES.get('dsh')?.capabilities).toContain('workspace');
});

test('accepts a valid custom rish-guest harness manifest', () => {
  const custom: HarnessManifest = {
    schemaVersion: 1,
    id: 'example-harness',
    name: 'Example',
    version: '1.0.0',
    description: 'A local test harness.',
    builtin: false,
    runtime: { kind: 'rish-guest', entrypoint: '/opt/example/run' },
    capabilities: ['chat', 'tools', 'guest-runtime'],
    credentials: [],
    models: [
      { id: 'example-model', name: 'Example Model', inputModalities: ['text'] },
    ],
  };

  const registry = createHarnessRegistry([DSH_HARNESS, custom]);
  expect(registry.has('example-harness')).toBe(true);
  expect(registry.get('example-harness')?.runtime.kind).toBe('rish-guest');
});

test('rejects duplicate ids and malformed manifests', () => {
  expect(() => createHarnessRegistry([DSH_HARNESS, DSH_HARNESS])).toThrow(
    /duplicate harness id/,
  );
  expect(() =>
    createHarnessRegistry([{ ...DSH_HARNESS, id: '../escape' }]),
  ).toThrow(/invalid harness id/);
});

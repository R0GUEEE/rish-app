import {
  BUILTIN_HARNESSES,
  CLAUDE_CODE_HARNESS,
  CODEX_HARNESS,
  DSH_HARNESS,
  createHarnessRegistry,
  type HarnessManifest,
} from '../src/harness';

test('registers the three executable built-in Rish harnesses', () => {
  expect(BUILTIN_HARNESSES.list()).toEqual([
    DSH_HARNESS,
    CLAUDE_CODE_HARNESS,
    CODEX_HARNESS,
  ]);
  expect(BUILTIN_HARNESSES.get('dsh')?.runtime).toEqual({
    kind: 'native-adapter',
    entrypoint: 'DshHarnessAdapter',
  });
  expect(BUILTIN_HARNESSES.get('dsh')?.capabilities).toContain('workspace');
  expect(BUILTIN_HARNESSES.get('claude-code')?.runtime).toEqual({
    kind: 'native-adapter',
    entrypoint: 'ClaudeCodeHarnessAdapter',
  });
  expect(BUILTIN_HARNESSES.get('claude-code')?.capabilities).toContain(
    'reasoning',
  );
  expect(BUILTIN_HARNESSES.get('codex')?.runtime).toEqual({
    kind: 'native-adapter',
    entrypoint: 'CodexHarnessAdapter',
  });
  expect(BUILTIN_HARNESSES.get('codex')?.capabilities).toContain('tools');
});

test('exposes provider credential slots keyed by Keychain account', () => {
  expect(DSH_HARNESS.credentials).toEqual([
    {
      id: 'deepseek-api-key',
      keychainAccount: 'DEEPSEEK_API_KEY',
      label: 'DeepSeek API key',
      secret: true,
    },
  ]);
  expect(CLAUDE_CODE_HARNESS.credentials).toEqual([
    {
      id: 'anthropic-api-key',
      keychainAccount: 'ANTHROPIC_API_KEY',
      label: 'Anthropic API key',
      secret: true,
    },
  ]);
  expect(CODEX_HARNESS.credentials).toEqual([
    {
      id: 'openai-api-key',
      keychainAccount: 'OPENAI_API_KEY',
      label: 'OpenAI API key',
      secret: true,
    },
  ]);
});

test('catalogs the requested provider model families', () => {
  expect(CLAUDE_CODE_HARNESS.models.map(model => model.id)).toEqual([
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-haiku-4-5-20251001',
    'claude-fable-5-1',
  ]);
  expect(CODEX_HARNESS.models.map(model => model.id)).toEqual([
    'gpt-5.6',
    'gpt-5.6-mini',
    'gpt-5.6-nano',
  ]);
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

import { getDshCatalog } from '../models/catalog';
import type { HarnessManifest } from './types';
import { createHarnessRegistry } from './registry';

export const DSH_HARNESS: HarnessManifest = {
  schemaVersion: 1,
  id: 'dsh',
  name: 'DSH',
  version: 'builtin',
  description: 'DeepSeek Harness with native DeepSeek transport.',
  builtin: true,
  runtime: { kind: 'native-adapter', entrypoint: 'DshHarnessAdapter' },
  capabilities: ['chat', 'reasoning', 'image-input', 'tools', 'workspace'],
  credentials: [
    {
      id: 'deepseek-api-key',
      keychainAccount: 'DEEPSEEK_API_KEY',
      label: 'DeepSeek API key',
      secret: true,
    },
  ],
  get models() { return getDshCatalog().models.map(m => ({ id: m.id, name: m.name, inputModalities: m.supports_images ? ['text', 'image'] as const : ['text'] as const })); },
};

export const CLAUDE_CODE_HARNESS: HarnessManifest = {
  schemaVersion: 1,
  id: 'claude-code',
  name: 'Claude Code',
  version: 'builtin',
  description:
    'Anthropic Claude Code harness with native Messages API transport.',
  builtin: true,
  runtime: { kind: 'native-adapter', entrypoint: 'ClaudeCodeHarnessAdapter' },
  capabilities: ['chat', 'reasoning', 'tools', 'workspace'],
  credentials: [
    {
      id: 'anthropic-api-key',
      keychainAccount: 'ANTHROPIC_API_KEY',
      label: 'Anthropic API key',
      secret: true,
    },
  ],
  models: [
    {
      id: 'claude-sonnet-5',
      name: 'Sonnet 5',
      inputModalities: ['text'],
    },
    {
      id: 'claude-opus-5',
      name: 'Opus 5',
      inputModalities: ['text'],
    },
    {
      id: 'claude-haiku-4-5-20251001',
      name: 'Haiku 4.5',
      inputModalities: ['text'],
    },
    {
      id: 'claude-fable-5-1',
      name: 'Fable 5.1',
      inputModalities: ['text'],
    },
  ],
};

export const CODEX_HARNESS: HarnessManifest = {
  schemaVersion: 1,
  id: 'codex',
  name: 'Codex',
  version: 'builtin',
  description: 'OpenAI Codex harness with native Responses API transport.',
  builtin: true,
  runtime: { kind: 'native-adapter', entrypoint: 'CodexHarnessAdapter' },
  capabilities: ['chat', 'reasoning', 'tools', 'workspace'],
  credentials: [
    {
      id: 'openai-api-key',
      keychainAccount: 'OPENAI_API_KEY',
      label: 'OpenAI API key',
      secret: true,
    },
  ],
  models: [
    {
      id: 'gpt-5.6',
      name: 'GPT-5.6',
      inputModalities: ['text'],
    },
    {
      id: 'gpt-5.6-mini',
      name: 'GPT-5.6 Mini',
      inputModalities: ['text'],
    },
    {
      id: 'gpt-5.6-nano',
      name: 'GPT-5.6 Nano',
      inputModalities: ['text'],
    },
  ],
};

export const GLM_HARNESS: HarnessManifest = {
  schemaVersion: 1,
  id: 'glm',
  name: 'GLM',
  version: 'builtin',
  description:
    'Zhipu GLM harness over the Anthropic-compatible Messages transport.',
  builtin: true,
  runtime: { kind: 'native-adapter', entrypoint: 'GlmHarnessAdapter' },
  capabilities: ['chat', 'reasoning', 'tools', 'workspace'],
  credentials: [
    {
      id: 'bigmodel-api-key',
      keychainAccount: 'BIGMODEL_API_KEY',
      label: 'Zhipu GLM API key',
      secret: true,
    },
  ],
  models: [
    {
      id: 'GLM-5.3',
      name: 'GLM-5.3',
      inputModalities: ['text'],
    },
    {
      id: 'GLM-5.3-Flash',
      name: 'GLM-5.3 Flash',
      inputModalities: ['text'],
    },
  ],
};

export const BUILTIN_HARNESSES = createHarnessRegistry([
  DSH_HARNESS,
  CLAUDE_CODE_HARNESS,
  CODEX_HARNESS,
  GLM_HARNESS,
]);

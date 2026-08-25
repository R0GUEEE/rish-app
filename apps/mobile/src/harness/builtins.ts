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
    { id: 'deepseek-api-key', label: 'DeepSeek API key', secret: true },
  ],
  models: [
    {
      id: 'deepseek-v4-flash',
      name: 'V4 Flash',
      inputModalities: ['text'],
    },
    {
      id: 'deepseek-v4-pro',
      name: 'V4 Pro',
      inputModalities: ['text'],
    },
    {
      id: 'deepseek-v4-flash-vision-exp',
      name: 'Flash Exp',
      inputModalities: ['text', 'image'],
    },
  ],
};

export const BUILTIN_HARNESSES = createHarnessRegistry([DSH_HARNESS]);

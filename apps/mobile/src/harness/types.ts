export const HARNESS_MANIFEST_SCHEMA_VERSION = 1 as const;

export const HARNESS_IDS = ['dsh', 'claude-code', 'codex'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export function isHarnessId(value: unknown): value is HarnessId {
  return (
    typeof value === 'string' &&
    (HARNESS_IDS as readonly string[]).includes(value)
  );
}

export const DEEPSEEK_MODEL_IDS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash-vision-exp',
] as const;
export type DeepSeekModelId = (typeof DEEPSEEK_MODEL_IDS)[number];

export function isDeepSeekModelId(value: unknown): value is DeepSeekModelId {
  return (
    typeof value === 'string' &&
    (DEEPSEEK_MODEL_IDS as readonly string[]).includes(value)
  );
}

export const CLAUDE_MODEL_IDS = [
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-haiku-4-5-20251001',
  'claude-fable-5-1',
] as const;
export type ClaudeModelId = (typeof CLAUDE_MODEL_IDS)[number];

/** The gpt-5.6 family catalog; ids are configurable in the manifest. */
export const CODEX_MODEL_IDS = [
  'gpt-5.6',
  'gpt-5.6-mini',
  'gpt-5.6-nano',
] as const;
export type CodexModelId = (typeof CODEX_MODEL_IDS)[number];

export type HarnessModelId = DeepSeekModelId | ClaudeModelId | CodexModelId;

export const PROVIDER_MODEL_IDS = [
  ...DEEPSEEK_MODEL_IDS,
  ...CLAUDE_MODEL_IDS,
  ...CODEX_MODEL_IDS,
] as const;

export function isHarnessModelId(value: unknown): value is HarnessModelId {
  return (
    typeof value === 'string' &&
    (PROVIDER_MODEL_IDS as readonly string[]).includes(value)
  );
}

/**
 * Provider identity behind each built-in Harness. The provider id and host
 * travel inside project-context consent receipts and runtime proof so the
 * record names the API that actually served a round; the native catalog
 * (RishHarnessCatalog.mm) keeps the same tables.
 */
export const PROVIDER_IDS = ['deepseek', 'anthropic', 'openai'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_HOSTS = {
  deepseek: 'api.deepseek.com',
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
} as const satisfies Record<ProviderId, string>;
export type ProviderHost = (typeof PROVIDER_HOSTS)[ProviderId];

export function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === 'string' &&
    (PROVIDER_IDS as readonly string[]).includes(value)
  );
}

export function isProviderHost(value: unknown): value is ProviderHost {
  return (
    typeof value === 'string' &&
    (Object.values(PROVIDER_HOSTS) as readonly string[]).includes(value)
  );
}

export function harnessForModel(model: HarnessModelId): HarnessId {
  if ((DEEPSEEK_MODEL_IDS as readonly string[]).includes(model)) return 'dsh';
  if ((CLAUDE_MODEL_IDS as readonly string[]).includes(model)) {
    return 'claude-code';
  }
  return 'codex';
}

export function providerForHarness(harnessId: HarnessId): ProviderId {
  switch (harnessId) {
    case 'dsh':
      return 'deepseek';
    case 'claude-code':
      return 'anthropic';
    case 'codex':
      return 'openai';
  }
}

export function providerForModel(model: HarnessModelId): ProviderId {
  return providerForHarness(harnessForModel(model));
}

export function providerHostForModel(model: HarnessModelId): ProviderHost {
  return PROVIDER_HOSTS[providerForModel(model)];
}

/**
 * Keychain accounts shared with the native runtime. The account is the
 * credential slot identifier; the Keychain service name is owned by the
 * generic runtime and never changes.
 */
export const CREDENTIAL_SLOTS = [
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const;
export type CredentialSlot = (typeof CREDENTIAL_SLOTS)[number];

export function isCredentialSlot(value: unknown): value is CredentialSlot {
  return (
    typeof value === 'string' &&
    (CREDENTIAL_SLOTS as readonly string[]).includes(value)
  );
}

export type HarnessCapability =
  | 'chat'
  | 'reasoning'
  | 'image-input'
  | 'tools'
  | 'workspace'
  | 'guest-runtime';

export type HarnessRuntime =
  | { readonly kind: 'native-adapter'; readonly entrypoint: string }
  | { readonly kind: 'rish-guest'; readonly entrypoint: string };

export type HarnessModel = {
  /** Provider model id; the builtin catalogs use the fixed unions above, custom manifests may use any registry-validated id. */
  readonly id: string;
  readonly name: string;
  readonly inputModalities: readonly ('text' | 'image')[];
};

export type HarnessCredentialSlot = {
  readonly id: string;
  /** Keychain account (credential slot) the native runtime keys this value by. */
  readonly keychainAccount: CredentialSlot;
  readonly label: string;
  readonly secret: true;
};

export type HarnessManifest = {
  readonly schemaVersion: typeof HARNESS_MANIFEST_SCHEMA_VERSION;
  /** Stable harness id; the three builtins are HarnessId, custom manifests use any registry-validated id. */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly builtin: boolean;
  readonly runtime: HarnessRuntime;
  readonly capabilities: readonly HarnessCapability[];
  readonly credentials: readonly HarnessCredentialSlot[];
  readonly models: readonly HarnessModel[];
};

export type HarnessRegistry = {
  list(): readonly HarnessManifest[];
  get(id: string): HarnessManifest | undefined;
  has(id: string): boolean;
};

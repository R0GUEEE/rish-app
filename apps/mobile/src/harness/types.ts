export const HARNESS_MANIFEST_SCHEMA_VERSION = 1 as const;

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
  readonly id: string;
  readonly name: string;
  readonly inputModalities: readonly ('text' | 'image')[];
};

export type HarnessCredentialSlot = {
  readonly id: string;
  readonly label: string;
  readonly secret: true;
};

export type HarnessManifest = {
  readonly schemaVersion: typeof HARNESS_MANIFEST_SCHEMA_VERSION;
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

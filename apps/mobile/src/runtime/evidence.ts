import { Platform } from 'react-native';

type RuntimeGlobals = typeof globalThis & {
  HermesInternal?: unknown;
  nativeFabricUIManager?: unknown;
};

export type RuntimeEvidence = {
  platform: string;
  renderer: string;
  engine: string;
  dshCore: string;
  execution: string;
};

export function readRuntimeEvidence(): RuntimeEvidence {
  const runtime = globalThis as RuntimeGlobals;

  return {
    platform: `${Platform.OS} ${String(Platform.Version)}`,
    renderer: runtime.nativeFabricUIManager ? 'Fabric' : 'Legacy renderer',
    engine: runtime.HermesInternal ? 'Hermes' : 'JavaScriptCore',
    dshCore: 'Not linked',
    execution: 'rish pending',
  };
}

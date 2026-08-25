import { NativeModules } from 'react-native';

import type { MirrorPreferences } from '../preferences';

export type MirrorApplyEntry = {
  category: 'alpine' | 'pip' | 'npm';
  enabled: boolean;
  base_url: string;
  logical_path: string;
};

export type MirrorApplyResult = {
  schema_version: 1;
  status: 'staged';
  staged_at: string;
  guest_runtime_mounted: false;
  root: 'rish-guest-overlay';
  entries: MirrorApplyEntry[];
};

type NativeLocalMirrors = {
  applyMirrors(mirrors: MirrorPreferences): Promise<MirrorApplyResult>;
  mirrorStatus(): Promise<MirrorApplyResult | null>;
};

const native = NativeModules.LocalMirrors as unknown;

function hasNativeCapabilities(value: unknown): value is NativeLocalMirrors {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<NativeLocalMirrors>;
  return (
    typeof candidate.applyMirrors === 'function' &&
    typeof candidate.mirrorStatus === 'function'
  );
}

function required(): NativeLocalMirrors {
  if (!hasNativeCapabilities(native)) {
    throw new Error('LocalMirrors native module is not linked');
  }
  return native;
}

export const LocalMirrors = {
  isAvailable: () => hasNativeCapabilities(native),
  apply: (mirrors: MirrorPreferences) => required().applyMirrors(mirrors),
  status: () => required().mirrorStatus(),
};

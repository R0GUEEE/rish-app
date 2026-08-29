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
  /**
   * True only while a LocalGuestModule session is genuinely booted in this
   * process. It does NOT mean the staged mirror configuration below reached
   * the guest: the interpreter has no block-device injection, so the guest
   * keeps using the offline repository baked into its initramfs at build
   * time. See docs/mobile-guest-runtime.md.
   */
  guest_runtime_mounted: boolean;
  staged_config_enters_guest: false;
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

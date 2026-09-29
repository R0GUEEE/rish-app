import { NativeModules } from 'react-native';

/** What build and device a diagnostic report comes from. */
export type BuildInfo = {
  readonly build: string;
  readonly platform: string;
  readonly os: string;
  readonly api?: number;
  readonly device: string;
};

type DiagnosticsNative = {
  copyText?: (text: string) => Promise<unknown>;
  buildInfo?: () => Promise<unknown>;
};

const native = (): DiagnosticsNative | null =>
  (NativeModules.LocalRuntime as DiagnosticsNative | undefined) ?? null;

const bounded = (value: unknown, maximum = 80): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null;

/**
 * Puts text on the clipboard through the native module. A build without the
 * method, or one that refuses, answers false: copying a report is never
 * allowed to fail the screen that offers it.
 */
export async function copyText(text: string): Promise<boolean> {
  const method = native()?.copyText;
  if (typeof method !== 'function') return false;
  try {
    return (await method(text)) === true;
  } catch {
    return false;
  }
}

export async function buildInfo(): Promise<BuildInfo | null> {
  const method = native()?.buildInfo;
  if (typeof method !== 'function') return null;
  try {
    const raw = await method();
    if (typeof raw !== 'object' || raw === null) return null;
    const value = raw as Record<string, unknown>;
    const build = bounded(value.build);
    const platform = bounded(value.platform);
    if (build === null || platform === null) return null;
    const api = typeof value.api === 'number' && Number.isSafeInteger(value.api) ? value.api : undefined;
    return {
      build,
      platform,
      os: bounded(value.os) ?? '?',
      ...(api === undefined ? {} : { api }),
      device: bounded(value.device) ?? '?',
    };
  } catch {
    return null;
  }
}

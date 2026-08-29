import { NativeModules } from 'react-native';

export type GuestBootReceipt = {
  schema_version: 1;
  status: 'booted';
  boot_ms: number;
  memory_mib: number;
  /** Bundle-relative resource names — never absolute container paths. */
  kernel: string;
  initramfs: string;
  kernel_sha256: string;
  initramfs_sha256: string;
};

export type GuestExecReceipt = {
  schema_version: 1;
  ok: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  /** Guest instruction count at boot, reported by the session FFI. */
  boot_units?: number;
};

export type GuestShutdownReceipt = {
  schema_version: 1;
  status: 'shutdown' | 'already_idle' | 'shutdown_scheduled';
};

export type GuestErrorCode =
  | 'E_GUEST_INVALID_REQUEST'
  | 'E_GUEST_ASSETS_MISSING'
  | 'E_GUEST_ASSET_INTEGRITY'
  | 'E_GUEST_BOOT_IN_PROGRESS'
  | 'E_GUEST_ALREADY_BOOTED'
  | 'E_GUEST_NOT_BOOTED'
  | 'E_GUEST_BOOT_FAILED'
  | 'E_GUEST_BOOT_CANCELLED'
  | 'E_GUEST_EXEC_FAILED'
  | 'E_GUEST_UNAVAILABLE'
  | 'E_GUEST_NATIVE';

const GUEST_ERROR_CODES: readonly GuestErrorCode[] = [
  'E_GUEST_INVALID_REQUEST',
  'E_GUEST_ASSETS_MISSING',
  'E_GUEST_ASSET_INTEGRITY',
  'E_GUEST_BOOT_IN_PROGRESS',
  'E_GUEST_ALREADY_BOOTED',
  'E_GUEST_NOT_BOOTED',
  'E_GUEST_BOOT_FAILED',
  'E_GUEST_BOOT_CANCELLED',
  'E_GUEST_EXEC_FAILED',
  'E_GUEST_UNAVAILABLE',
  'E_GUEST_NATIVE',
];

function isGuestErrorCode(value: unknown): value is GuestErrorCode {
  return (
    typeof value === 'string' &&
    (GUEST_ERROR_CODES as readonly string[]).includes(value)
  );
}

export class GuestBridgeError extends Error {
  readonly code: GuestErrorCode;

  constructor(code: GuestErrorCode) {
    super(code);
    this.name = 'GuestBridgeError';
    this.code = code;
  }
}

const MAX_COMMAND_ARGS = 64;
const MAX_ARG_BYTES = 4096;
const MAX_COMMAND_BYTES = 65536;
const MIN_MEMORY_MIB = 256;
const MAX_MEMORY_MIB = 4096;

export type GuestBootOptions = {
  memoryMib?: number;
};

type NativeLocalGuest = {
  bootGuest(request: unknown): Promise<GuestBootReceipt>;
  guestExec(request: unknown): Promise<GuestExecReceipt>;
  shutdownGuest(): Promise<GuestShutdownReceipt>;
};

const native: unknown = NativeModules.LocalGuest;

function hasNativeCapabilities(value: unknown): value is NativeLocalGuest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<NativeLocalGuest>;
  return (
    typeof candidate.bootGuest === 'function' &&
    typeof candidate.guestExec === 'function' &&
    typeof candidate.shutdownGuest === 'function'
  );
}

function required(): NativeLocalGuest {
  if (!hasNativeCapabilities(native)) {
    throw new GuestBridgeError('E_GUEST_NATIVE');
  }
  return native;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Rebuilds native failures with a value-free message and no attached cause. */
export function sanitizeGuestError(error: unknown): GuestBridgeError {
  try {
    if (error instanceof GuestBridgeError) {
      return isGuestErrorCode(error.code)
        ? new GuestBridgeError(error.code)
        : new GuestBridgeError('E_GUEST_NATIVE');
    }
    if (isRecord(error) && typeof error.code === 'string') {
      return isGuestErrorCode(error.code)
        ? new GuestBridgeError(error.code)
        : new GuestBridgeError('E_GUEST_NATIVE');
    }
  } catch {
    return new GuestBridgeError('E_GUEST_NATIVE');
  }
  return new GuestBridgeError('E_GUEST_NATIVE');
}

/**
 * Mirrors the native-side fail-closed validation so malformed argv never
 * reaches the bridge: bounded count, bounded UTF-8 bytes, strings only, no
 * embedded NULs.
 */
function validatedCommand(command: readonly string[]): string[] {
  if (!Array.isArray(command)) {
    throw new GuestBridgeError('E_GUEST_INVALID_REQUEST');
  }
  if (command.length === 0 || command.length > MAX_COMMAND_ARGS) {
    throw new GuestBridgeError('E_GUEST_INVALID_REQUEST');
  }
  let totalBytes = 0;
  const validated: string[] = [];
  for (const entry of command) {
    if (typeof entry !== 'string') {
      throw new GuestBridgeError('E_GUEST_INVALID_REQUEST');
    }
    const bytes = byteLength(entry);
    if (
      entry.length === 0 ||
      entry.includes('\u0000') ||
      bytes > MAX_ARG_BYTES ||
      bytes > MAX_COMMAND_BYTES - totalBytes
    ) {
      throw new GuestBridgeError('E_GUEST_INVALID_REQUEST');
    }
    totalBytes += bytes;
    validated.push(entry);
  }
  return validated;
}

function byteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function validatedMemoryMib(options: GuestBootOptions): number {
  const memoryMib = options.memoryMib ?? 1024;
  if (
    !Number.isInteger(memoryMib) ||
    memoryMib < MIN_MEMORY_MIB ||
    memoryMib > MAX_MEMORY_MIB
  ) {
    throw new GuestBridgeError('E_GUEST_INVALID_REQUEST');
  }
  return memoryMib;
}

async function boot(options: GuestBootOptions = {}): Promise<GuestBootReceipt> {
  try {
    const memoryMib = validatedMemoryMib(options);
    return await required().bootGuest({ schema_version: 1, memory_mib: memoryMib });
  } catch (error) {
    throw sanitizeGuestError(error);
  }
}

async function exec(command: readonly string[]): Promise<GuestExecReceipt> {
  try {
    const argv = validatedCommand(command);
    return await required().guestExec({ schema_version: 1, command: argv });
  } catch (error) {
    throw sanitizeGuestError(error);
  }
}

async function shutdown(): Promise<GuestShutdownReceipt> {
  try {
    return await required().shutdownGuest();
  } catch (error) {
    throw sanitizeGuestError(error);
  }
}

export const LocalGuest = {
  isAvailable: () => hasNativeCapabilities(native),
  boot,
  exec,
  shutdown,
};

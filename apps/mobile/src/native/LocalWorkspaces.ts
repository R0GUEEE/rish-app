import { NativeModules } from 'react-native';

/**
 * Structured access state for one granted folder. `ok` means coordinated
 * access is currently possible; every other value is surfaced verbatim to the
 * UI instead of being retried or silently repaired.
 */
export type WorkspaceStatus =
  | 'ok'
  | 'stale'
  | 'revoked'
  | 'unavailable'
  | 'not_downloaded';

export type WorkspaceOrigin =
  | 'rish_created'
  | 'imported'
  | 'granted_folder';

export type WorkspaceDescriptor = {
  schema_version: 1;
  workspace_id: string;
  display_name: string;
  origin: WorkspaceOrigin;
  created_at: string;
  last_opened_at: string;
  status: WorkspaceStatus;
};

export type WorkspaceListing = {
  schema_version: 1;
  workspaces: readonly WorkspaceDescriptor[];
};

export type WorkspaceResolveResult = {
  schema_version: 1;
  workspace_id: string;
  status: WorkspaceStatus;
};

type NativeLocalWorkspaces = {
  list(): Promise<WorkspaceListing>;
  create(displayName: string): Promise<WorkspaceDescriptor>;
  grantFolder(): Promise<WorkspaceDescriptor>;
  importFolder(): Promise<WorkspaceDescriptor>;
  resolve(workspaceId: string): Promise<WorkspaceResolveResult>;
  forget(workspaceId: string): Promise<{ schema_version: 1 }>;
};

function currentNative(): unknown {
  return (NativeModules as Record<string, unknown>).LocalWorkspaces;
}

function hasNativeCapabilities(value: unknown): value is NativeLocalWorkspaces {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<
    Record<keyof NativeLocalWorkspaces, unknown>
  >;
  return (
    typeof candidate.list === 'function' &&
    typeof candidate.create === 'function' &&
    typeof candidate.grantFolder === 'function' &&
    typeof candidate.importFolder === 'function' &&
    typeof candidate.resolve === 'function' &&
    typeof candidate.forget === 'function'
  );
}

function required(): NativeLocalWorkspaces {
  const current = currentNative();
  if (!hasNativeCapabilities(current)) {
    throw new Error('LocalWorkspaces native module is not linked');
  }
  return current;
}

/**
 * Bridge facade over the native workspace registry. JavaScript only ever
 * handles opaque workspace ids and display metadata; absolute paths, bookmark
 * blobs, and security-scoped handles stay in native code. Every operation
 * rejects through its returned promise when the bridge is unavailable.
 */
export const LocalWorkspaces = {
  isAvailable: () => hasNativeCapabilities(currentNative()),
  list: async () => {
    const nativeModule = required();
    return nativeModule.list();
  },
  create: async (displayName: string) => {
    const nativeModule = required();
    return nativeModule.create(displayName);
  },
  grantFolder: async () => {
    const nativeModule = required();
    return nativeModule.grantFolder();
  },
  importFolder: async () => {
    const nativeModule = required();
    return nativeModule.importFolder();
  },
  resolve: async (workspaceId: string) => {
    const nativeModule = required();
    return nativeModule.resolve(workspaceId);
  },
  forget: async (workspaceId: string) => {
    const nativeModule = required();
    return nativeModule.forget(workspaceId);
  },
};

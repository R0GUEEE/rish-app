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
  | 'not_downloaded'
  | 'import_required';

export type WorkspaceOrigin =
  | 'rish_created'
  | 'imported'
  | 'granted_folder'
  | 'legacy_app_owned';

export type WorkspaceCapabilities = {
  read: boolean;
  write: boolean;
  git: boolean;
  project_context: boolean;
  files_visible: boolean;
};

export type WorkspaceDescriptor = {
  schema_version: 2;
  workspace_id: string;
  display_name: string;
  origin: WorkspaceOrigin;
  created_at: string;
  last_opened_at: string;
  status: WorkspaceStatus;
  binding_revision: number;
  capabilities: WorkspaceCapabilities;
};

export type WorkspaceListing = {
  schema_version: 1;
  workspaces: readonly WorkspaceDescriptor[];
};

export type WorkspaceResolveResult = {
  schema_version: 1;
  disposition: 'metadata' | 'direct';
  workspace: WorkspaceDescriptor;
};

export type WorkspaceResolveRequest = {
  schema_version: 1;
  workspace_id: string;
  expected_binding_revision: number | null;
  required_capabilities: readonly (
    | 'read'
    | 'write'
    | 'git'
    | 'project_context'
  )[];
};

export type WorkspaceCreateRequest = {
  schema_version: 1;
  display_name: string;
  operation_id: string;
};

export type WorkspaceOperationRequest = {
  schema_version: 1;
  operation_id: string;
};

type NativeLocalWorkspaces = {
  list(): Promise<WorkspaceListing>;
  resolveMetadata(request: WorkspaceResolveRequest): Promise<WorkspaceResolveResult>;
  queryOperation(request: WorkspaceOperationRequest): Promise<unknown>;
  create(request: WorkspaceCreateRequest): Promise<WorkspaceDescriptor>;
  presentFolderPicker(request: Record<string, unknown>): Promise<unknown>;
  grantFolder(request: Record<string, unknown>): Promise<unknown>;
  importFolder(request: Record<string, unknown>): Promise<unknown>;
  forget(request: Record<string, unknown>): Promise<unknown>;
  deleteOwnedContent(request: Record<string, unknown>): Promise<unknown>;
  cancelPicker(request: Record<string, unknown>): Promise<unknown>;
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
    typeof candidate.resolveMetadata === 'function' &&
    typeof candidate.queryOperation === 'function' &&
    typeof candidate.create === 'function' &&
    typeof candidate.presentFolderPicker === 'function' &&
    typeof candidate.grantFolder === 'function' &&
    typeof candidate.importFolder === 'function' &&
    typeof candidate.forget === 'function' &&
    typeof candidate.deleteOwnedContent === 'function' &&
    typeof candidate.cancelPicker === 'function'
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
  create: async (request: WorkspaceCreateRequest) => {
    const nativeModule = required();
    return nativeModule.create(request);
  },
  presentFolderPicker: async (request: Record<string, unknown>) => {
    const nativeModule = required();
    return nativeModule.presentFolderPicker(request);
  },
  grantFolder: async (request: Record<string, unknown>) => {
    const nativeModule = required();
    return nativeModule.grantFolder(request);
  },
  importFolder: async (request: Record<string, unknown>) => {
    const nativeModule = required();
    return nativeModule.importFolder(request);
  },
  resolve: async (request: WorkspaceResolveRequest) => {
    const nativeModule = required();
    return nativeModule.resolveMetadata(request);
  },
  queryOperation: async (request: WorkspaceOperationRequest) => {
    const nativeModule = required();
    return nativeModule.queryOperation(request);
  },
  forget: async (request: Record<string, unknown>) => {
    const nativeModule = required();
    return nativeModule.forget(request);
  },
  deleteOwnedContent: async (request: Record<string, unknown>) => {
    const nativeModule = required();
    return nativeModule.deleteOwnedContent(request);
  },
  cancelPicker: async (request: Record<string, unknown>) => {
    const nativeModule = required();
    return nativeModule.cancelPicker(request);
  },
};

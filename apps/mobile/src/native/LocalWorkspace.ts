import { NativeModules } from 'react-native';

export type WorkspaceEntryKind = 'file' | 'directory';

export type WorkspaceEntry = {
  path: string;
  name: string;
  kind: WorkspaceEntryKind;
  size: number;
  modified_at: string;
  revision?: string;
};

export type WorkspaceCapabilities = {
  schema_version: 1;
  root: 'workspace';
  max_text_bytes: number;
  max_list_entries: number;
  max_tool_output_bytes: number;
  trash_recoverable: true;
  trash_listable: true;
  atomic_writes: true;
  symlinks_allowed: false;
  rish_protocol_version: number;
  portable_tools: PortableToolName[];
};

export type WorkspaceDirectory = {
  path: string;
  entries: WorkspaceEntry[];
};

export type WorkspaceTextFile = {
  file: WorkspaceEntry;
  content: string;
};

export type WorkspaceWriteResult = {
  file: WorkspaceEntry;
  created: boolean;
};

export type WorkspaceDirectoryResult = {
  directory: WorkspaceEntry;
};

export type WorkspaceRenameResult = {
  entry: WorkspaceEntry;
  from: string;
};

export type WorkspaceTrashReceipt = {
  schema_version: 1;
  trash_id: string;
  original_path: string;
  kind: WorkspaceEntryKind;
  deleted_at: string;
};

export type WorkspaceRestoreResult = {
  entry: WorkspaceEntry;
  trash_id: string;
  original_path: string;
};

export type WorkspaceTrashListing = {
  entries: WorkspaceTrashReceipt[];
  invalid_record_count: number;
};

export type PortableToolName =
  | 'cat'
  | 'grep'
  | 'head'
  | 'tail'
  | 'wc'
  | 'sha256sum';

export type PortableToolOptions = {
  lines?: number;
  metric?: 'lines' | 'words' | 'bytes';
  pattern?: string;
  case_insensitive?: boolean;
};

export type PortableToolResult = {
  tool: PortableToolName;
  path: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  protocol_version: number;
  path_kind: 'portable_applet';
};

type NativeLocalWorkspace = {
  capabilities(): Promise<WorkspaceCapabilities>;
  listDirectory(path: string): Promise<WorkspaceDirectory>;
  readText(path: string): Promise<WorkspaceTextFile>;
  writeText(
    path: string,
    content: string,
    createOnly: boolean,
    expectedRevision: string | null,
  ): Promise<WorkspaceWriteResult>;
  createDirectory(path: string): Promise<WorkspaceDirectoryResult>;
  renameEntry(
    sourcePath: string,
    destinationPath: string,
  ): Promise<WorkspaceRenameResult>;
  trashEntry(path: string): Promise<WorkspaceTrashReceipt>;
  listTrash(): Promise<WorkspaceTrashListing>;
  restoreFromTrash(
    trashId: string,
    destinationPath: string | null,
  ): Promise<WorkspaceRestoreResult>;
  executePortableTool(
    tool: PortableToolName,
    path: string,
    options: PortableToolOptions,
  ): Promise<PortableToolResult>;
};

const native = NativeModules.LocalWorkspace as unknown;

function hasNativeCapabilities(value: unknown): value is NativeLocalWorkspace {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<
    Record<keyof NativeLocalWorkspace, unknown>
  >;
  return (
    typeof candidate.capabilities === 'function' &&
    typeof candidate.listDirectory === 'function' &&
    typeof candidate.readText === 'function' &&
    typeof candidate.writeText === 'function' &&
    typeof candidate.createDirectory === 'function' &&
    typeof candidate.renameEntry === 'function' &&
    typeof candidate.trashEntry === 'function' &&
    typeof candidate.listTrash === 'function' &&
    typeof candidate.restoreFromTrash === 'function' &&
    typeof candidate.executePortableTool === 'function'
  );
}

function required(): NativeLocalWorkspace {
  if (!hasNativeCapabilities(native)) {
    throw new Error('LocalWorkspace native module is not linked');
  }
  return native;
}

export const LocalWorkspace = {
  isAvailable: () => hasNativeCapabilities(native),
  capabilities: () => required().capabilities(),
  listDirectory: (path = '') => required().listDirectory(path),
  readText: (path: string) => required().readText(path),
  writeText: (
    path: string,
    content: string,
    options: { createOnly?: boolean; expectedRevision?: string } = {},
  ) =>
    required().writeText(
      path,
      content,
      options.createOnly ?? true,
      options.expectedRevision ?? null,
    ),
  createDirectory: (path: string) => required().createDirectory(path),
  renameEntry: (sourcePath: string, destinationPath: string) =>
    required().renameEntry(sourcePath, destinationPath),
  trashEntry: (path: string) => required().trashEntry(path),
  listTrash: () => required().listTrash(),
  restoreFromTrash: (trashId: string, destinationPath?: string) =>
    required().restoreFromTrash(trashId, destinationPath ?? null),
  executePortableTool: (
    tool: PortableToolName,
    path: string,
    options: PortableToolOptions = {},
  ) => required().executePortableTool(tool, path, options),
};

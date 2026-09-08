import { nativeImplementationAvailable } from './NativeImplementation';
import { NativeModules } from 'react-native';

import {
  assertWorkspaceRootRefV1,
  type WorkspaceRootRefV1,
} from './WorkspaceRoot';

export type WorkspaceEntryKind = 'file' | 'directory';

export type WorkspaceEntry = {
  path: string;
  name: string;
  kind: WorkspaceEntryKind;
  size: number;
  modified_at: string;
  revision: string;
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

export type WorkspaceListRequestV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  path: string;
  max_entries: number;
};

export type WorkspaceListResultV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  path: string;
  entries: WorkspaceEntry[];
};

export type WorkspaceReadRequestV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  path: string;
  max_bytes: number;
};

export type WorkspaceTextFile = {
  file: WorkspaceEntry;
  content: string;
};

export type WorkspaceReadResultV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  path: string;
  file: WorkspaceEntry;
  content: string;
};

export type WorkspaceWriteRequestV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  path: string;
  content: string;
  expected_revision: string | null;
  create_only: boolean;
};

export type WorkspaceWriteResultV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  file: WorkspaceEntry;
  created: boolean;
};

export type WorkspaceDirectoryResultV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  directory: WorkspaceEntry;
};

export type WorkspaceRenameRequestV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  source_path: string;
  destination_path: string;
};

export type WorkspaceRenameResultV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
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

export type WorkspaceTrashRequestV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  path: string;
};

export type WorkspaceTrashResultV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  receipt: WorkspaceTrashReceipt;
};

export type WorkspaceTrashListRequestV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  max_entries: number;
};

export type WorkspaceTrashListResultV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  entries: WorkspaceTrashReceipt[];
  invalid_record_count: number;
};

export type WorkspaceRestoreRequestV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  trash_id: string;
  destination_path: string | null;
};

export type WorkspaceRestoreResultV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  entry: WorkspaceEntry;
  trash_id: string;
  original_path: string;
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

export type WorkspaceToolRequestV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  tool: PortableToolName;
  path: string;
  options: PortableToolOptions;
};

export type PortableToolResult = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  tool: PortableToolName;
  path: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  protocol_version: number;
  path_kind: 'portable_applet';
};

type NativeLocalWorkspace = {
  capabilities?(): Promise<WorkspaceCapabilities>;
  listV2(request: WorkspaceListRequestV1): Promise<unknown>;
  readV2(request: WorkspaceReadRequestV1): Promise<unknown>;
  writeV2(request: WorkspaceWriteRequestV1): Promise<unknown>;
  createDirectoryV2?(request: {
    schema_version: 1;
    root: WorkspaceRootRefV1;
    path: string;
  }): Promise<unknown>;
  renameEntryV2?(request: WorkspaceRenameRequestV1): Promise<unknown>;
  trashEntryV2?(request: WorkspaceTrashRequestV1): Promise<unknown>;
  listTrashV2?(request: WorkspaceTrashListRequestV1): Promise<unknown>;
  restoreFromTrashV2?(request: WorkspaceRestoreRequestV1): Promise<unknown>;
  executePortableToolV2?(request: WorkspaceToolRequestV1): Promise<unknown>;
};

const native = NativeModules.LocalWorkspace as unknown;
const INVALID_CODE = 'E_WORKSPACE_INVALID';
const MAX_PATH_BYTES = 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 1000;
const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;
const SNAPSHOT_INVALID = Symbol('workspace-snapshot-invalid');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function invalid(message = 'Workspace request is invalid.'): Error & {
  code: string;
} {
  return Object.assign(new Error(message), { code: INVALID_CODE });
}

function invalidResponse(): Error & { code: string } {
  return invalid('Workspace bridge response is invalid.');
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      return Number.POSITIVE_INFINITY;
    }
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function snapshotData(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) return SNAPSHOT_INVALID;
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const names = Reflect.ownKeys(descriptors);
    if (names.some(name => typeof name === 'symbol')) return SNAPSHOT_INVALID;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype)
        return SNAPSHOT_INVALID;
      const lengthDescriptor = descriptors.length;
      if (
        lengthDescriptor === undefined ||
        lengthDescriptor.enumerable ||
        lengthDescriptor.get !== undefined ||
        lengthDescriptor.set !== undefined ||
        typeof lengthDescriptor.value !== 'number' ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        names.length !== lengthDescriptor.value + 1
      )
        return SNAPSHOT_INVALID;
      const result: unknown[] = [];
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        )
          return SNAPSHOT_INVALID;
        const child = snapshotData(descriptor.value, ancestors);
        if (child === SNAPSHOT_INVALID) return SNAPSHOT_INVALID;
        result.push(child);
      }
      if (
        names.some(
          name =>
            name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name as string),
        )
      )
        return SNAPSHOT_INVALID;
      return result;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype)
      return SNAPSHOT_INVALID;
    const result: Record<string, unknown> = {};
    for (const name of names as string[]) {
      const descriptor = descriptors[name];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      )
        return SNAPSHOT_INVALID;
      const child = snapshotData(descriptor.value, ancestors);
      if (child === SNAPSHOT_INVALID) return SNAPSHOT_INVALID;
      result[name] = child;
    }
    return result;
  } catch {
    return SNAPSHOT_INVALID;
  } finally {
    ancestors.delete(value);
  }
}

function snapshotObject(value: unknown): Record<string, unknown> | null {
  const snapshot = snapshotData(value);
  return snapshot !== SNAPSHOT_INVALID &&
    typeof snapshot === 'object' &&
    snapshot !== null &&
    !Array.isArray(snapshot)
    ? (snapshot as Record<string, unknown>)
    : null;
}

function snapshotExact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  const snapshot = snapshotObject(value);
  if (snapshot === null) return null;
  const names = Object.keys(snapshot);
  return names.length === keys.length && keys.every(key => names.includes(key))
    ? snapshot
    : null;
}

function exactRequest(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const captured = snapshotExact(value, keys);
  if (captured === null) throw invalid();
  return captured;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function isSafeInteger(value: unknown, minimum = 1): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    !Object.is(value, -0)
  );
}

function isPath(value: unknown, allowRoot = true): value is string {
  if (typeof value !== 'string' || utf8Bytes(value) > MAX_PATH_BYTES)
    return false;
  if (value.length === 0) return allowRoot;
  if (value.startsWith('/') || value.includes('\\')) return false;
  if (
    [...value].some(character => {
      const point = character.codePointAt(0);
      return point !== undefined && point <= 0x1f;
    })
  )
    return false;
  return value
    .split('/')
    .every(
      component =>
        component.length > 0 &&
        component !== '.' &&
        component !== '..' &&
        component.toLowerCase() !== '.git' &&
        component.toLowerCase() !== '.trash' &&
        !component.toLowerCase().startsWith('.staging-') &&
        !component.toLowerCase().startsWith('.rish-write-') &&
        utf8Bytes(component) <= 255,
    );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isContent(value: unknown): value is string {
  return typeof value === 'string' && utf8Bytes(value) <= MAX_TEXT_BYTES;
}

function isTool(value: unknown): value is PortableToolName {
  return (
    typeof value === 'string' &&
    ['cat', 'grep', 'head', 'tail', 'wc', 'sha256sum'].includes(value)
  );
}

function rootFrom(value: unknown): WorkspaceRootRefV1 {
  try {
    return assertWorkspaceRootRefV1(value);
  } catch {
    throw invalid();
  }
}

function sameRoot(
  left: WorkspaceRootRefV1,
  right: WorkspaceRootRefV1,
): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.workspace_id === right.workspace_id &&
    left.binding_revision === right.binding_revision &&
    left.project_id === right.project_id
  );
}

function requestPath(value: unknown, allowRoot = true): string {
  if (!isPath(value, allowRoot)) throw invalid();
  return value;
}

function requestCount(value: unknown, maximum = MAX_LIST_ENTRIES): number {
  if (!isSafeInteger(value) || value > maximum) throw invalid();
  return value;
}

function requestOptions(value: unknown): PortableToolOptions {
  const captured = snapshotObject(value);
  if (
    captured === null ||
    Object.keys(captured).some(
      key => !['lines', 'metric', 'pattern', 'case_insensitive'].includes(key),
    )
  )
    throw invalid();
  const result: PortableToolOptions = {};
  if (captured.lines !== undefined) {
    if (!isSafeInteger(captured.lines) || captured.lines > 1000)
      throw invalid();
    result.lines = captured.lines;
  }
  if (captured.metric !== undefined) {
    if (!['lines', 'words', 'bytes'].includes(captured.metric as string))
      throw invalid();
    result.metric = captured.metric as PortableToolOptions['metric'];
  }
  if (captured.pattern !== undefined) {
    if (
      typeof captured.pattern !== 'string' ||
      utf8Bytes(captured.pattern) === 0 ||
      utf8Bytes(captured.pattern) > 1024
    )
      throw invalid();
    result.pattern = captured.pattern;
  }
  if (captured.case_insensitive !== undefined) {
    if (typeof captured.case_insensitive !== 'boolean') throw invalid();
    result.case_insensitive = captured.case_insensitive;
  }
  return result;
}

function parseRoot(
  value: unknown,
  expected: WorkspaceRootRefV1,
): WorkspaceRootRefV1 {
  const root = rootFrom(value);
  if (!sameRoot(root, expected)) throw invalidResponse();
  return root;
}

function parseEntry(value: unknown): WorkspaceEntry {
  const captured = exactRequest(value, [
    'path',
    'name',
    'kind',
    'size',
    'modified_at',
    'revision',
  ]);
  if (
    !isPath(captured.path, false) ||
    typeof captured.name !== 'string' ||
    captured.name.length === 0 ||
    captured.name !==
      captured.path.split('/')[captured.path.split('/').length - 1] ||
    captured.name.includes('/') ||
    captured.name.includes('\\') ||
    (captured.kind !== 'file' && captured.kind !== 'directory') ||
    !isSafeInteger(captured.size, 0) ||
    !isTimestamp(captured.modified_at) ||
    !isDigest(captured.revision)
  )
    throw invalidResponse();
  return {
    path: captured.path,
    name: captured.name,
    kind: captured.kind,
    size: captured.size,
    modified_at: captured.modified_at,
    revision: captured.revision,
  };
}

function parseList(
  value: unknown,
  expected: WorkspaceListRequestV1,
): WorkspaceListResultV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'root',
    'path',
    'entries',
  ]);
  const root = parseRoot(captured.root, expected.root);
  if (
    captured.schema_version !== 1 ||
    captured.path !== expected.path ||
    !Array.isArray(captured.entries) ||
    captured.entries.length > expected.max_entries
  )
    throw invalidResponse();
  const parent = expected.path;
  const entryPaths = new Set<string>();
  for (const rawEntry of captured.entries) {
    const entry = parseEntry(rawEntry);
    if (entryPaths.has(entry.path)) throw invalidResponse();
    entryPaths.add(entry.path);
    const prefix = parent.length === 0 ? '' : `${parent}/`;
    const relative = entry.path.startsWith(prefix)
      ? entry.path.slice(prefix.length)
      : null;
    if (relative === null || relative.length === 0 || relative.includes('/'))
      throw invalidResponse();
  }
  return {
    schema_version: 1,
    root,
    path: captured.path,
    entries: captured.entries.map(parseEntry),
  };
}

function parseRead(
  value: unknown,
  expected: WorkspaceReadRequestV1,
): WorkspaceReadResultV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'root',
    'path',
    'file',
    'content',
  ]);
  const root = parseRoot(captured.root, expected.root);
  if (
    captured.schema_version !== 1 ||
    captured.path !== expected.path ||
    typeof captured.content !== 'string' ||
    utf8Bytes(captured.content) > expected.max_bytes
  )
    throw invalidResponse();
  const file = parseEntry(captured.file);
  if (file.path !== expected.path || file.kind !== 'file')
    throw invalidResponse();
  return {
    schema_version: 1,
    root,
    path: captured.path,
    file,
    content: captured.content,
  };
}

function parseWrite(
  value: unknown,
  expected: WorkspaceWriteRequestV1,
): WorkspaceWriteResultV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'root',
    'file',
    'created',
  ]);
  const root = parseRoot(captured.root, expected.root);
  if (captured.schema_version !== 1 || typeof captured.created !== 'boolean')
    throw invalidResponse();
  const file = parseEntry(captured.file);
  if (file.path !== expected.path || file.kind !== 'file')
    throw invalidResponse();
  return { schema_version: 1, root, file, created: captured.created };
}

function parseDirectoryResult(
  value: unknown,
  expected: { schema_version: 1; root: WorkspaceRootRefV1; path: string },
): WorkspaceDirectoryResultV1 {
  const captured = exactRequest(value, ['schema_version', 'root', 'directory']);
  const root = parseRoot(captured.root, expected.root);
  if (captured.schema_version !== 1) throw invalidResponse();
  const directory = parseEntry(captured.directory);
  if (directory.path !== expected.path || directory.kind !== 'directory')
    throw invalidResponse();
  return { schema_version: 1, root, directory };
}

function parseRename(
  value: unknown,
  expected: WorkspaceRenameRequestV1,
): WorkspaceRenameResultV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'root',
    'entry',
    'from',
  ]);
  const root = parseRoot(captured.root, expected.root);
  if (captured.schema_version !== 1 || captured.from !== expected.source_path)
    throw invalidResponse();
  const entry = parseEntry(captured.entry);
  if (entry.path !== expected.destination_path) throw invalidResponse();
  return { schema_version: 1, root, entry, from: captured.from };
}

function parseTrashReceipt(value: unknown): WorkspaceTrashReceipt {
  const captured = exactRequest(value, [
    'schema_version',
    'trash_id',
    'original_path',
    'kind',
    'deleted_at',
  ]);
  if (
    captured.schema_version !== 1 ||
    !isUuid(captured.trash_id) ||
    !isPath(captured.original_path, false) ||
    (captured.kind !== 'file' && captured.kind !== 'directory') ||
    !isTimestamp(captured.deleted_at)
  )
    throw invalidResponse();
  return {
    schema_version: 1,
    trash_id: captured.trash_id,
    original_path: captured.original_path,
    kind: captured.kind,
    deleted_at: captured.deleted_at,
  };
}

function parseTrashResult(
  value: unknown,
  expected: WorkspaceTrashRequestV1,
): WorkspaceTrashResultV1 {
  const captured = exactRequest(value, ['schema_version', 'root', 'receipt']);
  const root = parseRoot(captured.root, expected.root);
  if (captured.schema_version !== 1) throw invalidResponse();
  const receipt = parseTrashReceipt(captured.receipt);
  if (receipt.original_path !== expected.path) throw invalidResponse();
  return { schema_version: 1, root, receipt };
}

function parseTrashList(
  value: unknown,
  expected: WorkspaceTrashListRequestV1,
): WorkspaceTrashListResultV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'root',
    'entries',
    'invalid_record_count',
  ]);
  const root = parseRoot(captured.root, expected.root);
  if (
    captured.schema_version !== 1 ||
    !Array.isArray(captured.entries) ||
    captured.entries.length > expected.max_entries ||
    !isSafeInteger(captured.invalid_record_count, 0) ||
    captured.invalid_record_count > expected.max_entries
  )
    throw invalidResponse();
  return {
    schema_version: 1,
    root,
    entries: captured.entries.map(parseTrashReceipt),
    invalid_record_count: captured.invalid_record_count,
  };
}

function parseRestore(
  value: unknown,
  expected: WorkspaceRestoreRequestV1,
): WorkspaceRestoreResultV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'root',
    'entry',
    'trash_id',
    'original_path',
  ]);
  const root = parseRoot(captured.root, expected.root);
  if (
    captured.schema_version !== 1 ||
    captured.trash_id !== expected.trash_id ||
    !isUuid(captured.trash_id) ||
    !isPath(captured.original_path, false)
  )
    throw invalidResponse();
  const entry = parseEntry(captured.entry);
  if (entry.path !== (expected.destination_path ?? captured.original_path))
    throw invalidResponse();
  return {
    schema_version: 1,
    root,
    entry,
    trash_id: captured.trash_id,
    original_path: captured.original_path,
  };
}

function parseTool(
  value: unknown,
  expected: WorkspaceToolRequestV1,
): PortableToolResult {
  const captured = exactRequest(value, [
    'schema_version',
    'root',
    'tool',
    'path',
    'exit_code',
    'stdout',
    'stderr',
    'protocol_version',
    'path_kind',
  ]);
  const root = parseRoot(captured.root, expected.root);
  if (
    captured.schema_version !== 1 ||
    captured.tool !== expected.tool ||
    captured.path !== expected.path ||
    !isTool(captured.tool) ||
    !isSafeInteger(captured.exit_code, 0) ||
    typeof captured.stdout !== 'string' ||
    utf8Bytes(captured.stdout) > MAX_TOOL_OUTPUT_BYTES ||
    typeof captured.stderr !== 'string' ||
    utf8Bytes(captured.stderr) > MAX_TOOL_OUTPUT_BYTES ||
    !isSafeInteger(captured.protocol_version, 0) ||
    captured.path_kind !== 'portable_applet'
  )
    throw invalidResponse();
  return {
    schema_version: 1,
    root,
    tool: captured.tool,
    path: captured.path,
    exit_code: captured.exit_code,
    stdout: captured.stdout,
    stderr: captured.stderr,
    protocol_version: captured.protocol_version,
    path_kind: 'portable_applet',
  };
}

function hasNativeCapabilities(value: unknown): value is NativeLocalWorkspace {
  if (!nativeImplementationAvailable(value)) return false;
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<
    Record<keyof NativeLocalWorkspace, unknown>
  >;
  return (
    typeof candidate.listV2 === 'function' &&
    typeof candidate.readV2 === 'function' &&
    typeof candidate.writeV2 === 'function'
  );
}

function required(): NativeLocalWorkspace {
  if (!hasNativeCapabilities(native))
    throw new Error('LocalWorkspace native module is not linked');
  return native;
}

function encodeListRequest(value: unknown): WorkspaceListRequestV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'root',
    'path',
    'max_entries',
  ]);
  if (captured.schema_version !== 1) throw invalid();
  return {
    schema_version: 1,
    root: rootFrom(captured.root),
    path: requestPath(captured.path),
    max_entries: requestCount(captured.max_entries),
  };
}

function encodeReadRequest(value: unknown): WorkspaceReadRequestV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'root',
    'path',
    'max_bytes',
  ]);
  if (captured.schema_version !== 1) throw invalid();
  return {
    schema_version: 1,
    root: rootFrom(captured.root),
    path: requestPath(captured.path, false),
    max_bytes: requestCount(captured.max_bytes, MAX_TEXT_BYTES),
  };
}

function encodeWriteRequest(value: unknown): WorkspaceWriteRequestV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'root',
    'path',
    'content',
    'expected_revision',
    'create_only',
  ]);
  if (
    captured.schema_version !== 1 ||
    !isContent(captured.content) ||
    typeof captured.create_only !== 'boolean' ||
    (captured.expected_revision !== null &&
      !isDigest(captured.expected_revision))
  )
    throw invalid();
  return {
    schema_version: 1,
    root: rootFrom(captured.root),
    path: requestPath(captured.path, false),
    content: captured.content,
    expected_revision: captured.expected_revision,
    create_only: captured.create_only,
  };
}

function encodeDirectoryRequest(value: unknown): {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  path: string;
} {
  const captured = exactRequest(value, ['schema_version', 'root', 'path']);
  if (captured.schema_version !== 1) throw invalid();
  return {
    schema_version: 1,
    root: rootFrom(captured.root),
    path: requestPath(captured.path, false),
  };
}

function encodeRenameRequest(value: unknown): WorkspaceRenameRequestV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'root',
    'source_path',
    'destination_path',
  ]);
  if (captured.schema_version !== 1) throw invalid();
  return {
    schema_version: 1,
    root: rootFrom(captured.root),
    source_path: requestPath(captured.source_path, false),
    destination_path: requestPath(captured.destination_path, false),
  };
}

function encodeTrashRequest(value: unknown): WorkspaceTrashRequestV1 {
  const captured = exactRequest(value, ['schema_version', 'root', 'path']);
  if (captured.schema_version !== 1) throw invalid();
  return {
    schema_version: 1,
    root: rootFrom(captured.root),
    path: requestPath(captured.path, false),
  };
}

function encodeTrashListRequest(value: unknown): WorkspaceTrashListRequestV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'root',
    'max_entries',
  ]);
  if (captured.schema_version !== 1) throw invalid();
  return {
    schema_version: 1,
    root: rootFrom(captured.root),
    max_entries: requestCount(captured.max_entries),
  };
}

function encodeRestoreRequest(value: unknown): WorkspaceRestoreRequestV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'root',
    'trash_id',
    'destination_path',
  ]);
  if (
    captured.schema_version !== 1 ||
    !isUuid(captured.trash_id) ||
    (captured.destination_path !== null &&
      !isPath(captured.destination_path, false))
  )
    throw invalid();
  return {
    schema_version: 1,
    root: rootFrom(captured.root),
    trash_id: captured.trash_id,
    destination_path: captured.destination_path,
  };
}

function encodeToolRequest(value: unknown): WorkspaceToolRequestV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'root',
    'tool',
    'path',
    'options',
  ]);
  if (captured.schema_version !== 1 || !isTool(captured.tool)) throw invalid();
  return {
    schema_version: 1,
    root: rootFrom(captured.root),
    tool: captured.tool,
    path: requestPath(captured.path, false),
    options: requestOptions(captured.options),
  };
}

export const LocalWorkspace = {
  isAvailable: () => hasNativeCapabilities(native),
  capabilities: () => {
    const method = required().capabilities;
    if (typeof method !== 'function')
      throw new Error('LocalWorkspace native module is not linked');
    return method();
  },
  listV2: async (request: WorkspaceListRequestV1) => {
    const encoded = encodeListRequest(request);
    return parseList(await required().listV2(encoded), encoded);
  },
  readV2: async (request: WorkspaceReadRequestV1) => {
    const encoded = encodeReadRequest(request);
    return parseRead(await required().readV2(encoded), encoded);
  },
  writeV2: async (request: WorkspaceWriteRequestV1) => {
    const encoded = encodeWriteRequest(request);
    return parseWrite(await required().writeV2(encoded), encoded);
  },
  createDirectoryV2: async (request: {
    schema_version: 1;
    root: WorkspaceRootRefV1;
    path: string;
  }) => {
    const encoded = encodeDirectoryRequest(request);
    const method = required().createDirectoryV2;
    if (typeof method !== 'function')
      throw new Error('LocalWorkspace native module is not linked');
    return parseDirectoryResult(await method(encoded), encoded);
  },
  renameEntryV2: async (request: WorkspaceRenameRequestV1) => {
    const encoded = encodeRenameRequest(request);
    const method = required().renameEntryV2;
    if (typeof method !== 'function')
      throw new Error('LocalWorkspace native module is not linked');
    return parseRename(await method(encoded), encoded);
  },
  trashEntryV2: async (request: WorkspaceTrashRequestV1) => {
    const encoded = encodeTrashRequest(request);
    const method = required().trashEntryV2;
    if (typeof method !== 'function')
      throw new Error('LocalWorkspace native module is not linked');
    return parseTrashResult(await method(encoded), encoded);
  },
  listTrashV2: async (request: WorkspaceTrashListRequestV1) => {
    const encoded = encodeTrashListRequest(request);
    const method = required().listTrashV2;
    if (typeof method !== 'function')
      throw new Error('LocalWorkspace native module is not linked');
    return parseTrashList(await method(encoded), encoded);
  },
  restoreFromTrashV2: async (request: WorkspaceRestoreRequestV1) => {
    const encoded = encodeRestoreRequest(request);
    const method = required().restoreFromTrashV2;
    if (typeof method !== 'function')
      throw new Error('LocalWorkspace native module is not linked');
    return parseRestore(await method(encoded), encoded);
  },
  executePortableToolV2: async (request: WorkspaceToolRequestV1) => {
    const encoded = encodeToolRequest(request);
    const method = required().executePortableToolV2;
    if (typeof method !== 'function')
      throw new Error('LocalWorkspace native module is not linked');
    return parseTool(await method(encoded), encoded);
  },
};

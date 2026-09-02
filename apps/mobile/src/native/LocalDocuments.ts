import { NativeModules } from 'react-native';

import {
  assertWorkspaceRootRefV1,
  type WorkspaceRootRefV1,
} from './WorkspaceRoot';

export type ImportedDocumentEntry = {
  path: string;
  kind: 'file' | 'directory';
  size: number;
};

export type DocumentImportRequestV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  operation_id: string;
  destination_path: string;
};

export type DocumentImportResultV1 = {
  schema_version: 1;
  status: 'imported' | 'cancelled';
  root: WorkspaceRootRefV1;
  operation_id: string;
  destination_path: string;
  entries: ImportedDocumentEntry[];
};

export type DocumentExportRequestV1 = {
  schema_version: 1;
  root: WorkspaceRootRefV1;
  operation_id: string;
  source_paths: string[];
};

export type DocumentExportResultV1 = {
  schema_version: 1;
  status: 'exported' | 'cancelled';
  root: WorkspaceRootRefV1;
  operation_id: string;
  item_count: number;
};

export type DocumentOperationStatus =
  | 'not_started'
  | 'in_progress'
  | 'needs_recovery'
  | 'committed'
  | 'cleaned';

export type DocumentOperationQueryRequestV1 = {
  schema_version: 1;
  operation_id: string;
  root: WorkspaceRootRefV1;
};

export type DocumentOperationQueryResultV1 = {
  schema_version: 1;
  operation_id: string;
  status: DocumentOperationStatus;
};

export type DocumentOperationRetryRequestV1 = {
  schema_version: 1;
  operation_id: string;
  root: WorkspaceRootRefV1;
};

export type DocumentOperationCleanupRequestV1 = {
  schema_version: 1;
  operation_id: string;
  root: WorkspaceRootRefV1;
};

type NativeLocalDocuments = {
  presentImportPicker(request: DocumentImportRequestV1): Promise<unknown>;
  presentExportPicker(request: DocumentExportRequestV1): Promise<unknown>;
  queryOperation(request: DocumentOperationQueryRequestV1): Promise<unknown>;
  retryOperation(request: DocumentOperationRetryRequestV1): Promise<unknown>;
  cleanupOperation(
    request: DocumentOperationCleanupRequestV1,
  ): Promise<unknown>;
};

const native = NativeModules.LocalDocuments as unknown;
const INVALID_CODE = 'E_WORKSPACE_INVALID';
const MAX_PATH_BYTES = 1024;
const MAX_EXPORT_ITEMS = 100;
const MAX_ENTRIES = 2000;
const MAX_SIZE = 256 * 1024 * 1024;
const SNAPSHOT_INVALID = Symbol('documents-snapshot-invalid');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(
  message = 'Workspace request is invalid.',
): Error & { code: string } {
  return Object.assign(new Error(message), { code: INVALID_CODE });
}

function invalidResponse(): Error & { code: string } {
  return invalid('Workspace bridge response is invalid.');
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point === undefined || (point >= 0xd800 && point <= 0xdfff))
      return Number.POSITIVE_INFINITY;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
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
      const length = descriptors.length;
      if (
        length === undefined ||
        length.enumerable ||
        length.get !== undefined ||
        length.set !== undefined ||
        typeof length.value !== 'number' ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0 ||
        names.length !== length.value + 1
      )
        return SNAPSHOT_INVALID;
      const result: unknown[] = [];
      for (let index = 0; index < length.value; index += 1) {
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

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const captured = snapshotObject(value);
  if (captured === null) throw invalidResponse();
  const names = Object.keys(captured);
  if (names.length !== keys.length || keys.some(key => !names.includes(key)))
    throw invalidResponse();
  return captured;
}

function exactRequest(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  try {
    return exact(value, keys);
  } catch {
    throw invalid();
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function root(value: unknown): WorkspaceRootRefV1 {
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

function isPath(value: unknown, allowRoot = true): value is string {
  if (typeof value !== 'string' || utf8Bytes(value) > MAX_PATH_BYTES)
    return false;
  if (value.length === 0) return allowRoot;
  if (value.startsWith('/') || value.includes('\\')) return false;
  if ([...value].some(character => (character.codePointAt(0) ?? 0) <= 0x1f))
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

function encodeImport(value: unknown): DocumentImportRequestV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'root',
    'operation_id',
    'destination_path',
  ]);
  if (
    captured.schema_version !== 1 ||
    !isUuid(captured.operation_id) ||
    !isPath(captured.destination_path)
  )
    throw invalid();
  return {
    schema_version: 1,
    root: root(captured.root),
    operation_id: captured.operation_id,
    destination_path: captured.destination_path,
  };
}

function encodeExport(value: unknown): DocumentExportRequestV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'root',
    'operation_id',
    'source_paths',
  ]);
  const paths = snapshotData(captured.source_paths);
  if (
    captured.schema_version !== 1 ||
    !isUuid(captured.operation_id) ||
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.length > MAX_EXPORT_ITEMS ||
    paths.some(path => !isPath(path, false))
  )
    throw invalid();
  return {
    schema_version: 1,
    root: root(captured.root),
    operation_id: captured.operation_id,
    source_paths: paths as string[],
  };
}

function parseEntry(value: unknown): ImportedDocumentEntry {
  const captured = exact(value, ['path', 'kind', 'size']);
  if (
    !isPath(captured.path, false) ||
    (captured.kind !== 'file' && captured.kind !== 'directory') ||
    typeof captured.size !== 'number' ||
    !Number.isSafeInteger(captured.size) ||
    Object.is(captured.size, -0) ||
    captured.size < 0 ||
    captured.size > MAX_SIZE
  )
    throw invalidResponse();
  return { path: captured.path, kind: captured.kind, size: captured.size };
}

function parseImport(
  value: unknown,
  expected: DocumentImportRequestV1,
): DocumentImportResultV1 {
  const captured = exact(value, [
    'schema_version',
    'status',
    'root',
    'operation_id',
    'destination_path',
    'entries',
  ]);
  const echoedRoot = root(captured.root);
  if (
    captured.schema_version !== 1 ||
    !sameRoot(echoedRoot, expected.root) ||
    captured.operation_id !== expected.operation_id ||
    !isUuid(captured.operation_id) ||
    (captured.status !== 'imported' && captured.status !== 'cancelled') ||
    captured.destination_path !== expected.destination_path ||
    !Array.isArray(captured.entries) ||
    captured.entries.length > MAX_ENTRIES ||
    captured.entries.length > MAX_EXPORT_ITEMS
  )
    throw invalidResponse();
  const entries = captured.entries.map(parseEntry);
  const entryPaths = new Set<string>();
  for (const entry of entries) {
    if (entryPaths.has(entry.path)) throw invalidResponse();
    entryPaths.add(entry.path);
  }
  return {
    schema_version: 1,
    status: captured.status,
    root: echoedRoot,
    operation_id: captured.operation_id,
    destination_path: captured.destination_path,
    entries,
  };
}

function parseExport(
  value: unknown,
  expected: DocumentExportRequestV1,
): DocumentExportResultV1 {
  const captured = exact(value, [
    'schema_version',
    'status',
    'root',
    'operation_id',
    'item_count',
  ]);
  const echoedRoot = root(captured.root);
  if (
    captured.schema_version !== 1 ||
    !sameRoot(echoedRoot, expected.root) ||
    captured.operation_id !== expected.operation_id ||
    !isUuid(captured.operation_id) ||
    (captured.status !== 'exported' && captured.status !== 'cancelled') ||
    typeof captured.item_count !== 'number' ||
    !Number.isSafeInteger(captured.item_count) ||
    Object.is(captured.item_count, -0) ||
    captured.item_count < 0 ||
    captured.item_count > expected.source_paths.length
  )
    throw invalidResponse();
  return {
    schema_version: 1,
    status: captured.status,
    root: echoedRoot,
    operation_id: captured.operation_id,
    item_count: captured.item_count,
  };
}

function encodeOperationQuery(value: unknown): DocumentOperationQueryRequestV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'operation_id',
    'root',
  ]);
  if (captured.schema_version !== 1 || !isUuid(captured.operation_id))
    throw invalid();
  return {
    schema_version: 1,
    operation_id: captured.operation_id,
    root: root(captured.root),
  };
}

function parseOperationQuery(
  value: unknown,
  expected: { schema_version: 1; operation_id: string },
): DocumentOperationQueryResultV1 {
  const captured = exact(value, ['schema_version', 'operation_id', 'status']);
  const statuses: readonly DocumentOperationStatus[] = [
    'not_started',
    'in_progress',
    'needs_recovery',
    'committed',
    'cleaned',
  ];
  if (
    captured.schema_version !== 1 ||
    captured.operation_id !== expected.operation_id ||
    !isUuid(captured.operation_id) ||
    !statuses.includes(captured.status as DocumentOperationStatus)
  )
    throw invalidResponse();
  return {
    schema_version: 1,
    operation_id: captured.operation_id,
    status: captured.status as DocumentOperationStatus,
  };
}

function encodeOperationRetry(value: unknown): DocumentOperationRetryRequestV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'operation_id',
    'root',
  ]);
  if (captured.schema_version !== 1 || !isUuid(captured.operation_id))
    throw invalid();
  return {
    schema_version: 1,
    operation_id: captured.operation_id,
    root: root(captured.root),
  };
}

function encodeOperationCleanup(
  value: unknown,
): DocumentOperationCleanupRequestV1 {
  const captured = exactRequest(value, [
    'schema_version',
    'operation_id',
    'root',
  ]);
  if (captured.schema_version !== 1 || !isUuid(captured.operation_id))
    throw invalid();
  return {
    schema_version: 1,
    operation_id: captured.operation_id,
    root: root(captured.root),
  };
}

function hasNativeCapabilities(value: unknown): value is NativeLocalDocuments {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<
    Record<keyof NativeLocalDocuments, unknown>
  >;
  return (
    typeof candidate.presentImportPicker === 'function' &&
    typeof candidate.presentExportPicker === 'function' &&
    typeof candidate.queryOperation === 'function' &&
    typeof candidate.retryOperation === 'function' &&
    typeof candidate.cleanupOperation === 'function'
  );
}

function required(): NativeLocalDocuments {
  if (!hasNativeCapabilities(native))
    throw new Error('LocalDocuments native module is not linked');
  return native;
}

export const LocalDocuments = {
  isAvailable: () => hasNativeCapabilities(native),
  presentImportPicker: async (request: DocumentImportRequestV1) => {
    const encoded = encodeImport(request);
    return parseImport(await required().presentImportPicker(encoded), encoded);
  },
  presentExportPicker: async (request: DocumentExportRequestV1) => {
    const encoded = encodeExport(request);
    return parseExport(await required().presentExportPicker(encoded), encoded);
  },
  queryOperation: async (request: DocumentOperationQueryRequestV1) => {
    const encoded = encodeOperationQuery(request);
    return parseOperationQuery(
      await required().queryOperation(encoded),
      encoded,
    );
  },
  retryOperation: async (request: DocumentOperationRetryRequestV1) => {
    const encoded = encodeOperationRetry(request);
    return parseOperationQuery(await required().retryOperation(encoded), {
      schema_version: 1,
      operation_id: encoded.operation_id,
    });
  },
  cleanupOperation: async (request: DocumentOperationCleanupRequestV1) => {
    const encoded = encodeOperationCleanup(request);
    return parseOperationQuery(
      await required().cleanupOperation(encoded),
      encoded,
    );
  },
};

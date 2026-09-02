import { NativeModules } from 'react-native';

import {
  workspaceRoot,
  type WorkspaceRootRefV1,
} from '../src/native/WorkspaceRoot';

const mockNativeLocalDocuments = {
  presentImportPicker: jest.fn(),
  presentExportPicker: jest.fn(),
  queryOperation: jest.fn(),
  retryOperation: jest.fn(),
  cleanupOperation: jest.fn(),
};

const ROOT = workspaceRoot('11111111-1111-4111-8111-111111111111', 2, null);
const PROJECT_ROOT = workspaceRoot(
  ROOT.workspace_id,
  ROOT.binding_revision,
  '44444444-4444-4444-8444-444444444444',
);
const IMPORT_OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const EXPORT_OPERATION_ID = '33333333-3333-4333-8333-333333333333';

(NativeModules as Record<string, unknown>).LocalDocuments =
  mockNativeLocalDocuments;
const { LocalDocuments } = jest.requireActual(
  '../src/native/LocalDocuments',
) as typeof import('../src/native/LocalDocuments');

const imported = {
  schema_version: 1 as const,
  status: 'imported' as const,
  root: ROOT,
  operation_id: IMPORT_OPERATION_ID,
  destination_path: 'docs',
  entries: [{ path: 'docs/note.md', kind: 'file' as const, size: 7 }],
};
const exported = {
  schema_version: 1 as const,
  status: 'exported' as const,
  root: ROOT,
  operation_id: EXPORT_OPERATION_ID,
  item_count: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockNativeLocalDocuments.presentImportPicker.mockResolvedValue(imported);
  mockNativeLocalDocuments.presentExportPicker.mockResolvedValue(exported);
  mockNativeLocalDocuments.queryOperation.mockResolvedValue({
    schema_version: 1,
    operation_id: IMPORT_OPERATION_ID,
    status: 'not_started',
  });
  mockNativeLocalDocuments.retryOperation.mockResolvedValue({
    schema_version: 1,
    operation_id: IMPORT_OPERATION_ID,
    status: 'committed',
  });
  mockNativeLocalDocuments.cleanupOperation.mockResolvedValue({
    schema_version: 1,
    operation_id: IMPORT_OPERATION_ID,
    status: 'cleaned',
  });
});

test('links only when the complete V2 Files operation surface exists', () => {
  expect(LocalDocuments.isAvailable()).toBe(true);
});

test('fails closed when any journal operation method is missing', () => {
  const saved = mockNativeLocalDocuments.cleanupOperation;
  delete (mockNativeLocalDocuments as Record<string, unknown>).cleanupOperation;
  expect(LocalDocuments.isAvailable()).toBe(false);
  mockNativeLocalDocuments.cleanupOperation = saved;
});

test('passes a fresh opaque root envelope, never a path-only authority', async () => {
  const request = {
    schema_version: 1 as const,
    root: ROOT,
    operation_id: IMPORT_OPERATION_ID,
    destination_path: 'docs',
  };
  await LocalDocuments.presentImportPicker(request);
  await LocalDocuments.presentExportPicker({
    schema_version: 1,
    root: ROOT,
    operation_id: EXPORT_OPERATION_ID,
    source_paths: ['README.md'],
  });

  expect(mockNativeLocalDocuments.presentImportPicker).toHaveBeenCalledWith({
    schema_version: 1,
    root: ROOT,
    operation_id: IMPORT_OPERATION_ID,
    destination_path: 'docs',
  });
  expect(
    mockNativeLocalDocuments.presentImportPicker.mock.calls[0][0],
  ).not.toBe(request);
  expect(mockNativeLocalDocuments.presentExportPicker).toHaveBeenCalledWith({
    schema_version: 1,
    root: ROOT,
    operation_id: EXPORT_OPERATION_ID,
    source_paths: ['README.md'],
  });
});

test('passes through and exactly echoes a project-bound root for import and export', async () => {
  mockNativeLocalDocuments.presentImportPicker.mockImplementationOnce(
    async (request: { root: WorkspaceRootRefV1 }) => ({
      ...imported,
      root: request.root,
    }),
  );
  mockNativeLocalDocuments.presentExportPicker.mockImplementationOnce(
    async (request: { root: WorkspaceRootRefV1 }) => ({
      ...exported,
      root: request.root,
    }),
  );

  await expect(
    LocalDocuments.presentImportPicker({
      schema_version: 1,
      root: PROJECT_ROOT,
      operation_id: IMPORT_OPERATION_ID,
      destination_path: 'docs',
    }),
  ).resolves.toMatchObject({ root: PROJECT_ROOT });
  await expect(
    LocalDocuments.presentExportPicker({
      schema_version: 1,
      root: PROJECT_ROOT,
      operation_id: EXPORT_OPERATION_ID,
      source_paths: ['README.md'],
    }),
  ).resolves.toMatchObject({ root: PROJECT_ROOT });

  expect(mockNativeLocalDocuments.presentImportPicker).toHaveBeenCalledWith({
    schema_version: 1,
    root: PROJECT_ROOT,
    operation_id: IMPORT_OPERATION_ID,
    destination_path: 'docs',
  });
  expect(mockNativeLocalDocuments.presentExportPicker).toHaveBeenCalledWith({
    schema_version: 1,
    root: PROJECT_ROOT,
    operation_id: EXPORT_OPERATION_ID,
    source_paths: ['README.md'],
  });
});

test('rejects a project-bound result that changes only project_id', async () => {
  mockNativeLocalDocuments.presentExportPicker.mockResolvedValueOnce({
    ...exported,
    root: workspaceRoot(
      PROJECT_ROOT.workspace_id,
      PROJECT_ROOT.binding_revision,
      '55555555-5555-4555-8555-555555555555',
    ),
  });
  await expect(
    LocalDocuments.presentExportPicker({
      schema_version: 1,
      root: PROJECT_ROOT,
      operation_id: EXPORT_OPERATION_ID,
      source_paths: ['note.md'],
    }),
  ).rejects.toMatchObject({ code: 'E_WORKSPACE_INVALID' });
});

test('preserves cancellation as a normal resolved V2 result', async () => {
  mockNativeLocalDocuments.presentImportPicker.mockResolvedValueOnce({
    schema_version: 1,
    status: 'cancelled',
    root: ROOT,
    operation_id: IMPORT_OPERATION_ID,
    destination_path: '',
    entries: [],
  });
  mockNativeLocalDocuments.presentExportPicker.mockResolvedValueOnce({
    schema_version: 1,
    status: 'cancelled',
    root: ROOT,
    operation_id: EXPORT_OPERATION_ID,
    item_count: 0,
  });
  await expect(
    LocalDocuments.presentImportPicker({
      schema_version: 1,
      root: ROOT,
      operation_id: IMPORT_OPERATION_ID,
      destination_path: '',
    }),
  ).resolves.toEqual({
    schema_version: 1,
    status: 'cancelled',
    root: ROOT,
    operation_id: IMPORT_OPERATION_ID,
    destination_path: '',
    entries: [],
  });
  await expect(
    LocalDocuments.presentExportPicker({
      schema_version: 1,
      root: ROOT,
      operation_id: EXPORT_OPERATION_ID,
      source_paths: ['note.md'],
    }),
  ).resolves.toEqual({
    schema_version: 1,
    status: 'cancelled',
    root: ROOT,
    operation_id: EXPORT_OPERATION_ID,
    item_count: 0,
  });
});

test('rejects a result that changes workspace binding after the await', async () => {
  mockNativeLocalDocuments.presentExportPicker.mockResolvedValueOnce({
    ...exported,
    root: workspaceRoot(ROOT.workspace_id, ROOT.binding_revision + 1),
  });
  await expect(
    LocalDocuments.presentExportPicker({
      schema_version: 1,
      root: ROOT,
      operation_id: EXPORT_OPERATION_ID,
      source_paths: ['note.md'],
    }),
  ).rejects.toMatchObject({ code: 'E_WORKSPACE_INVALID' });
});

test('queries, retries, and cleans a journaled operation by exact root and ID', async () => {
  await expect(
    LocalDocuments.queryOperation({
      schema_version: 1,
      operation_id: IMPORT_OPERATION_ID,
      root: ROOT,
    }),
  ).resolves.toEqual({
    schema_version: 1,
    operation_id: IMPORT_OPERATION_ID,
    status: 'not_started',
  });
  await expect(
    LocalDocuments.retryOperation({
      schema_version: 1,
      operation_id: IMPORT_OPERATION_ID,
      root: ROOT,
    }),
  ).resolves.toEqual({
    schema_version: 1,
    operation_id: IMPORT_OPERATION_ID,
    status: 'committed',
  });
  await expect(
    LocalDocuments.cleanupOperation({
      schema_version: 1,
      operation_id: IMPORT_OPERATION_ID,
      root: ROOT,
    }),
  ).resolves.toEqual({
    schema_version: 1,
    operation_id: IMPORT_OPERATION_ID,
    status: 'cleaned',
  });
  expect(mockNativeLocalDocuments.queryOperation).toHaveBeenCalledWith({
    schema_version: 1,
    operation_id: IMPORT_OPERATION_ID,
    root: ROOT,
  });
  expect(mockNativeLocalDocuments.retryOperation).toHaveBeenCalledWith({
    schema_version: 1,
    operation_id: IMPORT_OPERATION_ID,
    root: ROOT,
  });
  expect(mockNativeLocalDocuments.cleanupOperation).toHaveBeenCalledWith({
    schema_version: 1,
    operation_id: IMPORT_OPERATION_ID,
    root: ROOT,
  });
});

test('accepts project-bound query and cleanup after a picker response is lost', async () => {
  mockNativeLocalDocuments.queryOperation.mockResolvedValueOnce({
    schema_version: 1,
    operation_id: EXPORT_OPERATION_ID,
    status: 'committed',
  });
  await expect(
    LocalDocuments.queryOperation({
      schema_version: 1,
      operation_id: EXPORT_OPERATION_ID,
      root: PROJECT_ROOT,
    }),
  ).resolves.toEqual({
    schema_version: 1,
    operation_id: EXPORT_OPERATION_ID,
    status: 'committed',
  });
  mockNativeLocalDocuments.cleanupOperation.mockResolvedValueOnce({
    schema_version: 1,
    operation_id: EXPORT_OPERATION_ID,
    status: 'cleaned',
  });
  await expect(
    LocalDocuments.cleanupOperation({
      schema_version: 1,
      operation_id: EXPORT_OPERATION_ID,
      root: PROJECT_ROOT,
    }),
  ).resolves.toEqual({
    schema_version: 1,
    operation_id: EXPORT_OPERATION_ID,
    status: 'cleaned',
  });
  expect(mockNativeLocalDocuments.cleanupOperation).toHaveBeenCalledWith({
    schema_version: 1,
    operation_id: EXPORT_OPERATION_ID,
    root: PROJECT_ROOT,
  });
});

test('rejects operation query and cleanup without an exact root', async () => {
  await expect(
    LocalDocuments.queryOperation({
      schema_version: 1,
      operation_id: IMPORT_OPERATION_ID,
    } as never),
  ).rejects.toMatchObject({ code: 'E_WORKSPACE_INVALID' });
  await expect(
    LocalDocuments.cleanupOperation({
      schema_version: 1,
      operation_id: IMPORT_OPERATION_ID,
    } as never),
  ).rejects.toMatchObject({ code: 'E_WORKSPACE_INVALID' });
  expect(mockNativeLocalDocuments.queryOperation).not.toHaveBeenCalled();
  expect(mockNativeLocalDocuments.cleanupOperation).not.toHaveBeenCalled();
});

test('rejects hostile picker requests before native presentation', async () => {
  const withSymbol = {
    schema_version: 1,
    root: ROOT,
    operation_id: IMPORT_OPERATION_ID,
    destination_path: '',
  } as Record<string | symbol, unknown>;
  withSymbol[Symbol('extra')] = true;
  const withAccessor = {
    schema_version: 1,
    root: ROOT,
    operation_id: EXPORT_OPERATION_ID,
    source_paths: ['note.md'],
  } as Record<string, unknown>;
  Object.defineProperty(withAccessor, 'source_paths', {
    enumerable: true,
    get: () => ['note.md'],
  });
  const withHidden = {
    schema_version: 1,
    root: ROOT,
    operation_id: IMPORT_OPERATION_ID,
    source_paths: undefined,
  } as Record<string, unknown>;
  Object.defineProperty(withHidden, 'source_paths', {
    enumerable: false,
    value: ['note.md'],
  });
  const withNonFinite = {
    schema_version: 1,
    root: ROOT,
    operation_id: EXPORT_OPERATION_ID,
    source_paths: [Number.NaN],
  };
  const withHole = {
    schema_version: 1,
    root: ROOT,
    operation_id: EXPORT_OPERATION_ID,
    source_paths: Array(1),
  };

  for (const request of [withSymbol, withAccessor, withHidden]) {
    await expect(
      LocalDocuments.presentImportPicker(request as never),
    ).rejects.toMatchObject({ code: 'E_WORKSPACE_INVALID' });
  }
  for (const request of [withNonFinite, withHole]) {
    await expect(
      LocalDocuments.presentExportPicker(request as never),
    ).rejects.toMatchObject({ code: 'E_WORKSPACE_INVALID' });
  }
  expect(mockNativeLocalDocuments.presentImportPicker).not.toHaveBeenCalled();
  expect(mockNativeLocalDocuments.presentExportPicker).not.toHaveBeenCalled();
});

test('rejects hostile resolved results before exposing them to callers', async () => {
  const withSymbol = { ...imported } as Record<string | symbol, unknown>;
  withSymbol[Symbol('extra')] = true;
  const withAccessor = { ...imported } as Record<string, unknown>;
  Object.defineProperty(withAccessor, 'status', {
    enumerable: true,
    get: () => 'imported',
  });
  const withPrototype = Object.assign(Object.create({ inherited: true }), {
    ...imported,
  });
  const withHidden = { ...exported } as Record<string, unknown>;
  Object.defineProperty(withHidden, 'item_count', {
    enumerable: false,
    value: 1,
  });
  const withNonFinite = { ...exported, item_count: Number.NaN };
  const withNegativeZero = { ...exported, item_count: -0 };
  for (const result of [withSymbol, withAccessor, withPrototype]) {
    mockNativeLocalDocuments.presentImportPicker.mockResolvedValueOnce(result);
    await expect(
      LocalDocuments.presentImportPicker({
        schema_version: 1,
        root: ROOT,
        operation_id: IMPORT_OPERATION_ID,
        destination_path: 'docs',
      }),
    ).rejects.toMatchObject({ code: 'E_WORKSPACE_INVALID' });
  }
  for (const result of [withHidden, withNonFinite, withNegativeZero]) {
    mockNativeLocalDocuments.presentExportPicker.mockResolvedValueOnce(result);
    await expect(
      LocalDocuments.presentExportPicker({
        schema_version: 1,
        root: ROOT,
        operation_id: EXPORT_OPERATION_ID,
        source_paths: ['note.md'],
      }),
    ).rejects.toMatchObject({ code: 'E_WORKSPACE_INVALID' });
  }
});

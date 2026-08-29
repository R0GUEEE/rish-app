const mockNativeLocalWorkspaces = {
  list: jest.fn(),
  resolveMetadata: jest.fn(),
  queryOperation: jest.fn(),
  create: jest.fn(),
  presentFolderPicker: jest.fn(),
  grantFolder: jest.fn(),
  importFolder: jest.fn(),
  forget: jest.fn(),
  deleteOwnedContent: jest.fn(),
  cancelPicker: jest.fn(),
};

import { NativeModules } from 'react-native';

(NativeModules as Record<string, unknown>).LocalWorkspaces =
  mockNativeLocalWorkspaces;
const { LocalWorkspaces } = jest.requireActual(
  '../src/native/LocalWorkspaces',
) as typeof import('../src/native/LocalWorkspaces');

const OK_DESCRIPTOR = {
  schema_version: 2 as const,
  workspace_id: '11111111-1111-4111-8111-111111111111',
  display_name: 'Alpha',
  origin: 'rish_created' as const,
  created_at: '2026-08-27T01:00:00.000Z',
  last_opened_at: '2026-08-27T01:00:00.000Z',
  status: 'ok' as const,
  binding_revision: 1,
  capabilities: {
    read: false,
    write: false,
    git: false,
    project_context: false,
    files_visible: true,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
});

test('links only when every workspace bridge method exists', () => {
  expect(LocalWorkspaces.isAvailable()).toBe(true);

  const previous = (NativeModules as Record<string, unknown>).LocalWorkspaces;
  delete (NativeModules as Record<string, unknown>).LocalWorkspaces;
  expect(LocalWorkspaces.isAvailable()).toBe(false);
  (NativeModules as Record<string, unknown>).LocalWorkspaces = previous;
});

test('throws a clear error when used without the native bridge', async () => {
  const previous = (NativeModules as Record<string, unknown>).LocalWorkspaces;
  delete (NativeModules as Record<string, unknown>).LocalWorkspaces;

  await expect(LocalWorkspaces.list()).rejects.toThrow(
    /LocalWorkspaces native module is not linked/,
  );
  await expect(
    LocalWorkspaces.create({
      schema_version: 1,
      display_name: 'X',
      operation_id: '11111111-1111-4111-8111-111111111111',
    }),
  ).rejects.toThrow(
    /LocalWorkspaces native module is not linked/,
  );

  (NativeModules as Record<string, unknown>).LocalWorkspaces = previous;
});

test('lists workspace descriptors without exposing paths or bookmarks', async () => {
  mockNativeLocalWorkspaces.list.mockResolvedValue({
    schema_version: 1,
    workspaces: [OK_DESCRIPTOR],
  });

  await expect(LocalWorkspaces.list()).resolves.toEqual({
    schema_version: 1,
    workspaces: [OK_DESCRIPTOR],
  });
  expect(mockNativeLocalWorkspaces.list).toHaveBeenCalledWith();
});

test('forwards create, grant, and import intents verbatim', async () => {
  mockNativeLocalWorkspaces.create.mockResolvedValue(OK_DESCRIPTOR);
  mockNativeLocalWorkspaces.grantFolder.mockResolvedValue({
    ...OK_DESCRIPTOR,
    workspace_id: 'ws-granted',
    origin: 'granted_folder',
  });
  mockNativeLocalWorkspaces.importFolder.mockResolvedValue({
    ...OK_DESCRIPTOR,
    workspace_id: 'ws-imported',
    origin: 'imported',
  });

  await expect(
    LocalWorkspaces.create({
      schema_version: 1,
      display_name: 'Alpha',
      operation_id: '11111111-1111-4111-8111-111111111111',
    }),
  ).resolves.toEqual(OK_DESCRIPTOR);
  await expect(
    LocalWorkspaces.grantFolder({
      schema_version: 1,
      operation_id: '11111111-1111-4111-8111-111111111111',
    }),
  ).resolves.toMatchObject({
    workspace_id: 'ws-granted',
  });
  await expect(
    LocalWorkspaces.importFolder({
      schema_version: 1,
      operation_id: '11111111-1111-4111-8111-111111111111',
    }),
  ).resolves.toMatchObject({
    workspace_id: 'ws-imported',
  });

  expect(mockNativeLocalWorkspaces.create).toHaveBeenCalledWith({
    schema_version: 1,
    display_name: 'Alpha',
    operation_id: '11111111-1111-4111-8111-111111111111',
  });
  expect(mockNativeLocalWorkspaces.grantFolder).toHaveBeenCalledWith({
    schema_version: 1,
    operation_id: expect.any(String),
  });
  expect(mockNativeLocalWorkspaces.importFolder).toHaveBeenCalledWith({
    schema_version: 1,
    operation_id: '11111111-1111-4111-8111-111111111111',
  });
});

test('resolves structured access states without translating them', async () => {
  for (const status of [
    'ok',
    'stale',
    'revoked',
    'unavailable',
    'not_downloaded',
  ] as const) {
    mockNativeLocalWorkspaces.resolveMetadata.mockResolvedValueOnce({
      schema_version: 1,
      disposition: 'metadata',
      workspace: { ...OK_DESCRIPTOR, status },
    });
    await expect(
      LocalWorkspaces.resolve({
        schema_version: 1,
        workspace_id: OK_DESCRIPTOR.workspace_id,
        expected_binding_revision: null,
        required_capabilities: [],
      }),
    ).resolves.toEqual({
      schema_version: 1,
      disposition: 'metadata',
      workspace: { ...OK_DESCRIPTOR, status },
    });
  }
  expect(mockNativeLocalWorkspaces.resolveMetadata).toHaveBeenCalledTimes(5);
  expect(mockNativeLocalWorkspaces.resolveMetadata).toHaveBeenLastCalledWith({
    schema_version: 1,
    workspace_id: OK_DESCRIPTOR.workspace_id,
    expected_binding_revision: null,
    required_capabilities: [],
  });
});

test('forgets by opaque id only', async () => {
  mockNativeLocalWorkspaces.forget.mockResolvedValue({ schema_version: 1 });

  await expect(
    LocalWorkspaces.forget({
      schema_version: 1,
      workspace_id: OK_DESCRIPTOR.workspace_id,
      expected_binding_revision: 1,
    }),
  ).resolves.toEqual({
    schema_version: 1,
  });
  expect(mockNativeLocalWorkspaces.forget).toHaveBeenCalledWith({
    schema_version: 1,
    workspace_id: OK_DESCRIPTOR.workspace_id,
    expected_binding_revision: 1,
  });
});

const mockNativeLocalWorkspaces = {
  list: jest.fn(),
  create: jest.fn(),
  grantFolder: jest.fn(),
  importFolder: jest.fn(),
  resolve: jest.fn(),
  forget: jest.fn(),
};

import { NativeModules } from 'react-native';

(NativeModules as Record<string, unknown>).LocalWorkspaces =
  mockNativeLocalWorkspaces;
const { LocalWorkspaces } = jest.requireActual(
  '../src/native/LocalWorkspaces',
) as typeof import('../src/native/LocalWorkspaces');

const OK_DESCRIPTOR = {
  schema_version: 1 as const,
  workspace_id: 'ws-alpha',
  display_name: 'Alpha',
  origin: 'rish_created' as const,
  created_at: '2026-08-27T01:00:00.000Z',
  last_opened_at: '2026-08-27T01:00:00.000Z',
  status: 'ok' as const,
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
  await expect(LocalWorkspaces.create('X')).rejects.toThrow(
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

  await expect(LocalWorkspaces.create('Alpha')).resolves.toEqual(
    OK_DESCRIPTOR,
  );
  await expect(LocalWorkspaces.grantFolder()).resolves.toMatchObject({
    workspace_id: 'ws-granted',
  });
  await expect(LocalWorkspaces.importFolder()).resolves.toMatchObject({
    workspace_id: 'ws-imported',
  });

  expect(mockNativeLocalWorkspaces.create).toHaveBeenCalledWith('Alpha');
  expect(mockNativeLocalWorkspaces.grantFolder).toHaveBeenCalledWith();
  expect(mockNativeLocalWorkspaces.importFolder).toHaveBeenCalledWith();
});

test('resolves structured access states without translating them', async () => {
  for (const status of [
    'ok',
    'stale',
    'revoked',
    'unavailable',
    'not_downloaded',
  ] as const) {
    mockNativeLocalWorkspaces.resolve.mockResolvedValueOnce({
      schema_version: 1,
      workspace_id: 'ws-alpha',
      status,
    });
    await expect(LocalWorkspaces.resolve('ws-alpha')).resolves.toEqual({
      schema_version: 1,
      workspace_id: 'ws-alpha',
      status,
    });
  }
  expect(mockNativeLocalWorkspaces.resolve).toHaveBeenCalledTimes(5);
  expect(mockNativeLocalWorkspaces.resolve).toHaveBeenLastCalledWith(
    'ws-alpha',
  );
});

test('forgets by opaque id only', async () => {
  mockNativeLocalWorkspaces.forget.mockResolvedValue({ schema_version: 1 });

  await expect(LocalWorkspaces.forget('ws-alpha')).resolves.toEqual({
    schema_version: 1,
  });
  expect(mockNativeLocalWorkspaces.forget).toHaveBeenCalledWith('ws-alpha');
});

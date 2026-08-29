import { NativeModules } from 'react-native';

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

(NativeModules as Record<string, unknown>).LocalWorkspaces =
  mockNativeLocalWorkspaces;

const { LocalWorkspaces } = jest.requireActual(
  '../src/native/LocalWorkspaces',
) as typeof import('../src/native/LocalWorkspaces');

const REQUEST = {
  schema_version: 1 as const,
  workspace_id: '11111111-1111-4111-8111-111111111111',
  expected_binding_revision: null,
  required_capabilities: [] as const,
};

const DESCRIPTOR = {
  schema_version: 2 as const,
  workspace_id: REQUEST.workspace_id,
  display_name: 'Rish Workspace',
  origin: 'legacy_app_owned' as const,
  status: 'unavailable' as const,
  binding_revision: 1,
  capabilities: {
    read: false,
    write: false,
    git: false,
    project_context: false,
    files_visible: false,
  },
  created_at: '2026-08-29T00:00:00.000Z',
  last_opened_at: '2026-08-29T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
});

test('forwards an exact metadata resolve request without adding paths', async () => {
  mockNativeLocalWorkspaces.resolveMetadata.mockResolvedValue({
    schema_version: 1,
    disposition: 'metadata',
    workspace: DESCRIPTOR,
  });

  await expect(LocalWorkspaces.resolve(REQUEST)).resolves.toEqual({
    schema_version: 1,
    disposition: 'metadata',
    workspace: DESCRIPTOR,
  });
  expect(mockNativeLocalWorkspaces.resolveMetadata).toHaveBeenCalledWith(REQUEST);
});

test('forwards operation queries and keeps mutators value-free when unavailable', async () => {
  mockNativeLocalWorkspaces.queryOperation.mockResolvedValue({
    schema_version: 1,
    status: 'not_started',
  });
  mockNativeLocalWorkspaces.create.mockRejectedValue(
    Object.assign(new Error('Workspace creation is unavailable.'), {
      code: 'E_WORKSPACE_UNAVAILABLE',
    }),
  );

  await expect(
    LocalWorkspaces.queryOperation({
      schema_version: 1,
      operation_id: REQUEST.workspace_id,
    }),
  ).resolves.toEqual({ schema_version: 1, status: 'not_started' });
  await expect(
    LocalWorkspaces.create({
      schema_version: 1,
      display_name: 'Scratch',
      operation_id: REQUEST.workspace_id,
    }),
  ).rejects.toMatchObject({ code: 'E_WORKSPACE_UNAVAILABLE' });
});

import { NativeModules } from 'react-native';

const ID = '11111111-1111-4111-8111-111111111111';
const mockNativeLocalWorkspaces = {
  list: jest.fn(),
  create: jest.fn(),
  bootstrapLegacyProject: jest.fn(),
  presentFolderPicker: jest.fn(),
  importSelection: jest.fn(),
  cancelSelection: jest.fn(),
  presentRegrantPicker: jest.fn(),
  completeRegrant: jest.fn(),
  resolve: jest.fn(),
  forget: jest.fn(),
  prepareDeleteOwnedContent: jest.fn(),
  deleteOwnedContent: jest.fn(),
  queryOperation: jest.fn(),
  cancelPicker: jest.fn(),
};
(NativeModules as Record<string, unknown>).LocalWorkspaces =
  mockNativeLocalWorkspaces;

const { LocalWorkspaces } = jest.requireActual(
  '../src/native/LocalWorkspaces',
) as typeof import('../src/native/LocalWorkspaces');

const request = {
  schema_version: 1 as const,
  workspace_id: ID,
  expected_binding_revision: null,
  required_capabilities: [] as const,
};

beforeEach(() => {
  (NativeModules as Record<string, unknown>).LocalWorkspaces =
    mockNativeLocalWorkspaces;
  jest.clearAllMocks();
});

test('forwards an exact resolve request to the frozen resolve method', async () => {
  mockNativeLocalWorkspaces.resolve.mockResolvedValue({
    schema_version: 1,
    disposition: 'direct',
    workspace: {
      schema_version: 2,
      workspace_id: ID,
      display_name: 'Rish Workspace',
      origin: 'legacy_app_owned',
      status: 'unavailable',
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
    },
  });
  await expect(LocalWorkspaces.resolve(request)).resolves.toMatchObject({
    schema_version: 1,
    disposition: 'direct',
  });
  expect(mockNativeLocalWorkspaces.resolve).toHaveBeenCalledWith(request);
  expect(
    (mockNativeLocalWorkspaces as Record<string, unknown>).resolveMetadata,
  ).toBeUndefined();
});

test('does not expose the renamed or removed production methods', () => {
  expect('resolveMetadata' in LocalWorkspaces).toBe(false);
  expect('grantFolder' in LocalWorkspaces).toBe(false);
  expect('importFolder' in LocalWorkspaces).toBe(false);
  expect('importSelection' in LocalWorkspaces).toBe(true);
  expect('cancelSelection' in LocalWorkspaces).toBe(true);
  expect('presentRegrantPicker' in LocalWorkspaces).toBe(true);
  expect('completeRegrant' in LocalWorkspaces).toBe(true);
});

test('rejects a native module that still publishes a forbidden alias', () => {
  const native = NativeModules as Record<string, unknown>;
  const previous = native.LocalWorkspaces;
  native.LocalWorkspaces = {
    ...mockNativeLocalWorkspaces,
    resolveMetadata: jest.fn(),
  };
  expect(LocalWorkspaces.isAvailable()).toBe(false);
  native.LocalWorkspaces = previous;
});

test('requires bootstrapLegacyProject in the native capability inventory', () => {
  const native = NativeModules as Record<string, unknown>;
  const previous = native.LocalWorkspaces;
  const incomplete = { ...mockNativeLocalWorkspaces };
  delete (incomplete as Partial<typeof incomplete>).bootstrapLegacyProject;
  native.LocalWorkspaces = incomplete;
  expect(LocalWorkspaces.isAvailable()).toBe(false);
  native.LocalWorkspaces = previous;
});

test('keeps unavailable mutators value-free and queryable', async () => {
  mockNativeLocalWorkspaces.create.mockRejectedValue(
    Object.assign(new Error('Workspace operation is unavailable.'), {
      code: 'E_WORKSPACE_UNAVAILABLE',
    }),
  );
  await expect(
    LocalWorkspaces.create({
      schema_version: 1,
      display_name: 'Scratch',
      operation_id: ID,
    }),
  ).rejects.toMatchObject({ code: 'E_WORKSPACE_UNAVAILABLE' });
  mockNativeLocalWorkspaces.queryOperation.mockResolvedValue({
    schema_version: 1,
    status: 'not_started',
  });
  await expect(
    LocalWorkspaces.queryOperation({ schema_version: 1, operation_id: ID }),
  ).resolves.toEqual({ schema_version: 1, status: 'not_started' });
});

import { NativeModules } from 'react-native';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

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

const descriptor = {
  schema_version: 2 as const,
  workspace_id: ID,
  display_name: 'Alpha',
  origin: 'rish_created' as const,
  created_at: '2026-08-27T01:00:00.000Z',
  last_opened_at: '2026-08-27T01:00:00.000Z',
  status: 'ok' as const,
  binding_revision: 1,
  capabilities: {
    read: true,
    write: true,
    git: false,
    project_context: false,
    files_visible: true,
  },
};

const resolveRequest = {
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

test('links only when the exact V1 bridge method set exists', () => {
  expect(LocalWorkspaces.isAvailable()).toBe(true);
  const previous = (NativeModules as Record<string, unknown>).LocalWorkspaces;
  const incomplete = { ...mockNativeLocalWorkspaces };
  delete (incomplete as Partial<typeof incomplete>).resolve;
  (NativeModules as Record<string, unknown>).LocalWorkspaces = incomplete;
  expect(LocalWorkspaces.isAvailable()).toBe(false);
  (NativeModules as Record<string, unknown>).LocalWorkspaces = previous;
});

test('discovers the required inventory through a HostObject-compatible surface', () => {
  const hostObject = new Proxy(mockNativeLocalWorkspaces, {
    ownKeys() {
      throw new Error('HostObject keys are not enumerable');
    },
    getOwnPropertyDescriptor() {
      throw new Error('HostObject descriptors are unavailable');
    },
  });
  (NativeModules as Record<string, unknown>).LocalWorkspaces = hostObject;
  expect(LocalWorkspaces.isAvailable()).toBe(true);
});

test('fails clearly when the native bridge is not linked', async () => {
  const previous = (NativeModules as Record<string, unknown>).LocalWorkspaces;
  delete (NativeModules as Record<string, unknown>).LocalWorkspaces;
  await expect(LocalWorkspaces.list()).rejects.toMatchObject({
    code: 'E_WORKSPACE_UNAVAILABLE',
    message: expect.stringMatching(/native module is not linked/),
  });
  (NativeModules as Record<string, unknown>).LocalWorkspaces = previous;
});

test('forwards metadata and create requests without paths or bookmark values', async () => {
  mockNativeLocalWorkspaces.list.mockResolvedValue({
    schema_version: 1,
    workspaces: [descriptor],
  });
  mockNativeLocalWorkspaces.create.mockResolvedValue(descriptor);
  await expect(LocalWorkspaces.list()).resolves.toEqual({
    schema_version: 1,
    workspaces: [descriptor],
  });
  await expect(
    LocalWorkspaces.create({
      schema_version: 1,
      display_name: 'Alpha',
      operation_id: ID,
    }),
  ).resolves.toEqual(descriptor);
  expect(mockNativeLocalWorkspaces.create).toHaveBeenCalledWith({
    schema_version: 1,
    display_name: 'Alpha',
    operation_id: ID,
  });
});

test('bootstraps a canonical legacy project through an exact opaque envelope', async () => {
  const result = {
    ...descriptor,
    workspace_id: ID2,
    origin: 'legacy_app_owned' as const,
  };
  mockNativeLocalWorkspaces.bootstrapLegacyProject.mockResolvedValue(result);
  await expect(
    LocalWorkspaces.bootstrapLegacyProject({
      schema_version: 1,
      operation_id: ID,
      project_id: ID2,
    }),
  ).resolves.toEqual(result);
  expect(mockNativeLocalWorkspaces.bootstrapLegacyProject).toHaveBeenCalledWith({
    schema_version: 1,
    operation_id: ID,
    project_id: ID2,
  });

  await expect(
    LocalWorkspaces.bootstrapLegacyProject({
      schema_version: 1,
      operation_id: ID,
      project_id: ID2,
      path: '/private/legacy/repo',
    } as never),
  ).rejects.toMatchObject({ code: 'E_WORKSPACE_INVALID' });
  expect(mockNativeLocalWorkspaces.bootstrapLegacyProject).toHaveBeenCalledTimes(1);

  mockNativeLocalWorkspaces.bootstrapLegacyProject.mockResolvedValue({
    ...result,
    absolute_path: '/private/legacy/repo',
  });
  await expect(
    LocalWorkspaces.bootstrapLegacyProject({
      schema_version: 1,
      operation_id: ID,
      project_id: ID2,
    }),
  ).rejects.toMatchObject({ code: 'E_WORKSPACE_INVALID' });
});

test('uses the exact picker, selection, regrant, and resolve method names', async () => {
  mockNativeLocalWorkspaces.presentFolderPicker.mockResolvedValue({
    schema_version: 1,
    status: 'requires_import',
    selection_id: ID2,
    display_name: 'Provider folder',
    location_class: 'provider_managed',
  });
  mockNativeLocalWorkspaces.resolve.mockResolvedValue({
    schema_version: 1,
    disposition: 'direct',
    workspace: descriptor,
  });
  await expect(
    LocalWorkspaces.presentFolderPicker({
      schema_version: 1,
      operation_id: ID,
      mode: 'grant_or_import',
    }),
  ).resolves.toMatchObject({ status: 'requires_import' });
  await expect(
    LocalWorkspaces.resolve({ ...resolveRequest, expected_binding_revision: 1 }),
  ).resolves.toMatchObject({ disposition: 'direct' });
  expect(mockNativeLocalWorkspaces.presentFolderPicker).toHaveBeenCalledWith({
    schema_version: 1,
    operation_id: ID,
    mode: 'grant_or_import',
  });
  expect(mockNativeLocalWorkspaces.resolve).toHaveBeenCalledWith({
    ...resolveRequest,
    expected_binding_revision: 1,
  });
});

test('rejects the removed method vocabulary and malformed bridge objects locally', async () => {
  const extra = {
    schema_version: 1,
    display_name: 'Alpha',
    operation_id: ID,
    path: '/private/secret',
  };
  await expect(LocalWorkspaces.create(extra as never)).rejects.toMatchObject({
    code: 'E_WORKSPACE_INVALID',
  });
  const accessor = {} as Record<string, unknown>;
  Object.defineProperty(accessor, 'schema_version', {
    enumerable: true,
    get: () => 1,
  });
  accessor.display_name = 'Alpha';
  accessor.operation_id = ID;
  await expect(LocalWorkspaces.create(accessor as never)).rejects.toMatchObject({
    code: 'E_WORKSPACE_INVALID',
  });
  await expect(
    LocalWorkspaces.resolve({
      ...resolveRequest,
      expected_binding_revision: -0,
    }),
  ).rejects.toMatchObject({ code: 'E_WORKSPACE_INVALID' });
  expect(mockNativeLocalWorkspaces.create).not.toHaveBeenCalled();
  expect(mockNativeLocalWorkspaces.resolve).not.toHaveBeenCalled();
});

test('preserves the exact five-status vocabulary', async () => {
  const operationalRequest = { ...resolveRequest, expected_binding_revision: 1 };
  for (const status of [
    'ok',
    'stale',
    'revoked',
    'unavailable',
    'not_downloaded',
  ] as const) {
    mockNativeLocalWorkspaces.resolve.mockResolvedValueOnce({
      schema_version: 1,
      disposition: 'direct',
      workspace: {
        ...descriptor,
        status,
        capabilities: status === 'ok'
          ? descriptor.capabilities
          : { ...descriptor.capabilities, read: false, write: false, git: false, project_context: false },
      },
    });
    await expect(LocalWorkspaces.resolve(operationalRequest)).resolves.toMatchObject({
      workspace: { status },
    });
  }
  expect(mockNativeLocalWorkspaces.resolve).toHaveBeenCalledTimes(5);
});

test('parses native results into fresh canonical objects and rejects private fields', async () => {
  const nativeResult = {
    schema_version: 1,
    workspaces: [descriptor],
  };
  mockNativeLocalWorkspaces.list.mockResolvedValue(nativeResult);
  const parsed = await LocalWorkspaces.list();
  expect(parsed).toEqual(nativeResult);
  expect(parsed).not.toBe(nativeResult);
  expect(parsed.workspaces[0]).not.toBe(nativeResult.workspaces[0]);
  nativeResult.workspaces[0].display_name = 'mutated';
  expect(parsed.workspaces[0].display_name).toBe('Alpha');

  mockNativeLocalWorkspaces.queryOperation.mockResolvedValue({
    schema_version: 1,
    status: 'committed',
    receipt: {
      schema_version: 1,
      operation_id: ID,
      workspace_id: ID,
      operation: 'create',
      binding_revision: 1,
      registry_generation: 1,
      registry_sha256: 'a'.repeat(64),
      request_sha256: 'b'.repeat(64),
      outcome: 'committed',
      committed_at: '2026-08-27T01:00:00.000Z',
    },
  });
  await expect(
    LocalWorkspaces.queryOperation({ schema_version: 1, operation_id: ID }),
  ).rejects.toMatchObject({ code: 'E_WORKSPACE_INVALID' });
});

test('rejects operational capabilities on non-ok descriptors and metadata probes', async () => {
  mockNativeLocalWorkspaces.resolve.mockResolvedValue({
    schema_version: 1,
    disposition: 'direct',
    workspace: descriptor,
  });
  await expect(LocalWorkspaces.resolve(resolveRequest)).rejects.toMatchObject({
    code: 'E_WORKSPACE_INVALID',
  });
  mockNativeLocalWorkspaces.resolve.mockResolvedValue({
    schema_version: 1,
    disposition: 'direct',
    workspace: {
      ...descriptor,
      status: 'stale',
      capabilities: descriptor.capabilities,
    },
  });
  await expect(LocalWorkspaces.resolve({ ...resolveRequest, expected_binding_revision: 1 })).rejects.toMatchObject({
    code: 'E_WORKSPACE_INVALID',
  });
});

test('passes a fresh plain request object even when the caller supplies a Proxy', async () => {
  mockNativeLocalWorkspaces.create.mockResolvedValue(descriptor);
  const target = {
    schema_version: 1 as const,
    display_name: 'Alpha',
    operation_id: ID,
  };
  const source = new Proxy(target, {
    get(_target, property) {
      if (property === 'display_name') return 'Changed after validation';
      return Reflect.get(target, property);
    },
  });
  await LocalWorkspaces.create(source);
  const forwarded = mockNativeLocalWorkspaces.create.mock.calls[0][0];
  expect(forwarded).not.toBe(source);
  expect(Object.getPrototypeOf(forwarded)).toBe(Object.prototype);
  expect(forwarded).toEqual({
    schema_version: 1,
    display_name: 'Alpha',
    operation_id: ID,
  });
});

test('forgets, deletes, queries, and cancels using opaque IDs and exact envelopes', async () => {
  const forget = {
    schema_version: 1 as const,
    workspace_id: ID,
    expected_binding_revision: 1,
    operation_id: ID2,
    clearance_receipt_id: ID,
  };
  mockNativeLocalWorkspaces.forget.mockResolvedValue({
    schema_version: 1,
    status: 'forgotten',
  });
  await expect(LocalWorkspaces.forget(forget)).resolves.toEqual({
    schema_version: 1,
    status: 'forgotten',
  });
  expect(mockNativeLocalWorkspaces.forget).toHaveBeenCalledWith(forget);
  mockNativeLocalWorkspaces.queryOperation.mockResolvedValue({
    schema_version: 1,
    status: 'not_started',
  });
  await expect(
    LocalWorkspaces.queryOperation({ schema_version: 1, operation_id: ID }),
  ).resolves.toEqual({ schema_version: 1, status: 'not_started' });
  mockNativeLocalWorkspaces.cancelPicker.mockResolvedValue({
    schema_version: 1,
    status: 'already_settled',
  });
  await expect(
    LocalWorkspaces.cancelPicker({ schema_version: 1, operation_id: ID }),
  ).resolves.toEqual({ schema_version: 1, status: 'already_settled' });
});

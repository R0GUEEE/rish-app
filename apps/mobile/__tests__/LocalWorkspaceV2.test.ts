import { NativeModules } from 'react-native';

import { workspaceRoot } from '../src/native/WorkspaceRoot';

const mockNativeLocalWorkspace = {
  listV2: jest.fn(),
  readV2: jest.fn(),
  writeV2: jest.fn(),
};

(NativeModules as Record<string, unknown>).LocalWorkspace =
  mockNativeLocalWorkspace;
const { LocalWorkspace } = jest.requireActual(
  '../src/native/LocalWorkspace',
) as typeof import('../src/native/LocalWorkspace');

const ROOT = workspaceRoot('11111111-1111-4111-8111-111111111111', 1, null);
const PROJECT_ROOT = workspaceRoot(
  ROOT.workspace_id,
  ROOT.binding_revision,
  '22222222-2222-4222-8222-222222222222',
);
const FILE = {
  path: 'note.md',
  name: 'note.md',
  kind: 'file' as const,
  size: 5,
  modified_at: '2026-08-24T00:00:00.000Z',
  revision: 'a'.repeat(64),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockNativeLocalWorkspace.listV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    path: '',
    entries: [],
  });
  mockNativeLocalWorkspace.readV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    path: FILE.path,
    file: FILE,
    content: 'hello',
  });
  mockNativeLocalWorkspace.writeV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    file: FILE,
    created: false,
  });
});

test('requires the opaque root on every V2 filesystem request', async () => {
  await LocalWorkspace.listV2({
    schema_version: 1,
    root: ROOT,
    path: '',
    max_entries: 10,
  });
  await LocalWorkspace.readV2({
    schema_version: 1,
    root: ROOT,
    path: FILE.path,
    max_bytes: 100,
  });
  await LocalWorkspace.writeV2({
    schema_version: 1,
    root: ROOT,
    path: FILE.path,
    content: 'updated',
    expected_revision: FILE.revision,
    create_only: false,
  });
  expect(mockNativeLocalWorkspace.listV2.mock.calls[0][0]).toEqual({
    schema_version: 1,
    root: ROOT,
    path: '',
    max_entries: 10,
  });
  expect(mockNativeLocalWorkspace.readV2.mock.calls[0][0]).toEqual({
    schema_version: 1,
    root: ROOT,
    path: FILE.path,
    max_bytes: 100,
  });
});

test('snapshots an input root and rejects path-only or traversal requests', async () => {
  const changing = new Proxy(ROOT, {
    get(target, property) {
      if (property === 'workspace_id')
        return 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      return Reflect.get(target, property);
    },
  });
  await LocalWorkspace.listV2({
    schema_version: 1,
    root: changing,
    path: '',
    max_entries: 10,
  });
  expect(mockNativeLocalWorkspace.listV2.mock.calls[0][0].root).toEqual(ROOT);
  await expect(
    LocalWorkspace.readV2({
      schema_version: 1,
      root: ROOT,
      path: '../private.txt',
      max_bytes: 100,
    }),
  ).rejects.toMatchObject({ code: 'E_WORKSPACE_INVALID' });
});

test('rejects a native result that changes the root binding', async () => {
  mockNativeLocalWorkspace.readV2.mockResolvedValueOnce({
    schema_version: 1,
    root: workspaceRoot(ROOT.workspace_id, ROOT.binding_revision + 1),
    path: FILE.path,
    file: FILE,
    content: 'hello',
  });
  await expect(
    LocalWorkspace.readV2({
      schema_version: 1,
      root: ROOT,
      path: FILE.path,
      max_bytes: 100,
    }),
  ).rejects.toMatchObject({ code: 'E_WORKSPACE_INVALID' });
});

test('passes through and exactly echoes a project-bound root tuple', async () => {
  mockNativeLocalWorkspace.listV2.mockResolvedValueOnce({
    schema_version: 1,
    root: PROJECT_ROOT,
    path: '',
    entries: [],
  });
  await expect(
    LocalWorkspace.listV2({
      schema_version: 1,
      root: PROJECT_ROOT,
      path: '',
      max_entries: 10,
    }),
  ).resolves.toEqual({
    schema_version: 1,
    root: PROJECT_ROOT,
    path: '',
    entries: [],
  });
  expect(mockNativeLocalWorkspace.listV2).toHaveBeenCalledWith({
    schema_version: 1,
    root: PROJECT_ROOT,
    path: '',
    max_entries: 10,
  });
});

test('rejects a project-bound response with the wrong project tuple', async () => {
  mockNativeLocalWorkspace.listV2.mockResolvedValueOnce({
    schema_version: 1,
    root: workspaceRoot(
      PROJECT_ROOT.workspace_id,
      PROJECT_ROOT.binding_revision,
      '33333333-3333-4333-8333-333333333333',
    ),
    path: '',
    entries: [],
  });
  await expect(
    LocalWorkspace.listV2({
      schema_version: 1,
      root: PROJECT_ROOT,
      path: '',
      max_entries: 10,
    }),
  ).rejects.toMatchObject({ code: 'E_WORKSPACE_INVALID' });
});

test('rejects hostile exact-request shapes before native work', async () => {
  const cases: unknown[] = [];
  cases.push({
    schema_version: 1,
    root: ROOT,
    path: '',
    max_entries: Number.NaN,
  });
  cases.push({
    schema_version: 1,
    root: ROOT,
    path: '',
    max_entries: Number.POSITIVE_INFINITY,
  });
  cases.push({
    schema_version: 1,
    root: ROOT,
    path: '',
    max_entries: -0,
  });
  const withSymbol = {
    schema_version: 1,
    root: ROOT,
    path: '',
    max_entries: 10,
  } as Record<string | symbol, unknown>;
  withSymbol[Symbol('extra')] = true;
  cases.push(withSymbol);
  const withAccessor = {
    schema_version: 1,
    root: ROOT,
    max_entries: 10,
  } as Record<string, unknown>;
  Object.defineProperty(withAccessor, 'path', {
    enumerable: true,
    get: () => '',
  });
  cases.push(withAccessor);
  const withHidden = {
    schema_version: 1,
    root: ROOT,
    path: '',
  } as Record<string, unknown>;
  Object.defineProperty(withHidden, 'max_entries', {
    enumerable: false,
    value: 10,
  });
  cases.push(withHidden);
  cases.push(
    Object.assign(Object.create({ inherited: true }), {
      schema_version: 1,
      root: ROOT,
      path: '',
      max_entries: 10,
    }),
  );

  for (const request of cases) {
    await expect(LocalWorkspace.listV2(request as never)).rejects.toMatchObject(
      {
        code: 'E_WORKSPACE_INVALID',
      },
    );
  }
  expect(mockNativeLocalWorkspace.listV2).not.toHaveBeenCalled();
});

test('rejects hostile resolved list shapes before exposing them to callers', async () => {
  const valid = {
    schema_version: 1,
    root: ROOT,
    path: '',
    entries: [FILE],
  };
  const withSymbol = { ...valid } as Record<string | symbol, unknown>;
  withSymbol[Symbol('extra')] = true;
  const withAccessor = { ...valid } as Record<string, unknown>;
  Object.defineProperty(withAccessor, 'entries', {
    enumerable: true,
    get: () => [FILE],
  });
  const withPrototype = Object.assign(Object.create({ inherited: true }), {
    ...valid,
  });
  const withHidden = { ...valid } as Record<string, unknown>;
  Object.defineProperty(withHidden, 'entries', {
    enumerable: false,
    value: [FILE],
  });
  const withNonFinite = {
    ...valid,
    entries: [{ ...FILE, size: Number.POSITIVE_INFINITY }],
  };
  const withNegativeZero = {
    ...valid,
    entries: [{ ...FILE, size: -0 }],
  };
  for (const result of [
    withSymbol,
    withAccessor,
    withPrototype,
    withHidden,
    withNonFinite,
    withNegativeZero,
  ]) {
    mockNativeLocalWorkspace.listV2.mockResolvedValueOnce(result);
    await expect(
      LocalWorkspace.listV2({
        schema_version: 1,
        root: ROOT,
        path: '',
        max_entries: 10,
      }),
    ).rejects.toMatchObject({ code: 'E_WORKSPACE_INVALID' });
  }
});

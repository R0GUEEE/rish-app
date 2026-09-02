import { NativeModules } from 'react-native';

const native = {
  attachWorkspaceProject: jest.fn(),
  projectForWorkspaceV2: jest.fn(),
  prepareProjectDetachV1: jest.fn(),
  commitProjectDetachV1: jest.fn(),
  statusV2: jest.fn(),
  diffV2: jest.fn(),
  stageAllV2: jest.fn(),
  commitV2: jest.fn(),
  pushV2: jest.fn(),
};

(NativeModules as Record<string, unknown>).LocalProjects = native;

const { LocalProjects, ProjectGitBridgeError } = jest.requireActual(
  '../src/native/LocalProjects',
) as typeof import('../src/native/LocalProjects');

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const CHECKPOINT_ID = '44444444-4444-4444-8444-444444444444';
const CLEARANCE_ID = '55555555-5555-4555-8555-555555555555';
const SHA = 'a'.repeat(64);
const OID = 'b'.repeat(40);

function root() {
  return {
    schema_version: 1 as const,
    workspace_id: WORKSPACE_ID,
    binding_revision: 3,
    project_id: PROJECT_ID,
  };
}

function project() {
  return {
    schema_version: 2 as const,
    project_id: PROJECT_ID,
    workspace_id: WORKSPACE_ID,
    workspace_binding_revision: 3,
    display_name: 'V2 Project',
    git_topology: 'private_split_gitdir' as const,
  };
}

function status() {
  return {
    schema_version: 2,
    root: root(),
    project_id: PROJECT_ID,
    branch: 'main',
    head_oid: OID,
    clean: true,
    has_conflicts: false,
    ahead: 0,
    behind: 0,
    entries: [],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  native.attachWorkspaceProject.mockResolvedValue({
    schema_version: 1,
    status: 'attached',
    project: project(),
  });
  native.projectForWorkspaceV2.mockResolvedValue({
    schema_version: 1,
    status: 'attached',
    project: project(),
  });
  native.prepareProjectDetachV1.mockResolvedValue({
    schema_version: 1,
    checkpoint_id: CHECKPOINT_ID,
    project_id: PROJECT_ID,
    workspace_id: WORKSPACE_ID,
    binding_revision: 3,
    gitdir_sha256: SHA,
    mode: 'retain_private_gitdir',
    created_at: '2026-08-31T00:00:00.000Z',
  });
  native.commitProjectDetachV1.mockResolvedValue({
    schema_version: 1,
    status: 'detached',
  });
  native.statusV2.mockResolvedValue(status());
  native.diffV2.mockResolvedValue({
    schema_version: 2,
    root: root(),
    project_id: PROJECT_ID,
    staged: false,
    truncated: false,
    patch: '',
    files: [],
  });
  native.stageAllV2.mockResolvedValue(status());
  native.commitV2.mockResolvedValue({
    schema_version: 2,
    root: root(),
    project_id: PROJECT_ID,
    oid: OID,
    summary: 'commit',
    committed_at: '2026-08-31T00:00:00.000Z',
  });
  native.pushV2.mockResolvedValue({
    schema_version: 2,
    root: root(),
    project_id: PROJECT_ID,
    remote: 'origin',
    branch: 'main',
    oid: OID,
    pushed_at: '2026-08-31T00:00:00.000Z',
  });
});

test('requires the complete V2 Git capability set and echoes the root', async () => {
  expect(LocalProjects.isV2Available()).toBe(true);
  const partialNative = native as { stageAllV2?: jest.Mock };
  const stageAll = partialNative.stageAllV2;
  delete partialNative.stageAllV2;
  expect(LocalProjects.isV2Available()).toBe(false);
  partialNative.stageAllV2 = stageAll;

  await expect(
    LocalProjects.statusV2({ schema_version: 1, root: root() }),
  ).resolves.toMatchObject({ schema_version: 2, root: root() });
  await expect(
    LocalProjects.diffV2({ schema_version: 1, root: root(), max_bytes: 1024 }),
  ).resolves.toMatchObject({ schema_version: 2, root: root() });
  await expect(
    LocalProjects.commitV2({
      schema_version: 1,
      root: root(),
      operation_id: OPERATION_ID,
      message: 'commit',
      author_name: 'Rish',
      author_email: 'rish@example.invalid',
      expected_head_oid: OID,
    }),
  ).resolves.toMatchObject({ schema_version: 2, root: root() });
  await expect(
    LocalProjects.pushV2({
      schema_version: 1,
      root: root(),
      operation_id: OPERATION_ID,
      remote: 'origin',
      expected_local_oid: OID,
      credential_reference: CLEARANCE_ID,
      https_proxy_url: 'http://127.0.0.1:7890/',
    }),
  ).resolves.toMatchObject({ schema_version: 2, root: root() });
  expect(native.pushV2).toHaveBeenCalledWith({
    schema_version: 1,
    root: root(),
    operation_id: OPERATION_ID,
    remote: 'origin',
    expected_local_oid: OID,
    credential_reference: CLEARANCE_ID,
    https_proxy_url: 'http://127.0.0.1:7890/',
  });
  await expect(
    LocalProjects.pushV2({
      schema_version: 1,
      root: root(),
      operation_id: OPERATION_ID,
      remote: 'origin',
      expected_local_oid: OID,
      credential_reference: CLEARANCE_ID,
      https_proxy_url: null,
    }),
  ).resolves.toMatchObject({ schema_version: 2, root: root() });
  expect(native.pushV2).toHaveBeenLastCalledWith({
    schema_version: 1,
    root: root(),
    operation_id: OPERATION_ID,
    remote: 'origin',
    expected_local_oid: OID,
    credential_reference: CLEARANCE_ID,
    https_proxy_url: null,
  });
  expect(native.statusV2).toHaveBeenCalledWith({ schema_version: 1, root: root() });
});

test('preserves a null expected head as the unborn-head precondition', async () => {
  await expect(
    LocalProjects.commitV2({
      schema_version: 1,
      root: root(),
      operation_id: OPERATION_ID,
      message: 'initial commit',
      author_name: 'Rish',
      author_email: 'rish@example.invalid',
      expected_head_oid: null,
    }),
  ).resolves.toMatchObject({ schema_version: 2, root: root() });
  expect(native.commitV2).toHaveBeenCalledWith({
    schema_version: 1,
    root: root(),
    operation_id: OPERATION_ID,
    message: 'initial commit',
    author_name: 'Rish',
    author_email: 'rish@example.invalid',
    expected_head_oid: null,
  });
});

test('validates attach and detach relations without forwarding hostile fields', async () => {
  await expect(
    LocalProjects.attachWorkspaceProject({
      schema_version: 1,
      operation_id: OPERATION_ID,
      root: { ...root(), project_id: null },
      mode: 'init',
    }),
  ).resolves.toMatchObject({ status: 'attached', project: project() });
  await expect(
    LocalProjects.projectForWorkspaceV2({ ...root(), project_id: null }),
  ).resolves.toMatchObject({ status: 'attached', project: project() });
  const checkpoint = await LocalProjects.prepareProjectDetachV1({
    schema_version: 1,
    operation_id: OPERATION_ID,
    root: root(),
    mode: 'retain_private_gitdir',
  });
  expect(checkpoint.project_id).toBe(PROJECT_ID);
  await expect(
    LocalProjects.commitProjectDetachV1({
      schema_version: 1,
      operation_id: OPERATION_ID,
      checkpoint,
      clearance_receipt_id: CLEARANCE_ID,
    }),
  ).resolves.toEqual({ schema_version: 1, status: 'detached' });

  await expect(
    LocalProjects.statusV2({
      schema_version: 1,
      root: root(),
      absolute_path: '/private/raw-sentinel',
    }),
  ).rejects.toMatchObject({
    name: 'ProjectGitBridgeError',
    code: 'E_PROJECT_REQUEST_INVALID',
  });
  expect(native.statusV2).toHaveBeenCalledTimes(0);
});

test('collapses malformed V2 results and hostile errors to value-free codes', async () => {
  native.statusV2.mockResolvedValueOnce({ ...status(), root: { ...root(), binding_revision: 4 } });
  await expect(
    LocalProjects.statusV2({ schema_version: 1, root: root() }),
  ).rejects.toMatchObject({ code: 'E_PROJECT_RESULT_INVALID' });

  native.statusV2.mockRejectedValueOnce({
    code: 'E_PROJECT_BUSY',
    message: 'private-path-sentinel',
  });
  await expect(
    LocalProjects.statusV2({ schema_version: 1, root: root() }),
  ).rejects.toEqual(new ProjectGitBridgeError('E_PROJECT_BUSY'));

  native.statusV2.mockResolvedValueOnce(
    Object.assign(Object.create(null), status()),
  );
  await expect(
    LocalProjects.statusV2({ schema_version: 1, root: root() }),
  ).rejects.toMatchObject({ code: 'E_PROJECT_RESULT_INVALID' });
});

test('rejects an absent credential reference before dispatching push', async () => {
  await expect(
    LocalProjects.pushV2({
      schema_version: 1,
      root: root(),
      operation_id: OPERATION_ID,
      remote: 'origin',
      expected_local_oid: OID,
      credential_reference: '',
      https_proxy_url: null,
    }),
  ).rejects.toMatchObject({ code: 'E_PROJECT_REQUEST_INVALID' });
  expect(native.pushV2).not.toHaveBeenCalled();
});

test('rejects non-canonical V2 proxy values before dispatching push', async () => {
  for (const proxy of [
    '',
    'http://127.0.0.1',
    'http://127.0.0.1:7890?secret=raw',
    'ftp://127.0.0.1:7890/',
  ]) {
    await expect(
      LocalProjects.pushV2({
        schema_version: 1,
        root: root(),
        operation_id: OPERATION_ID,
        remote: 'origin',
        expected_local_oid: OID,
        credential_reference: CLEARANCE_ID,
        https_proxy_url: proxy,
      }),
    ).rejects.toMatchObject({ code: 'E_PROJECT_REQUEST_INVALID' });
  }
  expect(native.pushV2).not.toHaveBeenCalled();
});

test('rejects a V2 push result whose root binding is stale', async () => {
  native.pushV2.mockResolvedValueOnce({
    schema_version: 2,
    root: { ...root(), binding_revision: root().binding_revision + 1 },
    project_id: PROJECT_ID,
    remote: 'origin',
    branch: 'main',
    oid: OID,
    pushed_at: '2026-08-31T00:00:00.000Z',
  });
  await expect(
    LocalProjects.pushV2({
      schema_version: 1,
      root: root(),
      operation_id: OPERATION_ID,
      remote: 'origin',
      expected_local_oid: OID,
      credential_reference: CLEARANCE_ID,
      https_proxy_url: 'https://proxy.example.com:8443/',
    }),
  ).rejects.toMatchObject({ code: 'E_PROJECT_RESULT_INVALID' });
});

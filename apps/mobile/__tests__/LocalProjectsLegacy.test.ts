import { NativeModules } from 'react-native';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

const native = {
  list: jest.fn(),
  create: jest.fn(),
  clone: jest.fn(),
  startClone: jest.fn(),
  cloneStatus: jest.fn(),
  cancelClone: jest.fn(),
  status: jest.fn(),
  diff: jest.fn(),
  stageAll: jest.fn(),
  commit: jest.fn(),
  setRemote: jest.fn(),
  credentialStatus: jest.fn(),
  presentCredentialPrompt: jest.fn(),
  clearCredential: jest.fn(),
  push: jest.fn(),
};

(NativeModules as Record<string, unknown>).LocalProjects = native;

const { LocalProjects } = jest.requireActual(
  '../src/native/LocalProjects',
) as typeof import('../src/native/LocalProjects');

function project() {
  return {
    schema_version: 1 as const,
    id: PROJECT_ID,
    name: 'Legacy project',
    workspace_path: `projects/${PROJECT_ID}/repo`,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:01.000Z',
    origin_url: 'https://github.com/example/repository.git',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('validates and deep-copies canonical legacy listing rows', async () => {
  const row = project();
  const response = { schema_version: 1, projects: [row] };
  native.list.mockResolvedValue(response);
  const listing = await LocalProjects.list();
  expect(listing).toEqual(response);
  expect(listing).not.toBe(response);
  expect(listing.projects).not.toBe(response.projects);
  expect(listing.projects[0]).not.toBe(row);
  row.name = 'mutated after resolution';
  expect(listing.projects[0]?.name).toBe('Legacy project');
});

test.each([
  ['non-canonical id', { id: 'project-1' }],
  [
    'mismatched workspace path',
    { workspace_path: `projects/${PROJECT_ID}/other` },
  ],
  ['oversized name', { name: 'x'.repeat(121) }],
  ['unsafe timestamp', { updated_at: '2026-02-30T00:00:00.000Z' }],
  [
    'credential URL',
    { origin_url: 'https://token@example.com/repository.git' },
  ],
  [
    'query URL',
    { origin_url: 'https://example.com/repository.git?token=secret' },
  ],
] as const)(
  'rejects %s without returning native values',
  async (_label, change) => {
    native.list.mockResolvedValue({
      schema_version: 1,
      projects: [{ ...project(), ...change }],
    });
    await expect(LocalProjects.list()).rejects.toMatchObject({
      code: 'E_PROJECT_RESULT_INVALID',
    });
  },
);

test('rejects getter, prototype, and extra-field rows without invoking getters', async () => {
  let getterCalls = 0;
  const accessor = { ...project() } as Record<string, unknown>;
  Object.defineProperty(accessor, 'name', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'private-path-sentinel';
    },
  });
  for (const row of [
    accessor,
    Object.assign(Object.create(null), project()),
    { ...project(), absolute_path: '/private/path-sentinel' },
  ]) {
    native.list.mockResolvedValueOnce({ schema_version: 1, projects: [row] });
    await expect(LocalProjects.list()).rejects.toMatchObject({
      code: 'E_PROJECT_RESULT_INVALID',
    });
  }
  expect(getterCalls).toBe(0);
});

function operation(phase = 'receiving') {
  return {
    schema_version: 1,
    operation_id: PROJECT_ID,
    name: 'copy',
    phase,
    cancel_requested: false,
    received_objects: 2,
    total_objects: 3,
    received_bytes: 1024,
    completed_files: 0,
    total_files: 0,
    project: null,
    error_code: null,
  };
}

test('validates clone status and preserves native operation identity', async () => {
  native.startClone.mockResolvedValue(operation());
  expect(
    await LocalProjects.startClone('https://example.com/copy.git'),
  ).toEqual(operation());
  native.cloneStatus.mockResolvedValue({
    ...operation(),
    operation_id: '22222222-2222-4222-8222-222222222222',
  });
  await expect(LocalProjects.cloneStatus(PROJECT_ID)).rejects.toMatchObject({
    code: 'E_PROJECT_RESULT_INVALID',
  });
  native.cancelClone.mockResolvedValue({
    ...operation(),
    cancel_requested: true,
  });
  expect((await LocalProjects.cancelClone(PROJECT_ID)).cancel_requested).toBe(
    true,
  );
});

test.each([
  { received_bytes: -1 },
  { total_objects: Infinity },
  { phase: 'unknown' },
  { phase: 'succeeded', project: null },
  { phase: 'failed', error_code: null },
  { phase: 'receiving', project: project() },
  { error_code: 'secret-server-detail' },
  { absolute_path: '/private/path' },
])('rejects malformed clone snapshots: %j', async change => {
  native.cloneStatus.mockResolvedValue({ ...operation(), ...change });
  await expect(LocalProjects.cloneStatus()).rejects.toMatchObject({
    code: 'E_PROJECT_RESULT_INVALID',
  });
});

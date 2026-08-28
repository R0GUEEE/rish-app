const mockNativeLocalProjectContext = {
  listProjectContextCandidates: jest.fn(),
  prepareProjectContext: jest.fn(),
  confirmProjectContext: jest.fn(),
  inspectProjectContext: jest.fn(),
  discardProjectContext: jest.fn(),
};

import { NativeModules } from 'react-native';

(NativeModules as Record<string, unknown>).LocalProjectContext =
  mockNativeLocalProjectContext;

const { LocalProjectContext, ProjectContextBridgeError } = jest.requireActual(
  '../src/native/LocalProjectContext',
) as typeof import('../src/native/LocalProjectContext');

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const SNAPSHOT_ID = '33333333-3333-4333-8333-333333333333';
const CONSENT_ID = '44444444-4444-4444-8444-444444444444';
const SHA = 'a'.repeat(64);
const REVISION = 'b'.repeat(64);

function selection() {
  return {
    schema_version: 1 as const,
    project_id: PROJECT_ID,
    conversation_id: CONVERSATION_ID,
    provider: 'deepseek' as const,
    model: 'deepseek-v4-flash' as const,
    policy: 'chat-read-v1' as const,
    selected_paths: ['src/z.ts', 'README.md'],
  };
}

function candidate(path = 'README.md') {
  return {
    path,
    size: 12,
    revision: REVISION,
    git_state: 'unchanged',
    eligible: true,
    omission_reason: null,
  };
}

function page() {
  return {
    schema_version: 1,
    project_id: PROJECT_ID,
    candidates: [candidate()],
    next_cursor: null,
  };
}

function manifest() {
  return {
    schema_version: 1,
    snapshot_id: SNAPSHOT_ID,
    project_id: PROJECT_ID,
    project_name: 'Fixture',
    branch: 'main',
    head_oid: 'c'.repeat(40),
    clean: true,
    conflicted: false,
    captured_at: '2026-08-28T00:00:00.000Z',
    policy_version: 'chat-read-v1.0.0',
    provider_host: 'api.deepseek.com',
    model: 'deepseek-v4-flash',
    included: [
      {
        path: 'README.md',
        source: 'tracked_file',
        bytes: 12,
        sha256: SHA,
      },
    ],
    omitted: [{ path: '.env', reason: 'secret_path' }],
    context_bytes: 20,
    estimated_tokens: 5,
    snapshot_sha256: SHA,
    source_fingerprint: SHA,
  };
}

function consent() {
  return {
    schema_version: 1,
    consent_receipt_id: CONSENT_ID,
    snapshot_id: SNAPSHOT_ID,
    snapshot_sha256: SHA,
    confirmed_at: '2026-08-28T00:00:01.000Z',
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({
    name: 'ProjectContextBridgeError',
    code,
    message: code,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (NativeModules as Record<string, unknown>).LocalProjectContext =
    mockNativeLocalProjectContext;
  mockNativeLocalProjectContext.listProjectContextCandidates.mockResolvedValue(
    page(),
  );
  mockNativeLocalProjectContext.prepareProjectContext.mockResolvedValue(
    manifest(),
  );
  mockNativeLocalProjectContext.confirmProjectContext.mockResolvedValue(
    consent(),
  );
  mockNativeLocalProjectContext.inspectProjectContext.mockResolvedValue({
    schema_version: 1,
    state: 'confirmed',
    manifest: manifest(),
  });
  mockNativeLocalProjectContext.discardProjectContext.mockResolvedValue({
    schema_version: 1,
    status: 'discarded',
  });
});

test('availability requires all five native methods', async () => {
  expect(LocalProjectContext.isAvailable()).toBe(true);
  const incomplete = { ...mockNativeLocalProjectContext } as Record<
    string,
    unknown
  >;
  delete incomplete.inspectProjectContext;
  (NativeModules as Record<string, unknown>).LocalProjectContext = incomplete;
  expect(LocalProjectContext.isAvailable()).toBe(false);
  await expectCode(
    LocalProjectContext.inspect(SNAPSHOT_ID),
    'E_CONTEXT_NATIVE',
  );
});

test('projects an exact immutable sorted selection before native dispatch', async () => {
  const input = selection();
  const pending = LocalProjectContext.prepare(input);
  input.selected_paths[0] = 'mutated-secret';
  await pending;
  expect(mockNativeLocalProjectContext.prepareProjectContext).toHaveBeenCalledWith({
    schema_version: 1,
    project_id: PROJECT_ID,
    conversation_id: CONVERSATION_ID,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    policy: 'chat-read-v1',
    selected_paths: ['README.md', 'src/z.ts'],
  });

  const extra = { ...selection(), raw_content: 'request-sentinel' };
  await expectCode(
    LocalProjectContext.prepare(extra),
    'E_CONTEXT_REQUEST_INVALID',
  );
  expect(
    JSON.stringify(mockNativeLocalProjectContext.prepareProjectContext.mock.calls),
  ).not.toContain('request-sentinel');
});

test('validates and freshly projects candidate pages with correlation', async () => {
  const raw = page();
  mockNativeLocalProjectContext.listProjectContextCandidates.mockResolvedValueOnce(raw);
  const result = await LocalProjectContext.listCandidates(PROJECT_ID, '', null);
  expect(result).toEqual(raw);
  expect(result).not.toBe(raw);
  expect(mockNativeLocalProjectContext.listProjectContextCandidates)
    .toHaveBeenCalledWith(PROJECT_ID, '', null);

  const invalidRows = [
    { ...page(), project_id: CONVERSATION_ID },
    { ...page(), extra: 'raw-sentinel' },
    { ...page(), next_cursor: 'short' },
    { ...page(), candidates: [{ ...candidate(), revision: 'bad' }] },
    { ...page(), candidates: [{ ...candidate(), size: -0 }] },
    {
      ...page(),
      candidates: [
        { ...candidate(), eligible: false, omission_reason: null },
      ],
    },
  ];
  for (const invalid of invalidRows) {
    mockNativeLocalProjectContext.listProjectContextCandidates.mockResolvedValueOnce(
      invalid,
    );
    await expectCode(
      LocalProjectContext.listCandidates(PROJECT_ID, '', null),
      'E_CONTEXT_RESULT_INVALID',
    );
  }
});

test('validates manifest relations, correlations, and exact metadata-only shape', async () => {
  const result = await LocalProjectContext.prepare(selection());
  expect(result).toEqual(manifest());
  expect(Object.keys(result)).toHaveLength(18);
  expect(JSON.stringify(result)).not.toContain('content');
  expect(JSON.stringify(result)).not.toContain('envelope');

  const invalidRows = [
    { ...manifest(), project_id: CONVERSATION_ID },
    { ...manifest(), model: 'deepseek-v4-pro' },
    { ...manifest(), clean: true, conflicted: true },
    { ...manifest(), estimated_tokens: 6 },
    { ...manifest(), context_bytes: 256 * 1024 + 1 },
    { ...manifest(), project_name: 'bad\u0085name' },
    { ...manifest(), project_name: '/private/raw-path-sentinel' },
    { ...manifest(), project_name: 'raw\\path-sentinel' },
    { ...manifest(), project_name: '   ' },
    { ...manifest(), project_name: ' Fixture ' },
    { ...manifest(), branch: '@' },
    {
      ...manifest(),
      included: [{ ...manifest().included[0], bytes: -0 }],
    },
    { ...manifest(), absolute_path: '/secret/path' },
    {
      ...manifest(),
      included: [manifest().included[0], manifest().included[0]],
    },
  ];
  for (const invalid of invalidRows) {
    mockNativeLocalProjectContext.prepareProjectContext.mockResolvedValueOnce(
      invalid,
    );
    await expectCode(
      LocalProjectContext.prepare(selection()),
      'E_CONTEXT_RESULT_INVALID',
    );
  }
});

test('validates consent, nested inspection, and discard results', async () => {
  await expect(LocalProjectContext.confirm(SNAPSHOT_ID)).resolves.toEqual(
    consent(),
  );
  await expect(LocalProjectContext.inspect(SNAPSHOT_ID)).resolves.toEqual({
    schema_version: 1,
    state: 'confirmed',
    manifest: manifest(),
  });
  await expect(LocalProjectContext.discard(SNAPSHOT_ID)).resolves.toEqual({
    schema_version: 1,
    status: 'discarded',
  });

  mockNativeLocalProjectContext.confirmProjectContext.mockResolvedValueOnce({
    ...consent(),
    snapshot_id: CONVERSATION_ID,
  });
  await expectCode(
    LocalProjectContext.confirm(SNAPSHOT_ID),
    'E_CONTEXT_RESULT_INVALID',
  );
  mockNativeLocalProjectContext.inspectProjectContext.mockResolvedValueOnce({
    schema_version: 1,
    state: 'fresh',
    manifest: manifest(),
  });
  await expectCode(
    LocalProjectContext.inspect(SNAPSHOT_ID),
    'E_CONTEXT_RESULT_INVALID',
  );
  mockNativeLocalProjectContext.discardProjectContext.mockResolvedValueOnce({
    schema_version: 1,
    status: 'ok',
  });
  await expectCode(
    LocalProjectContext.discard(SNAPSHOT_ID),
    'E_CONTEXT_RESULT_INVALID',
  );
});

test('preserves only known value-free codes and sanitizes hostile errors', async () => {
  mockNativeLocalProjectContext.prepareProjectContext.mockRejectedValueOnce({
    code: 'E_CONTEXT_BUSY',
    message: 'provider-secret-sentinel',
  });
  await expectCode(
    LocalProjectContext.prepare(selection()),
    'E_CONTEXT_BUSY',
  );

  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error('secret-error-sentinel');
      },
    },
  );
  mockNativeLocalProjectContext.prepareProjectContext.mockRejectedValueOnce(
    hostile,
  );
  await expectCode(
    LocalProjectContext.prepare(selection()),
    'E_CONTEXT_NATIVE',
  );

  const polluted = new ProjectContextBridgeError('E_CONTEXT_BUSY');
  Object.defineProperty(polluted, 'code', {
    configurable: true,
    enumerable: true,
    value: 'polluted-secret-code',
  });
  Object.defineProperty(polluted, 'message', {
    configurable: true,
    value: 'polluted-secret-message',
  });
  mockNativeLocalProjectContext.prepareProjectContext.mockRejectedValueOnce(
    polluted,
  );
  await expectCode(
    LocalProjectContext.prepare(selection()),
    'E_CONTEXT_NATIVE',
  );
});

test('rejects raw sentinel result fields instead of forwarding service objects', async () => {
  for (const extra of [
    { content: 'raw-content-sentinel' },
    { absolute_path: '/private/raw-path-sentinel' },
    { source_descriptor: { device: 1 } },
    { envelope: new Uint8Array([1, 2, 3]) },
  ]) {
    mockNativeLocalProjectContext.prepareProjectContext.mockResolvedValueOnce({
      ...manifest(),
      ...extra,
    });
    await expectCode(
      LocalProjectContext.prepare(selection()),
      'E_CONTEXT_RESULT_INVALID',
    );
  }
});

test('enforces page, selected path, included, and omitted caps', async () => {
  await expectCode(
    LocalProjectContext.prepare({
      ...selection(),
      selected_paths: Array.from({ length: 5001 }, (_, index) => `f${index}`),
    }),
    'E_CONTEXT_REQUEST_INVALID',
  );
  mockNativeLocalProjectContext.listProjectContextCandidates.mockResolvedValueOnce({
    ...page(),
    candidates: Array.from({ length: 101 }, (_, index) => candidate(`f${index}`)),
  });
  await expectCode(
    LocalProjectContext.listCandidates(PROJECT_ID),
    'E_CONTEXT_RESULT_INVALID',
  );
  mockNativeLocalProjectContext.prepareProjectContext.mockResolvedValueOnce({
    ...manifest(),
    included: Array.from({ length: 33 }, (_, index) => ({
      ...manifest().included[0],
      path: `f${index}`,
    })),
  });
  await expectCode(
    LocalProjectContext.prepare(selection()),
    'E_CONTEXT_RESULT_INVALID',
  );
  mockNativeLocalProjectContext.prepareProjectContext.mockResolvedValueOnce({
    ...manifest(),
    omitted: Array.from({ length: 5001 }, (_, index) => ({
      path: `f${index}`,
      reason: 'policy',
    })),
  });
  await expectCode(
    LocalProjectContext.prepare(selection()),
    'E_CONTEXT_RESULT_INVALID',
  );
});

test('fails closed on proxy, getter, sparse array, custom prototype, and toJSON', async () => {
  const proxy = new Proxy(selection(), {
    ownKeys() {
      throw new Error('proxy-sentinel');
    },
  });
  await expectCode(
    LocalProjectContext.prepare(proxy),
    'E_CONTEXT_NATIVE',
  );

  const getter = { ...manifest() } as Record<string, unknown>;
  Object.defineProperty(getter, 'project_name', {
    enumerable: true,
    get() {
      return 'getter-sentinel';
    },
  });
  mockNativeLocalProjectContext.prepareProjectContext.mockResolvedValueOnce(
    getter,
  );
  await expectCode(
    LocalProjectContext.prepare(selection()),
    'E_CONTEXT_RESULT_INVALID',
  );

  const sparse = selection();
  sparse.selected_paths = Array(1) as string[];
  await expectCode(
    LocalProjectContext.prepare(sparse),
    'E_CONTEXT_REQUEST_INVALID',
  );

  const hiddenIndex = selection();
  Object.defineProperty(hiddenIndex.selected_paths, '0', {
    configurable: true,
    enumerable: false,
    value: 'README.md',
  });
  await expectCode(
    LocalProjectContext.prepare(hiddenIndex),
    'E_CONTEXT_REQUEST_INVALID',
  );

  await expectCode(
    LocalProjectContext.prepare(
      Object.assign(Object.create({}), selection()),
    ),
    'E_CONTEXT_REQUEST_INVALID',
  );

  // eslint-disable-next-line no-extend-native -- trust-boundary regression
  Object.defineProperty(Array.prototype, 'toJSON', {
    configurable: true,
    value: () => 'tojson-sentinel',
  });
  try {
    await expectCode(
      LocalProjectContext.prepare(selection()),
      'E_CONTEXT_REQUEST_INVALID',
    );
  } finally {
    delete (Array.prototype as { toJSON?: unknown }).toJSON;
  }
});

test('rejects invalid list and snapshot inputs before any native call', async () => {
  await expectCode(
    LocalProjectContext.listCandidates('not-a-project', 'raw-sentinel'),
    'E_CONTEXT_REQUEST_INVALID',
  );
  await expectCode(
    LocalProjectContext.listCandidates(PROJECT_ID, 'x'.repeat(257)),
    'E_CONTEXT_REQUEST_INVALID',
  );
  await expectCode(
    LocalProjectContext.listCandidates(PROJECT_ID, '', 'short'),
    'E_CONTEXT_REQUEST_INVALID',
  );
  await expectCode(
    LocalProjectContext.confirm('not-a-snapshot'),
    'E_CONTEXT_REQUEST_INVALID',
  );
  await expectCode(
    LocalProjectContext.prepare({
      ...selection(),
      selected_paths: ['line\nbreak'],
    }),
    'E_CONTEXT_REQUEST_INVALID',
  );
  expect(mockNativeLocalProjectContext.listProjectContextCandidates).not.toHaveBeenCalled();
  expect(mockNativeLocalProjectContext.confirmProjectContext).not.toHaveBeenCalled();
});

test('exports a stable value-free bridge error class', () => {
  const error = new ProjectContextBridgeError('E_CONTEXT_STORAGE');
  expect(error).toEqual(expect.objectContaining({
    name: 'ProjectContextBridgeError',
    code: 'E_CONTEXT_STORAGE',
    message: 'E_CONTEXT_STORAGE',
  }));
});

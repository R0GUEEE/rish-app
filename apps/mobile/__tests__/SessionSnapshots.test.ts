import { NativeModules, TurboModuleRegistry } from 'react-native';

const loadSessionSnapshot = jest.fn();
let loadSessionSnapshotGetterReads = 0;
const nativeSessionSnapshotsPrototype = {
  casPersistSession: jest.fn(),
  querySessionCommit: jest.fn(),
  persistSessionWithWorkspaceClearance: jest.fn(),
  queryWorkspaceClearance: jest.fn(),
};
Object.defineProperty(nativeSessionSnapshotsPrototype, 'loadSessionSnapshot', {
  configurable: true,
  get: () => {
    loadSessionSnapshotGetterReads += 1;
    return loadSessionSnapshot;
  },
});
const mockNativeSessionSnapshots = Object.create(
  nativeSessionSnapshotsPrototype,
) as typeof nativeSessionSnapshotsPrototype & {
  loadSessionSnapshot: typeof loadSessionSnapshot;
};
const turboModuleGet = jest.spyOn(TurboModuleRegistry, 'get');
turboModuleGet.mockReturnValue(null);

(NativeModules as Record<string, unknown>).SessionSnapshots =
  mockNativeSessionSnapshots;
const { SessionSnapshots } = jest.requireActual(
  '../src/native/SessionSnapshots',
) as typeof import('../src/native/SessionSnapshots');

const MISSING = {
  schema_version: 1 as const,
  kind: 'missing' as const,
};
const REQUEST = {
  schema_version: 1 as const,
  operation_id: '11111111-1111-4111-8111-111111111111',
  expected: MISSING,
  candidate_json: '{"schema_version":9}',
};

const CLEARANCE_OPERATION = {
  schema_version: 1 as const,
  operation_id: '22222222-2222-4222-8222-222222222222',
  action: 'forget' as const,
  workspace_id: '33333333-3333-4333-8333-333333333333',
  binding_revision: 1,
  clearance_receipt_id: '44444444-4444-4444-8444-444444444444',
  created_at: '2026-08-31T00:00:00.000Z',
};

const CLEARANCE_RECEIPT = {
  schema_version: 1 as const,
  clearance_receipt_id: CLEARANCE_OPERATION.clearance_receipt_id,
  operation_id: CLEARANCE_OPERATION.operation_id,
  workspace_id: CLEARANCE_OPERATION.workspace_id,
  binding_revision: 1,
  committed_session_generation: 2,
  committed_session_sha256: 'a'.repeat(64),
  issued_at: '2026-08-31T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  turboModuleGet.mockReturnValue(null);
  (NativeModules as Record<string, unknown>).SessionSnapshots =
    mockNativeSessionSnapshots;
});

test('links a prototype-backed HostObject and reads a lazy method once', () => {
  expect(Object.getOwnPropertyNames(mockNativeSessionSnapshots)).toEqual([]);
  expect(SessionSnapshots.isAvailable()).toBe(true);
  expect(loadSessionSnapshotGetterReads).toBe(1);
  expect(SessionSnapshots.isAvailable()).toBe(true);
  expect(loadSessionSnapshotGetterReads).toBe(1);
});

test('uses cached native method references after same-object replacement', async () => {
  expect(SessionSnapshots.isAvailable()).toBe(true);
  loadSessionSnapshot.mockResolvedValue({
    schema_version: 1,
    status: 'missing',
    snapshot: null,
    session_json: null,
  });
  const replacement = jest.fn().mockRejectedValue(new Error('replacement'));
  Object.defineProperty(mockNativeSessionSnapshots, 'loadSessionSnapshot', {
    configurable: true,
    value: replacement,
  });
  await expect(SessionSnapshots.loadSessionSnapshot()).resolves.toMatchObject({
    status: 'missing',
  });
  expect(loadSessionSnapshot).toHaveBeenCalledWith();
  expect(replacement).not.toHaveBeenCalled();
  expect(loadSessionSnapshotGetterReads).toBe(1);
  delete (mockNativeSessionSnapshots as Record<string, unknown>)
    .loadSessionSnapshot;
});

test('accepts TurboModuleRegistry and NativeModules candidates', () => {
  const registryModule = Object.create(nativeSessionSnapshotsPrototype);
  turboModuleGet.mockReturnValue(registryModule);
  (NativeModules as Record<string, unknown>).SessionSnapshots = null;
  expect(SessionSnapshots.isAvailable()).toBe(true);
  expect(turboModuleGet).toHaveBeenCalledWith('SessionSnapshots');

  turboModuleGet.mockImplementation(() => {
    throw new Error('registry unavailable');
  });
  (NativeModules as Record<string, unknown>).SessionSnapshots =
    mockNativeSessionSnapshots;
  expect(SessionSnapshots.isAvailable()).toBe(true);
});

test('falls back when TurboModuleRegistry returns an incomplete proxy', () => {
  turboModuleGet.mockReturnValue({ loadSessionSnapshot } as never);
  (NativeModules as Record<string, unknown>).SessionSnapshots =
    mockNativeSessionSnapshots;
  expect(SessionSnapshots.isAvailable()).toBe(true);
});

test('recovers when the native module is transiently absent', () => {
  const recovered = Object.create(nativeSessionSnapshotsPrototype);
  turboModuleGet.mockReturnValueOnce(null).mockReturnValueOnce(recovered);
  (NativeModules as Record<string, unknown>).SessionSnapshots = null;
  expect(SessionSnapshots.isAvailable()).toBe(false);
  expect(SessionSnapshots.isAvailable()).toBe(true);
});

test('does not cache a throwing HostObject getter as unavailable', () => {
  const recoveredLoad = jest.fn();
  let getterReads = 0;
  const hostile = Object.create(nativeSessionSnapshotsPrototype);
  Object.defineProperty(hostile, 'loadSessionSnapshot', {
    configurable: true,
    get: () => {
      getterReads += 1;
      if (getterReads === 1) throw new Error('transient HostObject getter');
      return recoveredLoad;
    },
  });
  turboModuleGet.mockReturnValue(hostile);
  (NativeModules as Record<string, unknown>).SessionSnapshots = null;
  expect(SessionSnapshots.isAvailable()).toBe(false);
  expect(SessionSnapshots.isAvailable()).toBe(true);
  expect(SessionSnapshots.isAvailable()).toBe(true);
  expect(getterReads).toBe(2);
});

test('forwards load, CAS, and query envelopes without translating native states', async () => {
  const loaded = {
    schema_version: 1 as const,
    status: 'legacy_present' as const,
    legacy: {
      schema_version: 1 as const,
      legacy_bytes_sha256: 'a'.repeat(64),
    },
    session_json: '{"schema_version":8}',
  };
  const committed = {
    schema_version: 1 as const,
    status: 'committed' as const,
    snapshot: {
      schema_version: 1 as const,
      generation: 1,
      session_sha256: 'b'.repeat(64),
    },
  };
  const queried = {
    schema_version: 1 as const,
    status: 'not_started' as const,
  };
  loadSessionSnapshot.mockResolvedValue(loaded);
  mockNativeSessionSnapshots.casPersistSession.mockResolvedValue(committed);
  mockNativeSessionSnapshots.querySessionCommit.mockResolvedValue(queried);

  await expect(SessionSnapshots.loadSessionSnapshot()).resolves.toEqual(loaded);
  await expect(SessionSnapshots.casPersistSession(REQUEST)).resolves.toEqual(
    committed,
  );
  const query = {
    schema_version: 1 as const,
    operation_id: REQUEST.operation_id,
  };
  await expect(SessionSnapshots.querySessionCommit(query)).resolves.toEqual(
    queried,
  );

  const clearanceRequest = {
    schema_version: 1 as const,
    candidate_json: REQUEST.candidate_json,
    operation: CLEARANCE_OPERATION,
  };
  const clearance = {
    schema_version: 1 as const,
    status: 'committed' as const,
    receipt: CLEARANCE_RECEIPT,
  };
  const clearanceQuery = {
    schema_version: 1 as const,
    status: 'committed' as const,
    receipt: CLEARANCE_RECEIPT,
  };
  mockNativeSessionSnapshots.persistSessionWithWorkspaceClearance.mockResolvedValue(
    clearance,
  );
  mockNativeSessionSnapshots.queryWorkspaceClearance.mockResolvedValue(
    clearanceQuery,
  );
  await expect(
    SessionSnapshots.persistSessionWithWorkspaceClearance(clearanceRequest),
  ).resolves.toEqual(clearance);
  await expect(
    SessionSnapshots.queryWorkspaceClearance({
      schema_version: 1,
      operation_id: CLEARANCE_OPERATION.operation_id,
    }),
  ).resolves.toEqual(clearanceQuery);

  expect(loadSessionSnapshot).toHaveBeenCalledWith();
  expect(mockNativeSessionSnapshots.casPersistSession).toHaveBeenCalledWith(
    REQUEST,
  );
  expect(mockNativeSessionSnapshots.querySessionCommit).toHaveBeenCalledWith(
    query,
  );
  expect(
    mockNativeSessionSnapshots.persistSessionWithWorkspaceClearance,
  ).toHaveBeenCalledWith(clearanceRequest);
  expect(
    mockNativeSessionSnapshots.queryWorkspaceClearance,
  ).toHaveBeenCalledWith({
    schema_version: 1,
    operation_id: CLEARANCE_OPERATION.operation_id,
  });
});

test('rejects extra fields and accessors before native CAS', async () => {
  await expect(
    SessionSnapshots.casPersistSession({
      ...REQUEST,
      extra: true,
    } as never),
  ).rejects.toMatchObject({ code: 'E_SESSION_INVALID' });

  const accessor = { ...REQUEST } as Record<string, unknown>;
  Object.defineProperty(accessor, 'candidate_json', {
    enumerable: true,
    get: () => REQUEST.candidate_json,
  });
  await expect(
    SessionSnapshots.casPersistSession(accessor as never),
  ).rejects.toMatchObject({ code: 'E_SESSION_INVALID' });
  expect(mockNativeSessionSnapshots.casPersistSession).not.toHaveBeenCalled();
});

test('rejects malformed clearance requests before native work', async () => {
  await expect(
    SessionSnapshots.persistSessionWithWorkspaceClearance({
      schema_version: 1,
      candidate_json: REQUEST.candidate_json,
      operation: {
        ...CLEARANCE_OPERATION,
        unexpected: true,
      },
    } as never),
  ).rejects.toMatchObject({ code: 'E_SESSION_INVALID' });
  await expect(
    SessionSnapshots.queryWorkspaceClearance({
      schema_version: 1,
      operation_id: 'not-an-id',
    }),
  ).rejects.toMatchObject({ code: 'E_SESSION_INVALID' });
  expect(
    mockNativeSessionSnapshots.persistSessionWithWorkspaceClearance,
  ).not.toHaveBeenCalled();
  expect(
    mockNativeSessionSnapshots.queryWorkspaceClearance,
  ).not.toHaveBeenCalled();
});

test('clones exact requests and results at the facade boundary', async () => {
  const request = {
    ...REQUEST,
    expected: { ...REQUEST.expected },
  };
  const committed = {
    schema_version: 1 as const,
    status: 'committed' as const,
    snapshot: {
      schema_version: 1 as const,
      generation: 1,
      session_sha256: 'c'.repeat(64),
    },
  };
  const nativeResult = {
    ...committed,
    snapshot: { ...committed.snapshot },
  };
  mockNativeSessionSnapshots.casPersistSession.mockImplementation(
    (forwarded: typeof request) => {
      forwarded.expected = { schema_version: 1, kind: 'missing' };
      return Promise.resolve(nativeResult);
    },
  );

  const result = await SessionSnapshots.casPersistSession(request);
  expect(request).toEqual(REQUEST);
  expect(result).toEqual(committed);
  expect(result).not.toBe(nativeResult);
  if (result.status !== 'committed')
    throw new Error('test result was not committed');
  expect(result.snapshot).not.toBe(nativeResult.snapshot);
  const [forwarded] =
    mockNativeSessionSnapshots.casPersistSession.mock.calls[0]!;
  expect(forwarded).not.toBe(request);
  expect(forwarded.expected).not.toBe(request.expected);
});

test('sanitizes native failures and malformed public results', async () => {
  mockNativeSessionSnapshots.querySessionCommit.mockRejectedValue(
    new Error('opaque failure detail'),
  );
  await expect(
    SessionSnapshots.querySessionCommit({
      schema_version: 1,
      operation_id: REQUEST.operation_id,
    }),
  ).rejects.toMatchObject({
    code: 'E_SESSION_PERSISTENCE',
    message: 'E_SESSION_PERSISTENCE',
  });

  mockNativeSessionSnapshots.querySessionCommit.mockRejectedValue({
    code: 'E_SESSION_CONFLICT',
    detail: 'must not cross the facade',
  });
  await expect(
    SessionSnapshots.querySessionCommit({
      schema_version: 1,
      operation_id: REQUEST.operation_id,
    }),
  ).rejects.toMatchObject({
    code: 'E_SESSION_CONFLICT',
    message: 'E_SESSION_CONFLICT',
  });

  let getterCalled = false;
  const hostileCode = {};
  Object.defineProperty(hostileCode, 'code', {
    enumerable: true,
    get: () => {
      getterCalled = true;
      throw new Error('hostile getter');
    },
  });
  mockNativeSessionSnapshots.querySessionCommit.mockRejectedValue(hostileCode);
  await expect(
    SessionSnapshots.querySessionCommit({
      schema_version: 1,
      operation_id: REQUEST.operation_id,
    }),
  ).rejects.toMatchObject({ code: 'E_SESSION_PERSISTENCE' });
  expect(getterCalled).toBe(false);

  loadSessionSnapshot.mockResolvedValue({
    schema_version: 1,
    status: 'missing',
    snapshot: { unexpected: true },
    session_json: null,
  });
  await expect(SessionSnapshots.loadSessionSnapshot()).rejects.toMatchObject({
    code: 'E_SESSION_CORRUPT',
  });

  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor: () => {
        throw new Error('hostile getter');
      },
    },
  );
  mockNativeSessionSnapshots.querySessionCommit.mockRejectedValue(hostile);
  await expect(
    SessionSnapshots.querySessionCommit({
      schema_version: 1,
      operation_id: REQUEST.operation_id,
    }),
  ).rejects.toMatchObject({
    code: 'E_SESSION_PERSISTENCE',
    message: 'E_SESSION_PERSISTENCE',
  });
});

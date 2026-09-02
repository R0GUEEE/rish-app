import {
  createSessionPersistenceCoordinator,
  agentTextSHA256,
  sessionSnapshotSHA256,
  type SessionSnapshotAuthorityV1,
} from '../src/completion/SessionPersistence';
import { createEmptyChatState, serializeChatState } from '../src/state';

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const CANDIDATE = serializeChatState(createEmptyChatState());
const CANDIDATE_DIGEST = sessionSnapshotSHA256(CANDIDATE)!;

const MISSING: SessionSnapshotAuthorityV1 = {
  schema_version: 1,
  kind: 'missing',
};
const PRESENT: SessionSnapshotAuthorityV1 = {
  schema_version: 1,
  kind: 'present',
  snapshot: {
    schema_version: 1,
    generation: 4,
    session_sha256: CANDIDATE_DIGEST,
  },
};

function nativeLoaded(
  authority: SessionSnapshotAuthorityV1,
): Record<string, unknown> {
  if (authority.kind === 'missing') {
    return {
      schema_version: 1,
      status: 'missing',
      snapshot: null,
      session_json: null,
    };
  }
  if (authority.kind === 'legacy_present') {
    return {
      schema_version: 1,
      status: 'legacy_present',
      legacy: authority.legacy,
      session_json: '{}',
    };
  }
  return {
    schema_version: 1,
    status: 'present',
    snapshot: authority.snapshot,
    session_json: CANDIDATE,
  };
}

describe('schema-9 native session persistence coordinator', () => {
  test('uses the raw UTF-8 Runtime Proof SHA-256 for recovered text', () => {
    expect(agentTextSHA256('recovered')).toBe(
      'f6e09cc89f85dcd21d987a4c4af142fe5bbb741de93d375af548f1d4f1d2063b',
    );
    expect(agentTextSHA256('durable native receipt')).toBe(
      '5203f7706b13e7c81c22a5d3609059b75177f19c2ff5dc505684d4e69692e0cb',
    );
    expect(agentTextSHA256('\ud800')).toBeNull();
  });

  test('loads exact native authority and commits only a correlated HJ snapshot', async () => {
    const loadSessionSnapshot = jest.fn().mockResolvedValue(nativeLoaded(MISSING));
    const casPersistSession = jest.fn().mockResolvedValue({
      schema_version: 1,
      status: 'committed',
      snapshot: {
        schema_version: 1,
        generation: 1,
        session_sha256: CANDIDATE_DIGEST,
      },
    });
    const coordinator = createSessionPersistenceCoordinator({
      loadSessionSnapshot,
      casPersistSession,
    });

    await expect(
      coordinator.write(CANDIDATE, { operation_id: OPERATION_ID }),
    ).resolves.toEqual({ status: 'committed' });
    expect(loadSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(casPersistSession).toHaveBeenCalledWith({
      schema_version: 1,
      operation_id: OPERATION_ID,
      expected: MISSING,
      candidate_json: CANDIDATE,
    });
  });

  test.each([
    ['wrong digest', 'f'.repeat(64), 1],
    ['wrong generation', CANDIDATE_DIGEST, 2],
  ])('rejects a committed ref with %s', async (_label, digest, generation) => {
    const coordinator = createSessionPersistenceCoordinator({
      loadSessionSnapshot: jest.fn().mockResolvedValue(nativeLoaded(MISSING)),
      casPersistSession: jest.fn().mockResolvedValue({
        schema_version: 1,
        status: 'committed',
        snapshot: {
          schema_version: 1,
          generation,
          session_sha256: digest,
        },
      }),
    });
    await expect(
      coordinator.write(CANDIDATE, { operation_id: OPERATION_ID }),
    ).resolves.toEqual({ status: 'unknown' });
  });

  test('uses the current generation plus one for a present authority', async () => {
    const casPersistSession = jest.fn().mockResolvedValue({
      schema_version: 1,
      status: 'committed',
      snapshot: {
        schema_version: 1,
        generation: 5,
        session_sha256: CANDIDATE_DIGEST,
      },
    });
    const coordinator = createSessionPersistenceCoordinator({
      loadSessionSnapshot: jest.fn().mockResolvedValue(nativeLoaded(PRESENT)),
      casPersistSession,
    });
    await expect(
      coordinator.write(CANDIDATE, { operation_id: OPERATION_ID }),
    ).resolves.toEqual({ status: 'committed' });
    expect(casPersistSession.mock.calls[0]?.[0].expected).toEqual(PRESENT);
  });

  test('does not invent authority when native load is missing, bare, malformed, or boolean', async () => {
    for (const loadSessionSnapshot of [
      undefined,
      jest.fn().mockResolvedValue(null),
      jest.fn().mockResolvedValue(CANDIDATE),
      jest.fn().mockResolvedValue(true),
      jest.fn().mockResolvedValue({ schema_version: 1, status: 'missing' }),
    ]) {
      const casPersistSession = jest.fn();
      const coordinator = createSessionPersistenceCoordinator({
        ...(loadSessionSnapshot === undefined ? {} : { loadSessionSnapshot }),
        casPersistSession,
      });
      await expect(
        coordinator.write(CANDIDATE, { operation_id: OPERATION_ID }),
      ).resolves.toEqual({ status: 'unknown' });
      expect(casPersistSession).not.toHaveBeenCalled();
    }
  });

  test('uses only the exact native load method, even when legacy aliases are supplied', async () => {
    const loadSessionAuthority = jest.fn().mockResolvedValue(nativeLoaded(MISSING));
    const casPersistSession = jest.fn();
    const coordinator = createSessionPersistenceCoordinator({
      loadSessionAuthority,
      casPersistSession,
    });
    await expect(
      coordinator.write(CANDIDATE, { operation_id: OPERATION_ID }),
    ).resolves.toEqual({ status: 'unknown' });
    expect(loadSessionAuthority).not.toHaveBeenCalled();
    expect(casPersistSession).not.toHaveBeenCalled();
  });

  test('rejects a caller expected token that does not match the native load', async () => {
    const casPersistSession = jest.fn();
    const coordinator = createSessionPersistenceCoordinator({
      loadSessionSnapshot: jest.fn().mockResolvedValue(nativeLoaded(MISSING)),
      casPersistSession,
    });
    await expect(
      coordinator.write(CANDIDATE, {
        operation_id: OPERATION_ID,
        expected: PRESENT,
      }),
    ).resolves.toEqual({ status: 'not_committed' });
    expect(casPersistSession).not.toHaveBeenCalled();
  });

  test('rejects malformed nested session JSON returned by native load', async () => {
    const coordinator = createSessionPersistenceCoordinator({
      loadSessionSnapshot: jest.fn().mockResolvedValue({
        schema_version: 1,
        status: 'present',
        snapshot: {
          schema_version: 1,
          generation: 4,
          session_sha256: 'a'.repeat(64),
        },
        session_json: '{}',
      }),
      casPersistSession: jest.fn(),
    });
    await expect(
      coordinator.write(CANDIDATE, { operation_id: OPERATION_ID }),
    ).resolves.toEqual({ status: 'unknown' });
  });

  test('requires the loaded present digest to equal HJ(chat-session, root)', async () => {
    const loadSessionSnapshot = jest.fn().mockResolvedValue({
      schema_version: 1,
      status: 'present',
      snapshot: {
        schema_version: 1,
        generation: 4,
        session_sha256: 'f'.repeat(64),
      },
      session_json: CANDIDATE,
    });
    const coordinator = createSessionPersistenceCoordinator({
      loadSessionSnapshot,
      casPersistSession: jest.fn(),
    });
    await expect(coordinator.loadAuthority()).rejects.toThrow(
      'session authority unavailable',
    );
    await expect(
      coordinator.write(CANDIDATE, { operation_id: OPERATION_ID }),
    ).resolves.toEqual({ status: 'unknown' });
  });

  test('reports session_only only when native says the candidate is current', async () => {
    const candidateCurrent = {
      schema_version: 1,
      kind: 'present' as const,
      snapshot: {
        schema_version: 1 as const,
        generation: 1,
        session_sha256: CANDIDATE_DIGEST,
      },
    };
    const coordinator = createSessionPersistenceCoordinator({
      loadSessionSnapshot: jest.fn().mockResolvedValue(nativeLoaded(MISSING)),
      casPersistSession: jest.fn().mockResolvedValue({
        schema_version: 1,
        status: 'session_only',
        current: candidateCurrent,
      }),
    });
    await expect(
      coordinator.write(CANDIDATE, { operation_id: OPERATION_ID }),
    ).resolves.toEqual({ status: 'session_only' });
  });

  test('maps a proven not_started operation query to not_committed', async () => {
    const coordinator = createSessionPersistenceCoordinator({
      loadSessionSnapshot: jest.fn().mockResolvedValue(nativeLoaded(MISSING)),
      casPersistSession: jest.fn().mockRejectedValue(new Error('lost response')),
      querySessionCommit: jest.fn().mockResolvedValue({
        schema_version: 1,
        status: 'not_started',
      }),
    });
    await expect(
      coordinator.write(CANDIDATE, { operation_id: OPERATION_ID }),
    ).resolves.toEqual({ status: 'not_committed' });
  });

  test('generates a canonical UUID operation id when one is omitted', async () => {
    const casPersistSession = jest.fn().mockResolvedValue({
      schema_version: 1,
      status: 'committed',
      snapshot: {
        schema_version: 1,
        generation: 1,
        session_sha256: CANDIDATE_DIGEST,
      },
    });
    const coordinator = createSessionPersistenceCoordinator({
      loadSessionSnapshot: jest.fn().mockResolvedValue(nativeLoaded(MISSING)),
      casPersistSession,
    });
    await expect(coordinator.write(CANDIDATE)).resolves.toEqual({
      status: 'committed',
    });
    expect(casPersistSession.mock.calls[0]?.[0].operation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
  });

  test('rejects schema-9 duplicate keys, negative zero, unsafe integers, and malformed roots before CAS', async () => {
    const casPersistSession = jest.fn();
    const coordinator = createSessionPersistenceCoordinator({
      loadSessionSnapshot: jest.fn().mockResolvedValue(nativeLoaded(MISSING)),
      casPersistSession,
    });
    for (const candidate of [
      CANDIDATE.replace('{"schema_version":9', '{"schema_version":9,"schema_version":9'),
      CANDIDATE.replace('"schema_version":9', '"schema_version":-0'),
      CANDIDATE.replace('"schema_version":9', '"schema_version":9007199254740992'),
      JSON.stringify({ schema_version: 9 }),
    ]) {
      await expect(
        coordinator.write(candidate, { operation_id: OPERATION_ID }),
      ).resolves.toEqual({ status: 'unknown' });
    }
    expect(casPersistSession).not.toHaveBeenCalled();
  });

  test('queries the exact operation after an indeterminate CAS response', async () => {
    const casPersistSession = jest.fn().mockRejectedValue(new Error('native detail'));
    const querySessionCommit = jest.fn().mockResolvedValue({
      schema_version: 1,
      status: 'committed',
      snapshot: {
        schema_version: 1,
        generation: 1,
        session_sha256: CANDIDATE_DIGEST,
      },
    });
    const coordinator = createSessionPersistenceCoordinator({
      loadSessionSnapshot: jest.fn().mockResolvedValue(nativeLoaded(MISSING)),
      casPersistSession,
      querySessionCommit,
    });
    await expect(
      coordinator.write(CANDIDATE, { operation_id: SECOND_OPERATION_ID }),
    ).resolves.toEqual({ status: 'committed' });
    expect(querySessionCommit).toHaveBeenCalledWith({
      schema_version: 1,
      operation_id: SECOND_OPERATION_ID,
    });
  });

  test('serializes native CAS writes and does not retain an overflow queue', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const casPersistSession = jest
      .fn()
      .mockImplementationOnce(async () => {
        await gate;
        return {
          schema_version: 1,
          status: 'committed',
          snapshot: {
            schema_version: 1,
            generation: 1,
            session_sha256: CANDIDATE_DIGEST,
          },
        };
      })
      .mockResolvedValue({
        schema_version: 1,
        status: 'committed',
        snapshot: {
          schema_version: 1,
          generation: 1,
          session_sha256: CANDIDATE_DIGEST,
        },
      });
    const loadSessionSnapshot = jest.fn().mockResolvedValue(nativeLoaded(MISSING));
    const coordinator = createSessionPersistenceCoordinator({
      loadSessionSnapshot,
      casPersistSession,
    });
    const first = coordinator.write(CANDIDATE, { operation_id: OPERATION_ID });
    const second = coordinator.write(CANDIDATE, { operation_id: SECOND_OPERATION_ID });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(casPersistSession).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toEqual({ status: 'committed' });
    await expect(second).resolves.toEqual({ status: 'committed' });
    expect(casPersistSession).toHaveBeenCalledTimes(2);
  });
});

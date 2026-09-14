import {
  createSessionPersistenceCoordinator,
  sessionSnapshotSHA256,
} from '../src/completion/SessionPersistence';
import { createEmptyChatState, serializeChatState } from '../src/state';

const session = serializeChatState(createEmptyChatState());
const loaded = {
  schema_version: 1,
  status: 'present',
  snapshot: {
    schema_version: 1,
    generation: 7,
    session_sha256: sessionSnapshotSHA256(session),
  },
  session_json: session,
  writer_launch_instance_id: '11111111-1111-4111-8111-111111111111',
  current_launch_instance_id: '22222222-2222-4222-8222-222222222222',
};

test.each(['E_SESSION_PROTECTION', 'E_SESSION_STORAGE', 'E_SESSION_CORRUPT'])(
  'preserves %s without exposing native details or writing a replacement',
  async code => {
    const casPersistSession = jest.fn();
    const coordinator = createSessionPersistenceCoordinator({
      loadSessionSnapshot: jest
        .fn()
        .mockRejectedValue({
          code,
          message: 'private filesystem and chat contents',
        }),
      casPersistSession,
    });
    expect(await coordinator.loadSessionSnapshotOutcome()).toEqual({
      status: 'failed',
      code,
    });
    expect(await coordinator.loadSessionSnapshotResult()).toBeNull();
    expect(casPersistSession).not.toHaveBeenCalled();
  },
);

test('retry reads the original snapshot after a transient protection error', async () => {
  const casPersistSession = jest.fn();
  const coordinator = createSessionPersistenceCoordinator({
    loadSessionSnapshot: jest
      .fn()
      .mockRejectedValueOnce({ code: 'E_SESSION_PROTECTION' })
      .mockResolvedValue(loaded),
    casPersistSession,
  });
  expect(await coordinator.loadSessionSnapshotOutcome()).toEqual({
    status: 'failed',
    code: 'E_SESSION_PROTECTION',
  });
  expect(await coordinator.loadSessionSnapshotOutcome()).toEqual({
    status: 'loaded',
    value: loaded,
  });
  expect(casPersistSession).not.toHaveBeenCalled();
});

test('unknown native failures never become missing sessions or leak raw messages', async () => {
  const coordinator = createSessionPersistenceCoordinator({
    loadSessionSnapshot: jest
      .fn()
      .mockRejectedValue({
        code: 'secret private value',
        message: 'private message',
      }),
  });
  expect(await coordinator.loadSessionSnapshotOutcome()).toEqual({
    status: 'failed',
    code: 'E_SESSION_PERSISTENCE',
  });
});

test('malformed native output is rejected with a stable format code', async () => {
  const coordinator = createSessionPersistenceCoordinator({
    loadSessionSnapshot: jest.fn().mockResolvedValue(true),
  });
  expect(await coordinator.loadSessionSnapshotOutcome()).toEqual({
    status: 'failed',
    code: 'E_SESSION_INVALID',
  });
});

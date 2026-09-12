import { NativeModules, TurboModuleRegistry } from 'react-native';
import { createChatStore } from '../src/state';

const T0 = '2026-08-24T01:00:00.000Z';
const T1 = '2026-08-24T01:01:00.000Z';
const HEX64 = /^[0-9a-f]{64}$/u;

const nativeSessionSnapshotsPrototype = {
  loadSessionSnapshot: jest.fn(),
  casPersistSession: jest.fn(),
  querySessionCommit: jest.fn(),
  persistSessionWithWorkspaceClearance: jest.fn(),
  queryWorkspaceClearance: jest.fn(),
};
const mockNativeSessionSnapshots = Object.create(
  nativeSessionSnapshotsPrototype,
) as typeof nativeSessionSnapshotsPrototype & {
  sessionCandidateDigest?: (candidateJSON: string) => unknown;
};
const turboModuleGet = jest.spyOn(TurboModuleRegistry, 'get');
turboModuleGet.mockReturnValue(null);

(NativeModules as Record<string, unknown>).SessionSnapshots =
  mockNativeSessionSnapshots;
const { sessionSnapshotSHA256 } = jest.requireActual(
  '../src/completion/SessionPersistence',
) as typeof import('../src/completion/SessionPersistence');

function buildCandidateJSON(): string {
  const store = createChatStore({ now: () => T0 });
  const conversationId = store.createConversation();
  store.dispatch({
    type: 'message/append',
    payload: {
      conversationId,
      message: {
        id: 'u1',
        role: 'user',
        text: 'Local?',
        createdAt: T1,
        attachments: [],
      },
    },
  });
  return store.serialize();
}

const candidate = buildCandidateJSON();

beforeEach(() => {
  jest.clearAllMocks();
  turboModuleGet.mockReturnValue(null);
  (NativeModules as Record<string, unknown>).SessionSnapshots =
    mockNativeSessionSnapshots;
  delete mockNativeSessionSnapshots.sessionCandidateDigest;
});

test('native object without sessionCandidateDigest keeps the pure-JS digest', () => {
  const first = sessionSnapshotSHA256(candidate);
  expect(first).toMatch(HEX64);
  expect(sessionSnapshotSHA256(candidate)).toBe(first);
});

// Whitespace variants are distinct strings (so they miss the by-value memo)
// with the same canonical content (so the pure-JS digest is identical).
const variant = (n: number): string => `${candidate.slice(0, -1)}${' '.repeat(n)}}`;

test('native sessionCandidateDigest supplies the digest for the candidate', () => {
  const nativeDigest = 'b'.repeat(64);
  const digestMock = jest.fn(() => nativeDigest);
  mockNativeSessionSnapshots.sessionCandidateDigest = digestMock;
  const fresh = variant(11);
  expect(sessionSnapshotSHA256(fresh)).toBe(nativeDigest);
  expect(digestMock).toHaveBeenCalledTimes(1);
  expect(digestMock).toHaveBeenCalledWith(fresh);
});

test('malformed or throwing native digests fall back to the pure-JS value', () => {
  const pureJS = sessionSnapshotSHA256(candidate);
  expect(pureJS).toMatch(HEX64);

  const malformed = jest.fn(() => 'not-a-sha256-digest');
  mockNativeSessionSnapshots.sessionCandidateDigest = malformed;
  expect(sessionSnapshotSHA256(variant(12))).toBe(pureJS);
  expect(malformed).toHaveBeenCalledTimes(1);

  const crashing = jest.fn(() => {
    throw new Error('native digest crashed');
  });
  mockNativeSessionSnapshots.sessionCandidateDigest = crashing;
  expect(sessionSnapshotSHA256(variant(13))).toBe(pureJS);
  expect(crashing).toHaveBeenCalledTimes(1);
});

test('candidates over the byte ceiling return null before the native call', () => {
  const nativeDigest = jest.fn(() => 'c'.repeat(64));
  mockNativeSessionSnapshots.sessionCandidateDigest = nativeDigest;
  expect(sessionSnapshotSHA256('x'.repeat(16 * 1024 * 1024 + 1))).toBeNull();
  expect(nativeDigest).not.toHaveBeenCalled();
});

test('a repeated candidate string is answered from memory without a second native call', () => {
  const nativeDigest = jest.fn(() => 'd'.repeat(64));
  mockNativeSessionSnapshots.sessionCandidateDigest = nativeDigest;
  const fresh = variant(21);
  expect(sessionSnapshotSHA256(fresh)).toBe('d'.repeat(64));
  expect(sessionSnapshotSHA256(variant(21))).toBe('d'.repeat(64));
  expect(nativeDigest).toHaveBeenCalledTimes(1);
  expect(sessionSnapshotSHA256(variant(22))).toBe('d'.repeat(64));
  expect(nativeDigest).toHaveBeenCalledTimes(2);
});

test('memory never returns a digest for a different candidate', () => {
  const seen: string[] = [];
  mockNativeSessionSnapshots.sessionCandidateDigest = jest.fn((json: string) => {
    seen.push(json);
    return String(seen.length).padStart(64, '0');
  });
  const a = variant(31);
  const b = variant(32);
  expect(sessionSnapshotSHA256(a)).toBe('1'.padStart(64, '0'));
  expect(sessionSnapshotSHA256(b)).toBe('2'.padStart(64, '0'));
  expect(sessionSnapshotSHA256(a)).toBe('1'.padStart(64, '0'));
  expect(seen).toEqual([a, b]);
});

/**
 * Stale agent attempt recovery at hydration (wp/zombie-cleanup).
 *
 * Fixtures under __tests__/fixtures/scenario-a4-* are byte-level pulls from
 * the real device lock-screen scenario (2026-09-03): the schema-9 session
 * containing 37 non-terminal attempts across every Agent phase, and the
 * native WAL with intent ledger rows, closed write batches, and active write
 * reservations.  The envelope fixture carries the previous launch's
 * writer_launch_instance_id, which is what makes every non-terminal attempt
 * stale at hydration.
 */
declare const __dirname: string;

const fs = jest.requireActual('node:fs') as {
  readFileSync(file: string, encoding: 'utf8'): string;
  writeFileSync(file: string, content: string): void;
};
const path = jest.requireActual('node:path') as {
  resolve(...segments: string[]): string;
};

import { sessionSnapshotSHA256 } from '../src/completion/SessionPersistence';
import {
  CHAT_STATE_SCHEMA_VERSION,
  createChatStore,
  safeHydrateChatState,
  serializeChatState,
  type NativeAgentDiscardProofV1,
  type NativeSessionCommitProofV1,
  type SessionAuthority,
} from '../src/state';

const fixtureDir = path.resolve(__dirname, 'fixtures');
const nativeFixtureDir = path.resolve(
  __dirname,
  '../ios/RishTests/Fixtures',
);

type PersistedAttemptRow = {
  attempt_id: string;
  status: string;
  failure_code: string | null;
  journal_revision: number;
  agent: Record<string, unknown> | null;
  rounds: unknown[];
  active_round: unknown;
};

type PersistedSessionRow = {
  schema_version: number;
  conversations: Array<{
    id: string;
    attempts: PersistedAttemptRow[];
    turns: Array<{ turn_id: string; attempt_ids: string[] }>;
    [key: string]: unknown;
  }>;
  agent_transcript_cleanup_outbox: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

function readJSON(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(fixtureDir, file), 'utf8'));
}

const scenarioSession = readJSON('scenario-a4-session.json') as PersistedSessionRow;
const scenarioWAL = readJSON('scenario-a4-wal.json') as {
  authorities: unknown[];
  reservations: Array<{ attempt_id: string; keys: unknown[] }>;
  ledger: Array<{ locator: { attempt_id: string }; state: string }>;
  batches: unknown[];
  dispatch: Array<{ locator: { attempt_id: string }; dispatch_state: string }>;
  transcripts: unknown[];
  cleanup: unknown[];
  rounds: Array<{ locator: { attempt_id: string }; state: string }>;
};
const scenarioEnvelope = readJSON('scenario-a4-envelope.json') as {
  generation: number;
  session_sha256: string;
  writer_launch_instance_id: string;
};

const PREVIOUS_LAUNCH = scenarioEnvelope.writer_launch_instance_id;
const CURRENT_LAUNCH = '5c3bc983-2d1d-4dc9-a4e5-860b0def37ca';
const AUTHORITY: SessionAuthority = {
  generation: scenarioEnvelope.generation,
  sessionSha256: scenarioEnvelope.session_sha256,
};
const HYDRATION_AUTHORITY = {
  schema_version: 1 as const,
  generation: scenarioEnvelope.generation,
  session_sha256: scenarioEnvelope.session_sha256,
};
const NOW = '2026-09-04T00:00:00.000Z';
const FRESH_ATTEMPT_ID = '9e4fadc3-606e-4019-923c-e970f4bd6c25';

function nonTerminalAttempts(session: PersistedSessionRow): PersistedAttemptRow[] {
  const rows: PersistedAttemptRow[] = [];
  for (const conversation of session.conversations) {
    for (const attempt of conversation.attempts) {
      if (attempt.status === 'prepared' || attempt.status === 'sending') {
        rows.push(attempt);
      }
    }
  }
  return rows;
}

function hydrateStale(
  session: unknown,
  options: { staleWriterLaunch: boolean } = { staleWriterLaunch: true },
) {
  return safeHydrateChatState(session, {
    sessionAuthority: HYDRATION_AUTHORITY,
    ...options,
  });
}

describe('stale agent attempt recovery', () => {
  test('fixture captures the device scenario shape', () => {
    expect(scenarioEnvelope.writer_launch_instance_id).toBe(PREVIOUS_LAUNCH);
    expect(PREVIOUS_LAUNCH).not.toBe(CURRENT_LAUNCH);
    expect(scenarioEnvelope.generation).toBeGreaterThan(1);
    expect(scenarioSession.schema_version).toBe(CHAT_STATE_SCHEMA_VERSION);
    const stale = nonTerminalAttempts(scenarioSession);
    expect(stale.length).toBeGreaterThanOrEqual(30);
    const phases = new Set(
      stale.map(
        attempt =>
          (attempt.agent as { phase?: string } | null)?.phase ?? 'none',
      ),
    );
    expect(phases).toEqual(
      new Set([
        'none',
        'approval_pending',
        'batch_frozen',
        'round_in_flight',
        'tool_result_pending',
        'ready_for_round',
        'execution_intent',
      ]),
    );
    // The WAL fixture must carry the residue the recovery must discard.
    expect(scenarioWAL.reservations.length).toBeGreaterThan(0);
    expect(
      scenarioWAL.ledger.filter(row => row.state === 'intent').length,
    ).toBeGreaterThan(0);
  });

  test('hydrates every stale non-terminal attempt into a terminal interrupted failure', () => {
    const hydrated = hydrateStale(scenarioSession);
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) throw new Error('hydration failed');
    const staleIds = new Set(
      nonTerminalAttempts(scenarioSession).map(attempt => attempt.attempt_id),
    );
    expect(staleIds.size).toBeGreaterThanOrEqual(30);
    const state = hydrated.state;
    for (const conversation of Object.values(state.conversations)) {
      for (const attempt of conversation.attempts) {
        if (!staleIds.has(attempt.attemptId)) {
          // Terminal attempts keep their exact terminal projection (the
          // completed-with-visible-assistant rule from e13058c stays idle).
          expect(['completed', 'failed', 'cancelled']).toContain(attempt.status);
          continue;
        }
        expect(attempt.status).toBe('failed');
        expect(attempt.failureCode).toBe('E_ATTEMPT_INTERRUPTED');
        expect(attempt.activeRound).toBeNull();
        // The Agent journal stays as round/transcript evidence with its
        // original phase as forensic evidence of where the dead writer
        // stopped; the controller retry/resume paths refuse recovery for
        // interrupted attempts, so Retry always builds a fresh attempt.
        const source = nonTerminalAttempts(scenarioSession).find(
          candidate => candidate.attempt_id === attempt.attemptId,
        );
        if (source?.agent !== null && source?.agent !== undefined) {
          expect(attempt.agent).not.toBeNull();
          expect(attempt.journalRevision).toBeGreaterThanOrEqual(1);
          expect(
            (attempt.agent as { phase?: string } | null)?.phase,
          ).toBe((source.agent as { phase?: string } | null)?.phase);
        } else {
          expect(attempt.agent).toBeNull();
          expect(attempt.journalRevision).toBe(0);
        }
      }
    }
    // No attempt may remain in a non-terminal state after recovery.
    for (const conversation of Object.values(state.conversations)) {
      for (const attempt of conversation.attempts) {
        expect(attempt.status === 'prepared' || attempt.status === 'sending').toBe(
          false,
        );
      }
    }
  });

  test('enqueues deterministic failed cleanup entries for stale journaled attempts', () => {
    const hydrated = hydrateStale(scenarioSession);
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) throw new Error('hydration failed');
    const journaled = nonTerminalAttempts(scenarioSession).filter(
      attempt => attempt.agent !== null && attempt.agent !== undefined,
    );
    expect(journaled.length).toBeGreaterThanOrEqual(30);
    const outbox = hydrated.state.agentTranscriptCleanupOutbox ?? [];
    const byAttempt = new Map(
      outbox.map(entry => [entry.attempt_id, entry] as const),
    );
    for (const stale of journaled) {
      const entry = byAttempt.get(stale.attempt_id);
      expect(entry).toBeDefined();
      if (entry === undefined) continue;
      expect(entry.reason).toBe('failed');
      expect(entry.transcript_ref).toBe(
        (
          stale.agent as { transcript: { transcript_ref: string } }
        ).transcript.transcript_ref,
      );
      expect(entry.transcript_sha256).toBe(
        (
          stale.agent as { transcript: { transcript_sha256: string } }
        ).transcript.transcript_sha256,
      );
      // Deterministic identity: identical input hydrates to identical ids.
      expect(entry.cleanup_id.length).toBe(36);
      expect(entry.cleanup_id).not.toBe(stale.attempt_id);
    }
    // The agent-less prepared zombie (E_AGENT_PERSISTENCE residue) needs no
    // native discard; it is interrupted without an outbox entry.
    const agentless = nonTerminalAttempts(scenarioSession).filter(
      attempt => attempt.agent === null,
    );
    expect(agentless.length).toBe(1);
    for (const stale of agentless) {
      expect(byAttempt.has(stale.attempt_id)).toBe(false);
    }
    // The pre-existing completed outbox entry survives the recovery.
    expect(
      outbox.some(
        entry =>
          entry.attempt_id === '733a4eb5-9cdf-4dad-a605-e8502518552f' &&
          entry.reason === 'completed',
      ),
    ).toBe(true);
  });

  test('recovery is deterministic and idempotent across repeated hydration', () => {
    const first = hydrateStale(scenarioSession);
    const second = hydrateStale(scenarioSession);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('hydration failed');
    expect(serializeChatState(first.state)).toBe(serializeChatState(second.state));
    // Re-hydrating the recovered state with the same options is a no-op.
    const roundTrip = safeHydrateChatState(serializeChatState(first.state), {
      sessionAuthority: HYDRATION_AUTHORITY,
      staleWriterLaunch: true,
    });
    expect(roundTrip.ok).toBe(true);
    if (!roundTrip.ok) throw new Error('round-trip hydration failed');
    expect(serializeChatState(roundTrip.state)).toBe(
      serializeChatState(first.state),
    );
    // Without the stale flag the legacy semantics remain untouched.
    const legacy = safeHydrateChatState(scenarioSession, {
      sessionAuthority: HYDRATION_AUTHORITY,
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error('legacy hydration failed');
    expect(serializeChatState(legacy.state)).not.toBe(
      serializeChatState(first.state),
    );
  });

  test('retry never resumes the stale attempt; it prepares a fresh attempt in the same turn', () => {
    const hydrated = hydrateStale(scenarioSession);
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) throw new Error('hydration failed');
    const store = createChatStore({
      initialState: hydrated.state,
      now: () => NOW,
      createLifecycleId: () => FRESH_ATTEMPT_ID,
    });
    // The lock-screen conversation with the approval_pending zombie attempt.
    const conversationId = '70c1fefc-cd94-4849-bbc7-1fc3de40c9cd';
    const staleAttemptId = 'b766c10b-4e61-449c-a30d-2a0b3f0041bb';
    const staleBefore = store
      .getState()
      .conversations[conversationId]?.attempts.find(
        attempt => attempt.attemptId === staleAttemptId,
      );
    expect(staleBefore).toMatchObject({
      status: 'failed',
      failureCode: 'E_ATTEMPT_INTERRUPTED',
      agent: { phase: 'approval_pending' },
    });
    const retry = store.retryAttempt(conversationId, staleAttemptId);
    expect(retry).not.toBeNull();
    expect(retry?.turnId).toBe(staleBefore?.turnId);
    expect(retry?.attemptId).toBe(FRESH_ATTEMPT_ID);
    const turn = store
      .getState()
      .conversations[conversationId]?.turns.find(
        candidate => candidate.turnId === staleBefore?.turnId,
      );
    expect(turn?.attemptIds).toContain(staleAttemptId);
    expect(turn?.attemptIds).toContain(FRESH_ATTEMPT_ID);
    const fresh = store
      .getState()
      .conversations[conversationId]?.attempts.find(
        attempt => attempt.attemptId === FRESH_ATTEMPT_ID,
      );
    expect(fresh).toMatchObject({ status: 'prepared', agent: null, rounds: [] });
    // The stale attempt stays terminal and is never reactivated.
    expect(
      store.getState().conversations[conversationId]?.attempts.find(
        attempt => attempt.attemptId === staleAttemptId,
      ),
    ).toMatchObject({ status: 'failed', activeRound: null });
  });

  test('stale reservation owners all become terminal so the native drain can discard them', () => {
    const hydrated = hydrateStale(scenarioSession);
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) throw new Error('hydration failed');
    const byAttempt = new Map(
      Object.values(hydrated.state.conversations)
        .flatMap(conversation => conversation.attempts)
        .map(attempt => [attempt.attemptId, attempt] as const),
    );
    for (const reservation of scenarioWAL.reservations) {
      const attempt = byAttempt.get(reservation.attempt_id);
      expect(attempt).toBeDefined();
      // Every reservation owner is terminal after recovery: interrupted
      // attempts become failed, and the already-completed attempt with a
      // pending cleanup entry stays completed (idle rule from e13058c).
      expect(['failed', 'completed', 'cancelled']).toContain(attempt?.status);
      if (attempt?.status === 'failed') {
        expect(attempt.failureCode).toBe('E_ATTEMPT_INTERRUPTED');
      }
    }
    // Every intent ledger row belongs to a reservation owner that is now
    // terminal; the native interrupt transaction drops those never-dispatched
    // rows so no write_file can ever be re-executed.
    for (const row of scenarioWAL.ledger) {
      if (row.state !== 'intent') continue;
      const attempt = byAttempt.get(row.locator.attempt_id);
      expect(attempt).toBeDefined();
      expect(attempt?.status).toBe('failed');
      expect(attempt?.failureCode).toBe('E_ATTEMPT_INTERRUPTED');
    }
    // The fresh attempt id namespace never reuses the stale locators.
    const staleAttemptIds = new Set(
      scenarioWAL.ledger.map(row => row.locator.attempt_id),
    );
    expect(staleAttemptIds.has(FRESH_ATTEMPT_ID)).toBe(false);
  });

  test('cleanup outbox drains through the acknowledge contract on next launch', () => {
    const hydrated = hydrateStale(scenarioSession);
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) throw new Error('hydration failed');
    const store = createChatStore({
      initialState: hydrated.state,
      now: () => NOW,
    });
    store.setSessionAuthority(AUTHORITY);
    let drained = 0;
    let nextGeneration = AUTHORITY.generation + 1;
    for (;;) {
      const outbox = store.getState().agentTranscriptCleanupOutbox ?? [];
      if (outbox.length === 0) break;
      const entry = outbox[0]!;
      const transaction =
        store.acknowledgeAgentTranscriptCleanupTransaction(
          entry.cleanup_id,
          entry,
        );
      expect(transaction).not.toBeNull();
      if (transaction === null) break;
      const candidateDigest = sessionSnapshotSHA256(store.serialize());
      expect(candidateDigest).not.toBeNull();
      if (candidateDigest === null) break;
      // The production drain commits the CAS result first and installs its
      // authority before settling the acknowledgement transaction; each
      // acknowledgement advances the session generation by one.
      const committedAuthority: SessionAuthority = {
        generation: nextGeneration,
        sessionSha256: candidateDigest,
      };
      store.setSessionAuthority(committedAuthority);
      const proof: NativeSessionCommitProofV1 = {
        schema_version: 1,
        generation: committedAuthority.generation,
        session_sha256: committedAuthority.sessionSha256,
      };
      const discardProof: NativeAgentDiscardProofV1 = {
        schema_version: 2,
        status: 'discarded',
        operation_id: 'aaaaaaa1-2222-4333-8444-aaaaaaaaaaaa',
        cleanup_id: entry.cleanup_id,
        task_id: entry.task_id,
        conversation_id: entry.conversation_id,
        attempt_id: entry.attempt_id,
        transcript_ref: entry.transcript_ref,
        transcript_sha256: entry.transcript_sha256,
      };
      expect(transaction.commit(proof, discardProof)).toBe(true);
      drained += 1;
      nextGeneration += 1;
    }
    expect(drained).toBeGreaterThan(30);
    expect(store.getState().agentTranscriptCleanupOutbox ?? []).toHaveLength(0);
  });

  test('retry of the interrupted journal-less attempt in the Smoke conversation prepares a fresh attempt with the same visible history', () => {
    // The device's failed send left 3c9ff09d as prepared/agent=null in the
    // Smoke conversation; recovery interrupts it and Retry prepares a fresh
    // attempt in the same turn.  The serialized result is the second parity
    // fixture: the native end-to-end commits it after the recovered session
    // and prepares the fresh attempt against it.
    const hydrated = hydrateStale(scenarioSession);
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) throw new Error('hydration failed');
    const store = createChatStore({
      initialState: hydrated.state,
      now: () => NOW,
      createLifecycleId: () => FRESH_ATTEMPT_ID,
    });
    const conversationId = 'db9c06db-7880-4ba0-8fae-54a230584e3f';
    const staleAttemptId = '3c9ff09d-7002-44b8-a41d-c60fd8a435a9';
    const stale = store
      .getState()
      .conversations[conversationId]?.attempts.find(
        attempt => attempt.attemptId === staleAttemptId,
      );
    expect(stale).toMatchObject({
      status: 'failed',
      failureCode: 'E_ATTEMPT_INTERRUPTED',
      agent: null,
    });
    const retry = store.retryAttempt(conversationId, staleAttemptId);
    expect(retry).toMatchObject({ attemptId: FRESH_ATTEMPT_ID, turnId: stale?.turnId });
    const fresh = store
      .getState()
      .conversations[conversationId]?.attempts.find(
        attempt => attempt.attemptId === FRESH_ATTEMPT_ID,
      );
    expect(fresh).toMatchObject({ status: 'prepared', agent: null, rounds: [] });
    expect(fresh?.visibleMessageIds).toEqual(stale?.visibleMessageIds);
    expect(fresh?.visibleMessageIds).toEqual([
      '17f69ddf-c2dc-4b6f-b3ed-404a4c22c600',
      '06c9a91f-fbbe-490a-a4d4-42971afc59a8',
      '0c481945-b3db-44b7-9113-b3f70aa77149',
    ]);
    const serialized = store.serialize();
    const target = path.resolve(
      nativeFixtureDir,
      'agent-interrupted-retry-session.json',
    );
    fs.writeFileSync(target, `${serialized}\n`);
    expect(fs.readFileSync(target, 'utf8')).toBe(`${serialized}\n`);
  });

  test('serializes the recovered parity fixture for the native snapshot store', () => {
    const hydrated = hydrateStale(scenarioSession);
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) throw new Error('hydration failed');
    const serialized = serializeChatState(hydrated.state);
    const target = path.resolve(
      nativeFixtureDir,
      'agent-interrupted-recovery-session.json',
    );
    fs.writeFileSync(target, `${serialized}\n`);
    expect(fs.readFileSync(target, 'utf8')).toBe(`${serialized}\n`);
    // The parity fixture must differ from the raw persisted session: the
    // recovery changed it, so the production bootstrap CAS-migrates it.
    expect(serialized).not.toBe(JSON.stringify(scenarioSession));
  });
});

describe('stale agent attempt recovery under outbox capacity pressure', () => {
  // Every UUID inside a cloned conversation is rewritten deterministically so
  // the clone carries its own conversation, turn, message, attempt, grant,
  // round, and transcript identities and never collides with the original.
  function cloneWithFreshIds<T>(value: T, tag: string): T {
    const serialized = JSON.stringify(value).replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu,
      uuid => `${tag}${uuid.slice(tag.length)}`,
    );
    return JSON.parse(serialized) as T;
  }

  function journaledZombies(session: PersistedSessionRow): number {
    return nonTerminalAttempts(session).filter(
      attempt => attempt.agent !== null && attempt.agent !== undefined,
    ).length;
  }

  test('interrupts journaled zombies only up to the outbox capacity and finishes on a later launch', () => {
    const doubled: PersistedSessionRow = {
      ...scenarioSession,
      conversations: [
        ...scenarioSession.conversations,
        ...cloneWithFreshIds(scenarioSession.conversations, 'c10e').filter(
          conversation =>
            conversation.attempts.some(
              attempt =>
                (attempt.status === 'prepared' ||
                  attempt.status === 'sending') &&
                attempt.agent !== null,
            ),
        ),
      ],
    };
    const existingEntries = doubled.agent_transcript_cleanup_outbox.length;
    const capacity = 64 - existingEntries;
    expect(journaledZombies(doubled)).toBeGreaterThan(capacity);

    const first = hydrateStale(doubled);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    const firstOutbox = first.state.agentTranscriptCleanupOutbox ?? [];
    expect(firstOutbox).toHaveLength(64);
    const firstAttempts = Object.values(first.state.conversations).flatMap(
      conversation => conversation.attempts,
    );
    const interruptedJournaled = firstAttempts.filter(
      attempt =>
        attempt.failureCode === 'E_ATTEMPT_INTERRUPTED' &&
        attempt.agent !== null,
    );
    expect(interruptedJournaled).toHaveLength(capacity);
    // Journal-less zombies own no native residue and are always interrupted.
    expect(
      firstAttempts.filter(
        attempt =>
          (attempt.status === 'prepared' || attempt.status === 'sending') &&
          attempt.agent === null,
      ),
    ).toHaveLength(0);
    const deferred = firstAttempts.filter(
      attempt => attempt.status === 'prepared' || attempt.status === 'sending',
    );
    expect(deferred).toHaveLength(journaledZombies(doubled) - capacity);
    // Deterministic: the first journaled zombies in file order win.
    const orderedIds = doubled.conversations.flatMap(conversation =>
      conversation.attempts
        .filter(
          attempt =>
            (attempt.status === 'prepared' || attempt.status === 'sending') &&
            attempt.agent !== null,
        )
        .map(attempt => attempt.attempt_id),
    );
    expect(new Set(interruptedJournaled.map(attempt => attempt.attemptId))).toEqual(
      new Set(orderedIds.slice(0, capacity)),
    );

    // Once the drain has acknowledged the failed entries, the next launch
    // interrupts the deferred remainder.
    const drained = JSON.parse(serializeChatState(first.state)) as PersistedSessionRow;
    drained.agent_transcript_cleanup_outbox =
      drained.agent_transcript_cleanup_outbox.filter(
        entry => entry.reason !== 'failed',
      );
    const second = hydrateStale(drained);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error.message);
    const secondAttempts = Object.values(second.state.conversations).flatMap(
      conversation => conversation.attempts,
    );
    expect(
      secondAttempts.filter(
        attempt => attempt.status === 'prepared' || attempt.status === 'sending',
      ),
    ).toHaveLength(0);
    expect(
      (second.state.agentTranscriptCleanupOutbox ?? []).filter(
        entry => entry.reason === 'failed',
      ),
    ).toHaveLength(deferred.length);
  });
});

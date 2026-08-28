import {
  createSessionPersistenceCoordinator,
  type SessionDurabilityResult,
} from '../src/completion/SessionPersistence';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const CANDIDATE = JSON.stringify({
  schema_version: 6,
  active_conversation_id: null,
  conversations: [],
  messages: [],
  preferences: { locale: 'en-US', theme_mode: 'system' },
});

function coordinator(options: {
  persist?: jest.Mock;
  load?: jest.Mock;
}) {
  const persist = options.persist ?? jest.fn().mockResolvedValue(true);
  const load = options.load ?? jest.fn().mockResolvedValue(null);
  return {
    persist,
    load,
    value: createSessionPersistenceCoordinator({
      persistSession: persist,
      loadSession: load,
    }),
  };
}

describe('session persistence coordinator', () => {
  test('returns exact committed result only for native true', async () => {
    const fixture = coordinator({});
    await expect(fixture.value.write(CANDIDATE)).resolves.toEqual({
      status: 'committed',
    } satisfies SessionDurabilityResult);
    expect(fixture.persist).toHaveBeenCalledWith(CANDIDATE);
    expect(fixture.load).not.toHaveBeenCalled();
  });

  test.each([
    ['false', jest.fn().mockResolvedValue(false)],
    ['reject', jest.fn().mockRejectedValue(new Error('PROOF_SECRET'))],
  ])(
    'detects session-only durability after native %s',
    async (_label, persist) => {
      const reordered = JSON.stringify({
        preferences: { theme_mode: 'system', locale: 'en-US' },
        messages: [],
        conversations: [],
        active_conversation_id: null,
        schema_version: 6,
      });
      const fixture = coordinator({
        persist,
        load: jest.fn().mockResolvedValue(reordered),
      });
      await expect(fixture.value.write(CANDIDATE)).resolves.toEqual({
        status: 'session_only',
      });
    },
  );

  test.each([null, JSON.stringify({ schema_version: 5 })])(
    'confirms not-committed when stored session differs: %p',
    async stored => {
      const fixture = coordinator({
        persist: jest.fn().mockResolvedValue(false),
        load: jest.fn().mockResolvedValue(stored),
      });
      await expect(fixture.value.write(CANDIDATE)).resolves.toEqual({
        status: 'not_committed',
      });
    },
  );

  test.each([
    ['load rejection', jest.fn().mockRejectedValue(new Error('LOAD_SECRET'))],
    ['invalid JSON', jest.fn().mockResolvedValue('{')],
    ['non-string native value', jest.fn().mockResolvedValue({ raw: true })],
  ])('returns unknown for %s without leaking values', async (_label, load) => {
    const fixture = coordinator({
      persist: jest.fn().mockRejectedValue(new Error('PERSIST_SECRET')),
      load,
    });
    const result = await fixture.value.write(CANDIDATE);
    expect(result).toEqual({ status: 'unknown' });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|raw/);
  });

  test('serializes persist and verification across concurrent callers', async () => {
    const first = deferred<boolean>();
    const persist = jest
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(true);
    const fixture = coordinator({ persist });

    const firstWrite = fixture.value.write(CANDIDATE);
    const secondCandidate = JSON.stringify({ ...JSON.parse(CANDIDATE), n: 2 });
    const secondWrite = fixture.value.write(secondCandidate);
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(1);

    first.resolve(true);
    await expect(firstWrite).resolves.toEqual({ status: 'committed' });
    await expect(secondWrite).resolves.toEqual({ status: 'committed' });
    expect(persist.mock.calls.map(call => call[0])).toEqual([
      CANDIDATE,
      secondCandidate,
    ]);
  });

  test('keeps the second persist blocked through first-load verification', async () => {
    const verification = deferred<unknown>();
    const persist = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const load = jest.fn().mockImplementationOnce(() => verification.promise);
    const fixture = coordinator({ persist, load });
    const first = fixture.value.write(CANDIDATE);
    const second = fixture.value.write(CANDIDATE);
    await Promise.resolve();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);

    verification.resolve(CANDIDATE);
    await expect(first).resolves.toEqual({ status: 'session_only' });
    await expect(second).resolves.toEqual({ status: 'committed' });
    expect(persist).toHaveBeenCalledTimes(2);
  });

  test('caps active plus queued writes at sixteen without retaining overflow', async () => {
    const active = deferred<boolean>();
    const persist = jest
      .fn()
      .mockImplementationOnce(() => active.promise)
      .mockResolvedValue(true);
    const fixture = coordinator({ persist });
    const accepted = Array.from({ length: 16 }, (_, index) =>
      fixture.value.write(
        JSON.stringify(
          Object.assign({}, JSON.parse(CANDIDATE), { sequence: index }),
        ),
      ),
    );
    const overflow = fixture.value.write(
      JSON.stringify(
        Object.assign({}, JSON.parse(CANDIDATE), { sequence: 16 }),
      ),
    );
    let overflowResult: SessionDurabilityResult | undefined;
    overflow.then(result => {
      overflowResult = result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(overflowResult).toEqual({ status: 'unknown' });
    expect(persist).toHaveBeenCalledTimes(1);

    active.resolve(true);
    await expect(Promise.all(accepted)).resolves.toHaveLength(16);
    expect(persist).toHaveBeenCalledTimes(16);
  });

  test('preflights invalid candidates before a hung active write queue', async () => {
    const active = deferred<boolean>();
    const persist = jest.fn().mockImplementationOnce(() => active.promise);
    const fixture = coordinator({ persist });
    const first = fixture.value.write(CANDIDATE);
    const tooDeep = '['.repeat(65) + '0' + ']'.repeat(65);
    const invalid = fixture.value.write(tooDeep);
    let invalidResult: SessionDurabilityResult | undefined;
    invalid.then(result => {
      invalidResult = result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(invalidResult).toEqual({ status: 'unknown' });
    expect(persist).toHaveBeenCalledTimes(1);
    active.resolve(true);
    await first;
  });

  test('continues the queue after an indeterminate first write', async () => {
    const persist = jest
      .fn()
      .mockRejectedValueOnce(new Error('FIRST'))
      .mockResolvedValueOnce(true);
    const load = jest.fn().mockRejectedValueOnce(new Error('VERIFY'));
    const fixture = coordinator({ persist, load });
    const first = fixture.value.write(CANDIDATE);
    const second = fixture.value.write(CANDIDATE);
    await expect(first).resolves.toEqual({ status: 'unknown' });
    await expect(second).resolves.toEqual({ status: 'committed' });
  });

  test('rejects oversized or deeply nested candidates before native writes', async () => {
    const fixture = coordinator({});
    const oversized = `"${'x'.repeat(16 * 1024 * 1024)}"`;
    await expect(fixture.value.write(oversized)).resolves.toEqual({
      status: 'unknown',
    });
    expect(fixture.persist).not.toHaveBeenCalled();

    let deep: unknown = 0;
    for (let index = 0; index < 70; index += 1) deep = [deep];
    await expect(fixture.value.write(JSON.stringify(deep))).resolves.toEqual({
      status: 'unknown',
    });
    expect(fixture.persist).not.toHaveBeenCalled();
  });

  test('rejects depth and token excess before JSON.parse for candidate and load', async () => {
    const tooDeep = '['.repeat(65) + '0' + ']'.repeat(65);
    const tooManyTokens = '[' + '0,'.repeat(250_000) + '0]';
    const parse = jest.spyOn(JSON, 'parse');
    try {
      const candidateFixture = coordinator({});
      await expect(candidateFixture.value.write(tooDeep)).resolves.toEqual({
        status: 'unknown',
      });
      await expect(
        candidateFixture.value.write(tooManyTokens),
      ).resolves.toEqual({ status: 'unknown' });
      expect(parse).not.toHaveBeenCalled();
      expect(candidateFixture.persist).not.toHaveBeenCalled();

      const loadFixture = coordinator({
        persist: jest.fn().mockResolvedValue(false),
        load: jest.fn().mockResolvedValue(tooDeep),
      });
      await expect(loadFixture.value.write(CANDIDATE)).resolves.toEqual({
        status: 'unknown',
      });
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  test('treats quoted and escaped brackets as string content in lexical scan', async () => {
    const quoted = JSON.stringify({
      text:
        '['.repeat(100) +
        ' escaped quote: \\" ' +
        ']'.repeat(100),
    });
    const fixture = coordinator({});
    await expect(fixture.value.write(quoted)).resolves.toEqual({
      status: 'committed',
    });
  });

  test('does not inspect hostile non-string load results', async () => {
    let getterCalls = 0;
    const hostile = {};
    Object.defineProperty(hostile, 'raw', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error('HOSTILE_GETTER');
      },
    });
    const fixture = coordinator({
      persist: jest.fn().mockResolvedValue(false),
      load: jest.fn().mockResolvedValue(hostile),
    });
    await expect(fixture.value.write(CANDIDATE)).resolves.toEqual({
      status: 'unknown',
    });
    expect(getterCalls).toBe(0);
  });
});

import {
  contextUsageEntry,
  summarizeContextUsage,
  type UsageConversation,
} from '../src/usage/contextUsage';

const conversation = (
  overrides: Partial<UsageConversation> = {},
): UsageConversation => ({
  id: 'c1',
  title: 'Refactor',
  projectContext: {
    status: 'ready',
    manifest: {
      project_name: 'demo',
      model: 'deepseek-v4-pro',
      captured_at: '2026-09-30T08:00:00.000Z',
      context_bytes: 400,
      estimated_tokens: 100,
      included: [{ path: 'a.md' }, { path: 'b.md' }],
      omitted: [{ path: 'c.bin' }],
    },
  },
  ...overrides,
});

describe('contextUsageEntry', () => {
  test('reads a ready snapshot into an entry', () => {
    expect(contextUsageEntry(conversation())).toEqual({
      conversationId: 'c1',
      conversationTitle: 'Refactor',
      projectName: 'demo',
      model: 'deepseek-v4-pro',
      capturedAt: '2026-09-30T08:00:00.000Z',
      contextBytes: 400,
      estimatedTokens: 100,
      includedFiles: 2,
      omittedFiles: 1,
    });
  });

  test('ignores a conversation with no context at all', () => {
    expect(contextUsageEntry(conversation({ projectContext: null }))).toBeNull();
    expect(
      contextUsageEntry(conversation({ projectContext: undefined })),
    ).toBeNull();
  });

  test('counts only context that was actually confirmed', () => {
    for (const status of ['pending', 'stale', 'error', '', 'ready ']) {
      expect(
        contextUsageEntry(
          conversation({ projectContext: { status, manifest: { context_bytes: 4 } } }),
        ),
      ).toBeNull();
    }
  });

  test('ignores a ready context that carries no manifest', () => {
    expect(
      contextUsageEntry(conversation({ projectContext: { status: 'ready', manifest: null } })),
    ).toBeNull();
  });

  test('ignores a manifest with no readable byte count at all', () => {
    expect(
      contextUsageEntry(
        conversation({ projectContext: { status: 'ready', manifest: { project_name: 'x' } } }),
      ),
    ).toBeNull();
  });

  test('falls back rather than showing a blank name', () => {
    const entry = contextUsageEntry(
      conversation({
        title: '',
        projectContext: {
          status: 'ready',
          manifest: { context_bytes: 4, estimated_tokens: 1, project_name: '' },
        },
      }),
    );
    expect(entry?.conversationTitle).toBe('c1');
    expect(entry?.projectName).toBe('');
    expect(entry?.model).toBe('');
    expect(entry?.capturedAt).toBe('');
  });

  test('treats an unusable byte count as absent, not as zero', () => {
    // One field is readable, so the entry exists and the other reads zero.
    const entry = contextUsageEntry(
      conversation({
        projectContext: {
          status: 'ready',
          manifest: { project_name: 'x', context_bytes: -1, estimated_tokens: 1 },
        },
      }),
    );
    expect(entry).toEqual(
      expect.objectContaining({ contextBytes: 0, estimatedTokens: 1 }),
    );
    // Both fields unusable means there was nothing to read at all.
    expect(
      contextUsageEntry(
        conversation({
          projectContext: {
            status: 'ready',
            manifest: { context_bytes: -1, estimated_tokens: 1.5 },
          },
        }),
      ),
    ).toBeNull();
  });

  test('a manifest that is not one is ignored rather than read', () => {
    expect(
      contextUsageEntry(
        conversation({
          projectContext: { status: 'ready', manifest: 'nonsense' as never },
        }),
      ),
    ).toBeNull();
  });
});

describe('summarizeContextUsage', () => {
  test('answers an empty summary when nothing carries context', () => {
    const summary = summarizeContextUsage([
      conversation({ id: 'a', projectContext: null }),
      conversation({ id: 'b', projectContext: { status: 'pending' } }),
    ]);
    expect(summary.entries).toEqual([]);
    expect(summary.conversations).toBe(0);
    expect(summary.totalContextBytes).toBe(0);
    expect(summary.totalEstimatedTokens).toBe(0);
    expect(summary.includedFiles).toBe(0);
    expect(summary.omittedFiles).toBe(0);
  });

  test('totals what each conversation contributed', () => {
    const summary = summarizeContextUsage([
      conversation({ id: 'a' }),
      conversation({
        id: 'b',
        projectContext: {
          status: 'ready',
          manifest: {
            project_name: 'other',
            context_bytes: 800,
            estimated_tokens: 200,
            included: [{ path: 'x' }],
            omitted: [],
          },
        },
      }),
    ]);
    expect(summary.conversations).toBe(2);
    expect(summary.totalContextBytes).toBe(1200);
    expect(summary.totalEstimatedTokens).toBe(300);
    expect(summary.includedFiles).toBe(3);
    expect(summary.omittedFiles).toBe(1);
  });

  test('orders by capture time, most recent first', () => {
    const summary = summarizeContextUsage([
      conversation({
        id: 'old',
        projectContext: {
          status: 'ready',
          manifest: { context_bytes: 4, captured_at: '2026-01-01T00:00:00.000Z' },
        },
      }),
      conversation({
        id: 'new',
        projectContext: {
          status: 'ready',
          manifest: { context_bytes: 4, captured_at: '2026-06-01T00:00:00.000Z' },
        },
      }),
    ]);
    expect(summary.entries.map(entry => entry.conversationId)).toEqual(['new', 'old']);
  });

  test('breaks a tie by conversation id, so the order is stable', () => {
    const summary = summarizeContextUsage([
      conversation({
        id: 'b',
        projectContext: { status: 'ready', manifest: { context_bytes: 4, captured_at: 'same' } },
      }),
      conversation({
        id: 'a',
        projectContext: { status: 'ready', manifest: { context_bytes: 4, captured_at: 'same' } },
      }),
    ]);
    expect(summary.entries.map(entry => entry.conversationId)).toEqual(['a', 'b']);
  });

  test('counts one conversation once even when it is the only one', () => {
    expect(summarizeContextUsage([conversation()]).conversations).toBe(1);
  });

  test('is a pure function of what it was given', () => {
    const input = [conversation()];
    const frozen = JSON.stringify(input);
    expect(summarizeContextUsage(input)).toEqual(summarizeContextUsage(input));
    expect(JSON.stringify(input)).toBe(frozen);
  });
});

describe('per-model totals', () => {
  const forModel = (id: string, model: string, tokens: number, bytes: number) =>
    conversation({
      id,
      projectContext: {
        status: 'ready',
        manifest: {
          project_name: 'p',
          model,
          context_bytes: bytes,
          estimated_tokens: tokens,
          captured_at: `2026-01-0${tokens % 9}T00:00:00.000Z`,
        },
      },
    });

  test('groups by model, heaviest first', () => {
    const summary = summarizeContextUsage([
      forModel('a', 'deepseek-v4-flash', 100, 400),
      forModel('b', 'claude-sonnet-5', 900, 3600),
      forModel('c', 'deepseek-v4-flash', 50, 200),
    ]);
    expect(summary.byModel.map(entry => entry.model)).toEqual([
      'claude-sonnet-5',
      'deepseek-v4-flash',
    ]);
    expect(summary.byModel[0]).toEqual({
      model: 'claude-sonnet-5',
      conversations: 1,
      estimatedTokens: 900,
      contextBytes: 3600,
    });
    expect(summary.byModel[1]).toEqual({
      model: 'deepseek-v4-flash',
      conversations: 2,
      estimatedTokens: 150,
      contextBytes: 600,
    });
  });

  test('breaks a tie on the model name, so the order is stable', () => {
    const summary = summarizeContextUsage([
      forModel('a', 'z-model', 100, 400),
      forModel('b', 'a-model', 100, 400),
    ]);
    expect(summary.byModel.map(entry => entry.model)).toEqual([
      'a-model',
      'z-model',
    ]);
  });

  test('keeps a snapshot that recorded no model, rather than hiding its tokens', () => {
    const summary = summarizeContextUsage([
      forModel('a', 'known', 100, 400),
      forModel('b', '', 50, 200),
    ]);
    const unrecorded = summary.byModel.find(entry => entry.model === '');
    expect(unrecorded?.estimatedTokens).toBe(50);
    // The parts must add up to the total shown above them.
    expect(
      summary.byModel.reduce((total, entry) => total + entry.estimatedTokens, 0),
    ).toBe(summary.totalEstimatedTokens);
    expect(
      summary.byModel.reduce((total, entry) => total + entry.conversations, 0),
    ).toBe(summary.conversations);
  });

  test('an empty summary has no models at all', () => {
    expect(summarizeContextUsage([]).byModel).toEqual([]);
  });
});

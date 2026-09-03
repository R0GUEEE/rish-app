const mockNativeLocalRuntime = {
  bootstrap: jest.fn(),
  credentialStatus: jest.fn(),
  presentCredentialPrompt: jest.fn(),
  clearCredential: jest.fn(),
  complete: jest.fn(),
  completeV2: jest.fn(),
  recordModelTransition: jest.fn(),
  cancelCompletion: jest.fn(),
  persistSession: jest.fn(),
  loadSession: jest.fn(),
};

import { NativeModules } from 'react-native';

(NativeModules as Record<string, unknown>).LocalRuntime =
  mockNativeLocalRuntime;
const { LocalRuntime } = jest.requireActual(
  '../src/native/LocalRuntime',
) as typeof import('../src/native/LocalRuntime');
const { DshHarnessAdapter } = jest.requireActual(
  '../src/harness/adapters/DshHarnessAdapter',
) as typeof import('../src/harness/adapters/DshHarnessAdapter');
const { CompletionBridgeError } = jest.requireActual(
  '../src/completion/validation',
) as typeof import('../src/completion/validation');

const TURN_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const ROUND_ID = '33333333-3333-4333-8333-333333333333';
const PROVIDER_REQUEST_ID = '44444444-4444-4444-8444-444444444444';
const SNAPSHOT_ID = '66666666-6666-4666-8666-666666666666';
const CONSENT_ID = '77777777-7777-4777-8777-777777777777';
const CONVERSATION_ID = '88888888-8888-4888-8888-888888888888';
const PROJECT_ID = '99999999-9999-4999-8999-999999999999';
const SHA256 = 'a'.repeat(64);

function schema2Request() {
  return {
    schemaVersion: 2 as const,
    harnessId: 'dsh' as const,
    turnId: TURN_ID,
    attemptId: ATTEMPT_ID,
    roundId: ROUND_ID,
    roundIndex: 1,
    model: 'deepseek-v4-flash' as const,
    thinkingMode: 'high' as const,
    visibleHistory: [
      {
        role: 'user' as const,
        content: 'inspect it',
        attachments: [
          {
            schema_version: 1 as const,
            id: '55555555-5555-4555-8555-555555555555',
            kind: 'text' as const,
            name: 'note.txt',
            mime_type: 'text/plain',
            size: 7,
          },
        ],
      },
    ],
    roundTranscript: [
      {
        role: 'assistant' as const,
        content: '',
        reasoning_content: 'need the file',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function' as const,
            function: { name: 'read_file', arguments: '{"path":"a.md"}' },
          },
        ],
      },
      {
        role: 'tool' as const,
        tool_call_id: 'call_1',
        content: 'bounded result',
      },
    ],
    tools: [
      {
        type: 'function' as const,
        function: {
          name: 'read_file',
          description: 'Read a bounded file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      },
    ],
    projectContext: null,
  };
}

function schema2Result(): Record<string, unknown> {
  return {
    schema_version: 2,
    harness_id: 'dsh',
    turn_id: TURN_ID,
    attempt_id: ATTEMPT_ID,
    round_id: ROUND_ID,
    round_index: 1,
    provider_request_id: PROVIDER_REQUEST_ID,
    provider_response_id: 'resp_123',
    requested_model: 'deepseek-v4-flash',
    model: 'deepseek-v4-flash',
    thinking_mode: 'high',
    text: 'done',
    reasoning: 'verified',
    tool_calls: [],
    finish_reason: 'stop',
    latency_ms: 250,
    visible_history_sha256: SHA256,
    model_input_sha256: SHA256,
    request_body_sha256: SHA256,
    project_context_receipt: null,
  };
}

function schema3Request() {
  return {
    ...schema2Request(),
    schemaVersion: 3 as const,
    projectContext: {
      schemaVersion: 1 as const,
      snapshotId: SNAPSHOT_ID,
      consentReceiptId: CONSENT_ID,
      conversationId: CONVERSATION_ID,
      projectId: PROJECT_ID,
      provider: 'deepseek' as const,
      policy: 'chat-read-v1' as const,
    },
  };
}

function schema3Result(): Record<string, unknown> {
  return {
    ...schema2Result(),
    schema_version: 3,
    project_context_receipt: {
      schema_version: 1,
      snapshot_id: SNAPSHOT_ID,
      snapshot_sha256: SHA256,
      source_fingerprint: SHA256,
      context_bytes: 123,
      verified_at: '2026-08-28T00:00:00.000Z',
    },
  };
}

type TranscriptFixture = ReturnType<
  typeof schema2Request
>['roundTranscript'][number];

function transcriptAtFourMiBBoundary(extraBytes: number): TranscriptFixture[] {
  const chunk = 'x'.repeat(256 * 1024);
  const transcript: TranscriptFixture[] = [];
  for (let index = 0; index < 6; index += 1) {
    const callId = `call_${index}`;
    transcript.push({
      role: 'assistant',
      content: index === 5 ? 'x'.repeat(extraBytes) : chunk,
      reasoning_content: index === 5 ? '' : chunk,
      tool_calls: [
        {
          id: callId,
          type: 'function',
          function: { name: 'read_file', arguments: '{}' },
        },
      ],
    });
    transcript.push({
      role: 'tool',
      tool_call_id: callId,
      content: chunk,
    });
  }
  return transcript;
}

function attachmentFixtureId(index: number): string {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockNativeLocalRuntime.presentCredentialPrompt.mockResolvedValue({
    status: 'cancelled',
  });
});

test('links the complete native test double', () => {
  expect(NativeModules.LocalRuntime).toBe(mockNativeLocalRuntime);
  expect(LocalRuntime.isAvailable()).toBe(true);
});

test.each(['zh-CN', 'en-US'] as const)(
  'passes the resolved %s locale to the native credential prompt',
  async locale => {
    await LocalRuntime.presentCredentialPrompt(locale);

    expect(mockNativeLocalRuntime.presentCredentialPrompt).toHaveBeenCalledWith(
      locale,
    );
  },
);

test('falls back to English for an unsupported runtime locale', async () => {
  await LocalRuntime.presentCredentialPrompt('fr-FR' as never);

  expect(mockNativeLocalRuntime.presentCredentialPrompt).toHaveBeenCalledWith(
    'en-US',
  );
});

test('passes opaque attachment references to the native completion boundary', async () => {
  mockNativeLocalRuntime.complete.mockResolvedValue({
    text: 'described',
    model: 'deepseek-v4-flash-vision-exp',
    request_id: '10000000-0000-4000-8000-000000000001',
    latency_ms: 1,
    reasoning: '',
    thinking_mode: 'off',
  });
  const history = [
    {
      role: 'user' as const,
      content: '',
      attachments: [
        {
          schema_version: 1 as const,
          id: '20000000-0000-4000-8000-000000000002',
          kind: 'image' as const,
          name: 'photo.png',
          mime_type: 'image/png',
          size: 42,
        },
      ],
    },
  ];

  await LocalRuntime.complete(
    'deepseek-v4-flash-vision-exp',
    history,
    '10000000-0000-4000-8000-000000000001',
    'off',
  );

  expect(mockNativeLocalRuntime.complete).toHaveBeenCalledWith(
    'deepseek-v4-flash-vision-exp',
    history,
    '10000000-0000-4000-8000-000000000001',
    'off',
  );
  expect(JSON.stringify(history)).not.toContain('base64');
  expect(JSON.stringify(history)).not.toContain('/Application Support/');
});

test('completionV2 sends a versioned envelope and maps the result verbatim', async () => {
  mockNativeLocalRuntime.completeV2.mockResolvedValueOnce({
    schema_version: 1,
    text: '',
    tool_calls: [
      { id: 'call_1', name: 'write_file', arguments: '{"path":"a.md"}' },
    ],
    finish_reason: 'tool_calls',
    model: 'deepseek-v4-flash',
    request_id: 'request-1',
    latency_ms: 42,
    reasoning: '',
    thinking_mode: 'high',
  });

  await expect(LocalRuntime.isCompletionV2Available()).toBe(true);
  const result = await LocalRuntime.completeV2({
    model: 'deepseek-v4-flash',
    requestId: 'request-1',
    thinkingMode: 'high',
    history: [{ role: 'user', content: 'do the thing' }],
    tools: [{ name: 'write_file', parameters: { type: 'object' } }],
  });

  const [envelope] =
    mockNativeLocalRuntime.completeV2.mock.calls[0] as [string];
  const decoded = JSON.parse(envelope) as Record<string, unknown>;
  expect(decoded).toEqual({
    schema_version: 1,
    model: 'deepseek-v4-flash',
    request_id: 'request-1',
    thinking_mode: 'high',
    history: [{ role: 'user', content: 'do the thing' }],
    tools: [{ name: 'write_file', parameters: { type: 'object' } }],
  });
  expect(result.finish_reason).toBe('tool_calls');
  expect(result.tool_calls[0]?.name).toBe('write_file');
  expect(result.request_id).toBe('request-1');
});

test('defaults the tool list to empty and rejects when unlinked', async () => {
  mockNativeLocalRuntime.completeV2.mockResolvedValueOnce({
    schema_version: 1,
    text: 'ok',
    tool_calls: [],
    finish_reason: 'stop',
    model: 'deepseek-v4-flash',
    request_id: 'r2',
    latency_ms: 5,
    reasoning: '',
    thinking_mode: 'off',
  });

  await LocalRuntime.completeV2({
    model: 'deepseek-v4-flash',
    requestId: 'r2',
    thinkingMode: 'off',
    history: [],
  });
  const decoded = JSON.parse(
    mockNativeLocalRuntime.completeV2.mock.calls[0][0] as string,
  ) as { tools: unknown[] };
  expect(decoded.tools).toEqual([]);

  const previous = mockNativeLocalRuntime.completeV2;
  delete (mockNativeLocalRuntime as Record<string, unknown>).completeV2;
  try {
    // The capability probe reads NativeModules lazily, so removing the
    // method must flip availability without touching other functions.
    await expect(LocalRuntime.isCompletionV2Available()).toBe(false);
    await expect(
      LocalRuntime.completeV2({
        model: 'deepseek-v4-flash',
        requestId: 'r3',
        thinkingMode: 'high',
        history: [],
      }),
    ).rejects.toMatchObject({
      code: 'E_COMPLETION_NATIVE',
      message: 'E_COMPLETION_NATIVE',
    });
  } finally {
    mockNativeLocalRuntime.completeV2 = previous;
  }
});

test('sanitizes schema1 native API failures and unknown failures', async () => {
  const legacyRequest = {
    model: 'deepseek-v4-flash' as const,
    requestId: 'request-legacy',
    thinkingMode: 'off' as const,
    history: [{ role: 'user' as const, content: 'hello' }],
  };
  mockNativeLocalRuntime.completeV2.mockRejectedValueOnce({
    code: 'api',
    message: 'provider-api-sentinel',
    cause: 'authorization-sentinel',
  });
  try {
    await LocalRuntime.completeV2(legacyRequest);
    throw new Error('expected rejection');
  } catch (error) {
    expect(error).toMatchObject({
      code: 'E_COMPLETION_HTTP_STATUS',
      message: 'E_COMPLETION_HTTP_STATUS',
    });
    expect(JSON.stringify(error)).not.toContain('sentinel');
  }

  mockNativeLocalRuntime.completeV2.mockRejectedValueOnce({
    code: 'legacy-unknown',
    message: 'provider-unknown-sentinel',
    cause: 'transport-sentinel',
  });
  await expect(LocalRuntime.completeV2(legacyRequest)).rejects.toMatchObject({
    code: 'E_COMPLETION_NATIVE',
    message: 'E_COMPLETION_NATIVE',
  });
});

test('forwards a redacted model transition envelope to native proof storage', async () => {
  mockNativeLocalRuntime.recordModelTransition.mockResolvedValueOnce({
    recorded: 3,
  });
  const entry = {
    conversation_id: 'opaque-conversation-id',
    from_model: 'deepseek-v4-flash' as const,
    to_model: 'deepseek-v4-pro' as const,
    source: 'composer_picker' as const,
    request_epoch: 7,
    request_state: 'idle' as const,
    attachment_busy: false,
    draft_image_count: 0,
    history_image_count: 0,
  };

  await expect(LocalRuntime.isRecordModelTransitionAvailable()).toBe(true);
  await expect(LocalRuntime.recordModelTransition(entry)).resolves.toEqual({
    recorded: 3,
  });
  expect(mockNativeLocalRuntime.recordModelTransition).toHaveBeenCalledWith(
    entry,
  );
  expect(JSON.stringify(entry)).not.toContain('message');
  expect(JSON.stringify(entry)).not.toContain('path');
  expect(JSON.stringify(entry)).not.toContain('key');
});

test('fails closed when model transition proof storage is not linked', async () => {
  const previous = mockNativeLocalRuntime.recordModelTransition;
  delete (mockNativeLocalRuntime as Record<string, unknown>)
    .recordModelTransition;
  try {
    await expect(LocalRuntime.isRecordModelTransitionAvailable()).toBe(false);
    await expect(
      LocalRuntime.recordModelTransition({
        conversation_id: 'conversation-id',
        from_model: 'deepseek-v4-flash',
        to_model: 'deepseek-v4-pro',
        source: 'settings_picker',
        request_epoch: 0,
        request_state: 'idle',
        attachment_busy: false,
        draft_image_count: 0,
        history_image_count: 0,
      }),
    ).rejects.toThrow(/recordModelTransition native method is not linked/);
  } finally {
    mockNativeLocalRuntime.recordModelTransition = previous;
  }
});

describe('strict completion schema 2 bridge', () => {
  test('projects the exact 12-key wire envelope without stringifying caller fields', async () => {
    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce(schema2Result());
    const request = {
      ...schema2Request(),
      callerOnlySentinel: 'must-not-cross-native-boundary',
    };

    const result = await LocalRuntime.completeV2(request);

    const [json] = mockNativeLocalRuntime.completeV2.mock.calls.at(-1) as [
      string,
    ];
    const wire = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(wire).sort()).toEqual(
      [
        'schema_version',
        'harness_id',
        'turn_id',
        'attempt_id',
        'round_id',
        'round_index',
        'model',
        'thinking_mode',
        'visible_history',
        'round_transcript',
        'tools',
        'project_context',
      ].sort(),
    );
    expect(wire).toEqual({
      schema_version: 2,
      harness_id: 'dsh',
      turn_id: TURN_ID,
      attempt_id: ATTEMPT_ID,
      round_id: ROUND_ID,
      round_index: 1,
      model: 'deepseek-v4-flash',
      thinking_mode: 'high',
      visible_history: schema2Request().visibleHistory,
      round_transcript: schema2Request().roundTranscript,
      tools: schema2Request().tools,
      project_context: null,
    });
    expect(json).not.toContain('callerOnlySentinel');
    expect(
      (
        wire.visible_history as Array<{
          attachments?: unknown[];
        }>
      )[0]?.attachments,
    ).toHaveLength(1);
    expect(result).toEqual(schema2Result());
  });

  test('accepts only the exact 20-key result shape', async () => {
    const expectedKeys = Object.keys(schema2Result()).sort();
    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce(schema2Result());

    const value = await LocalRuntime.completeV2(schema2Request());
    expect(Object.keys(value).sort()).toEqual(expectedKeys);

    for (const mutation of ['missing', 'extra'] as const) {
      const invalid = schema2Result();
      if (mutation === 'missing') delete invalid.request_body_sha256;
      else invalid.provider_sentinel = 'must-not-leak';
      mockNativeLocalRuntime.completeV2.mockResolvedValueOnce(invalid);
      await expect(
        LocalRuntime.completeV2(schema2Request()),
      ).rejects.toMatchObject({
        code: 'E_COMPLETION_RESULT_KEYS',
        message: 'E_COMPLETION_RESULT_KEYS',
      });
    }
  });

  test.each([
    [
      { turnId: 'AAAAAAAA-1111-4111-8111-111111111111' },
      'E_COMPLETION_IDENTIFIER',
    ],
    [{ roundIndex: 8 }, 'E_COMPLETION_ROUND'],
    [{ visibleHistory: [] }, 'E_COMPLETION_HISTORY'],
    [{ roundTranscript: [] }, 'E_COMPLETION_TRANSCRIPT'],
    [
      {
        tools: [
          {
            type: 'function' as const,
            function: {
              name: 'bad tool name',
              description: 'invalid',
              parameters: {},
            },
          },
        ],
      },
      'E_COMPLETION_TOOLS',
    ],
  ])('fails request preflight with the native contract code', async (patch, code) => {
    await expect(
      LocalRuntime.completeV2({ ...schema2Request(), ...patch }),
    ).rejects.toMatchObject({ code, message: code });
    expect(mockNativeLocalRuntime.completeV2).not.toHaveBeenCalled();
  });

  test('mirrors native attachment/history limits at their exact boundaries', async () => {
    const reference = schema2Request().visibleHistory[0]?.attachments[0];
    if (reference === undefined) throw new Error('fixture missing');
    const maximum = Array.from({ length: 6 }, (_, index) => ({
      ...reference,
      id: `55555555-5555-4555-8555-55555555555${index}`,
      name: 'n'.repeat(512),
      mime_type: 'm'.repeat(128),
      size: 1,
    }));
    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce(schema2Result());
    await expect(
      LocalRuntime.completeV2({
        ...schema2Request(),
        visibleHistory: [
          { role: 'user', content: '', attachments: maximum },
        ],
      }),
    ).resolves.toEqual(schema2Result());

    const invalidHistories = [
      [
        {
          role: 'user' as const,
          content: 'x',
          attachments: [{ ...reference, size: 0 }],
        },
      ],
      [
        {
          role: 'user' as const,
          content: 'x',
          attachments: [{ ...reference, name: 'n'.repeat(513) }],
        },
      ],
      [
        {
          role: 'user' as const,
          content: 'x',
          attachments: [{ ...reference, mime_type: 'm'.repeat(129) }],
        },
      ],
      [
        {
          role: 'user' as const,
          content: 'x',
          attachments: [...maximum, { ...maximum[0]! }],
        },
      ],
      [
        {
          role: 'user' as const,
          content: 'x',
          attachments: [{ ...reference }, { ...reference }],
        },
      ],
      [{ role: 'user' as const, content: ' \n ', attachments: [] }],
    ];
    mockNativeLocalRuntime.completeV2.mockClear();
    for (const visibleHistory of invalidHistories) {
      await expect(
        LocalRuntime.completeV2({ ...schema2Request(), visibleHistory }),
      ).rejects.toMatchObject({
        code: 'E_COMPLETION_HISTORY',
        message: 'E_COMPLETION_HISTORY',
      });
    }
    expect(mockNativeLocalRuntime.completeV2).not.toHaveBeenCalled();
  });

  test('accepts a 4 MiB transcript and rejects the next UTF-8 byte', async () => {
    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce({
      ...schema2Result(),
      round_index: 6,
    });
    await expect(
      LocalRuntime.completeV2({
        ...schema2Request(),
        roundIndex: 6,
        roundTranscript: transcriptAtFourMiBBoundary(0),
      }),
    ).resolves.toMatchObject({ round_index: 6 });

    mockNativeLocalRuntime.completeV2.mockClear();
    await expect(
      LocalRuntime.completeV2({
        ...schema2Request(),
        roundIndex: 6,
        roundTranscript: transcriptAtFourMiBBoundary(1),
      }),
    ).rejects.toMatchObject({
      code: 'E_COMPLETION_TRANSCRIPT',
      message: 'E_COMPLETION_TRANSCRIPT',
    });
    expect(mockNativeLocalRuntime.completeV2).not.toHaveBeenCalled();
  });

  test('bounds JSON-schema traversal before the serialized byte gate', async () => {
    const requestWithNodes = (nodeValues: number) => ({
      ...schema2Request(),
      tools: [
        {
          type: 'function' as const,
          function: {
            name: 'read_file',
            description: 'bounded nodes',
            parameters: { values: Array.from({ length: nodeValues }, () => null) },
          },
        },
      ],
    });
    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce(schema2Result());
    await expect(
      LocalRuntime.completeV2(requestWithNodes(1022)),
    ).resolves.toEqual(schema2Result());

    mockNativeLocalRuntime.completeV2.mockClear();
    await expect(
      LocalRuntime.completeV2(requestWithNodes(1023)),
    ).rejects.toMatchObject({
      code: 'E_COMPLETION_TOOLS',
      message: 'E_COMPLETION_TOOLS',
    });
    expect(mockNativeLocalRuntime.completeV2).not.toHaveBeenCalled();
  });

  test('mirrors request-wide attachment count and byte budgets', async () => {
    const reference = schema2Request().visibleHistory[0]?.attachments[0];
    if (reference === undefined) throw new Error('fixture missing');
    const messages = (count: number) =>
      Array.from({ length: Math.ceil(count / 6) }, (_, messageIndex) => ({
        role: 'user' as const,
        content: 'x',
        attachments: Array.from(
          {
            length: Math.min(6, count - messageIndex * 6),
          },
          (_attachment, attachmentIndex) => ({
            ...reference,
            id: attachmentFixtureId(messageIndex * 6 + attachmentIndex),
            size: 1,
          }),
        ),
      }));

    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce(schema2Result());
    await expect(
      LocalRuntime.completeV2({
        ...schema2Request(),
        visibleHistory: messages(24),
      }),
    ).resolves.toEqual(schema2Result());
    mockNativeLocalRuntime.completeV2.mockClear();
    await expect(
      LocalRuntime.completeV2({
        ...schema2Request(),
        visibleHistory: messages(25),
      }),
    ).rejects.toMatchObject({
      code: 'E_COMPLETION_HISTORY',
      message: 'E_COMPLETION_HISTORY',
    });
    expect(mockNativeLocalRuntime.completeV2).not.toHaveBeenCalled();

    const byteHistory = (extra: number) => [
      {
        role: 'user' as const,
        content: 'x',
        attachments: [
          {
            ...reference,
            id: attachmentFixtureId(30),
            size: 12 * 1024 * 1024,
          },
        ],
      },
      {
        role: 'user' as const,
        content: 'x',
        attachments: [
          {
            ...reference,
            id: attachmentFixtureId(31),
            size: 12 * 1024 * 1024 + extra,
          },
        ],
      },
    ];
    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce(schema2Result());
    await expect(
      LocalRuntime.completeV2({
        ...schema2Request(),
        visibleHistory: byteHistory(0),
      }),
    ).resolves.toEqual(schema2Result());
    mockNativeLocalRuntime.completeV2.mockClear();
    await expect(
      LocalRuntime.completeV2({
        ...schema2Request(),
        visibleHistory: byteHistory(1),
      }),
    ).rejects.toMatchObject({
      code: 'E_COMPLETION_HISTORY',
      message: 'E_COMPLETION_HISTORY',
    });
    expect(mockNativeLocalRuntime.completeV2).not.toHaveBeenCalled();
  });

  test('rejects images for text models and accepts them for Flash Exp', async () => {
    const reference = schema2Request().visibleHistory[0]?.attachments[0];
    if (reference === undefined) throw new Error('fixture missing');
    const visibleHistory = [
      {
        role: 'user' as const,
        content: '',
        attachments: [{ ...reference, kind: 'image' as const }],
      },
    ];

    await expect(
      LocalRuntime.completeV2({ ...schema2Request(), visibleHistory }),
    ).rejects.toMatchObject({
      code: 'E_COMPLETION_HISTORY',
      message: 'E_COMPLETION_HISTORY',
    });
    expect(mockNativeLocalRuntime.completeV2).not.toHaveBeenCalled();

    const visionResult = {
      ...schema2Result(),
      requested_model: 'deepseek-v4-flash-vision-exp',
      model: 'deepseek-v4-flash-vision-exp',
    };
    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce(visionResult);
    await expect(
      LocalRuntime.completeV2({
        ...schema2Request(),
        model: 'deepseek-v4-flash-vision-exp',
        visibleHistory,
      }),
    ).resolves.toEqual(visionResult);
  });

  test.each([
    [
      'identifier',
      { provider_response_id: 'bad id' },
      'E_COMPLETION_RESULT_IDENTIFIER',
    ],
    [
      'digest',
      { model_input_sha256: 'A'.repeat(64) },
      'E_COMPLETION_RESULT_DIGEST',
    ],
    [
      'enum',
      { finish_reason: 'unknown' },
      'E_COMPLETION_RESULT_ENUM',
    ],
    [
      'type',
      { latency_ms: true },
      'E_COMPLETION_RESULT_TYPE',
    ],
    [
      'correlation',
      { attempt_id: '66666666-6666-4666-8666-666666666666' },
      'E_COMPLETION_RESULT_CORRELATION',
    ],
  ])('rejects invalid result %s with a stable code', async (_, patch, code) => {
    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce({
      ...schema2Result(),
      ...patch,
    });

    await expect(
      LocalRuntime.completeV2(schema2Request()),
    ).rejects.toMatchObject({ code, message: code });
  });

  test.each([
    {
      text: '',
      finish_reason: 'stop',
      tool_calls: [],
    },
    {
      text: 'done',
      finish_reason: 'tool_calls',
      tool_calls: [],
    },
    {
      text: 'done',
      finish_reason: 'stop',
      tool_calls: [{ id: 'call_1', name: 'read_file', arguments: '{}' }],
    },
  ])('rejects an invalid finish/tool/text relation', async patch => {
    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce({
      ...schema2Result(),
      ...patch,
    });
    await expect(
      LocalRuntime.completeV2(schema2Request()),
    ).rejects.toMatchObject({
      code: 'E_COMPLETION_RESULT_RELATION',
      message: 'E_COMPLETION_RESULT_RELATION',
    });
  });

  test('enforces UTF-8 byte bounds and rejects isolated surrogates without platform encoders', async () => {
    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce({
      ...schema2Result(),
      reasoning: '\ud800',
    });
    await expect(
      LocalRuntime.completeV2(schema2Request()),
    ).rejects.toMatchObject({
      code: 'E_COMPLETION_RESULT_BOUNDS',
      message: 'E_COMPLETION_RESULT_BOUNDS',
    });

    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce({
      ...schema2Result(),
      text: '😀'.repeat(65_537),
    });
    await expect(
      LocalRuntime.completeV2(schema2Request()),
    ).rejects.toMatchObject({
      code: 'E_COMPLETION_RESULT_BOUNDS',
      message: 'E_COMPLETION_RESULT_BOUNDS',
    });

    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce({
      ...schema2Result(),
      text: '',
      finish_reason: 'tool_calls',
      tool_calls: [
        { id: 'call_1', name: 'read_file', arguments: 'é'.repeat(16_385) },
      ],
    });
    await expect(
      LocalRuntime.completeV2(schema2Request()),
    ).rejects.toMatchObject({
      code: 'E_COMPLETION_RESULT_BOUNDS',
      message: 'E_COMPLETION_RESULT_BOUNDS',
    });
  });

  test('sanitizes native failures and never leaks unknown native values', async () => {
    mockNativeLocalRuntime.completeV2.mockRejectedValueOnce({
      code: 'E_COMPLETION_BUSY',
      message: 'request-sentinel provider-sentinel',
      cause: 'authorization-sentinel',
    });
    await expect(
      LocalRuntime.completeV2(schema2Request()),
    ).rejects.toMatchObject({
      code: 'E_COMPLETION_BUSY',
      message: 'E_COMPLETION_BUSY',
    });

    mockNativeLocalRuntime.completeV2.mockRejectedValueOnce({
      code: 'UNTRUSTED_NATIVE_CODE',
      message: 'request-sentinel provider-sentinel authorization-sentinel',
    });
    try {
      await LocalRuntime.completeV2(schema2Request());
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'E_COMPLETION_NATIVE',
        message: 'E_COMPLETION_NATIVE',
      });
      expect(JSON.stringify(error)).not.toContain('sentinel');
    }
  });

  test('folds hostile accessors, proxies, and polluted stable errors', async () => {
    const hostileRequest = new Proxy(schema2Request(), {
      has: () => {
        throw new Error('request-proxy-sentinel');
      },
    });
    await expect(LocalRuntime.completeV2(hostileRequest)).rejects.toMatchObject({
      code: 'E_COMPLETION_NATIVE',
      message: 'E_COMPLETION_NATIVE',
    });

    const hostileMessage = {
      role: 'user' as const,
      content: 'placeholder',
      attachments: [],
    };
    Object.defineProperty(hostileMessage, 'content', {
      enumerable: true,
      get: () => {
        throw new Error('history-getter-sentinel');
      },
    });
    await expect(
      LocalRuntime.completeV2({
        ...schema2Request(),
        visibleHistory: [hostileMessage],
      }),
    ).rejects.toMatchObject({
      code: 'E_COMPLETION_HISTORY',
      message: 'E_COMPLETION_HISTORY',
    });

    const hostileResult = new Proxy(schema2Result(), {
      ownKeys: () => {
        throw new Error('result-proxy-sentinel');
      },
    });
    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce(hostileResult);
    await expect(
      LocalRuntime.completeV2(schema2Request()),
    ).rejects.toMatchObject({
      code: 'E_COMPLETION_RESULT_TYPE',
      message: 'E_COMPLETION_RESULT_TYPE',
    });

    const polluted = new CompletionBridgeError('E_COMPLETION_BUSY');
    Object.defineProperty(polluted, 'cause', {
      enumerable: true,
      value: 'polluted-cause-sentinel',
    });
    Object.defineProperty(polluted, 'extra', {
      enumerable: true,
      value: 'polluted-extra-sentinel',
    });
    mockNativeLocalRuntime.completeV2.mockRejectedValueOnce(polluted);
    try {
      await LocalRuntime.completeV2(schema2Request());
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).not.toBe(polluted);
      expect(error).toMatchObject({
        code: 'E_COMPLETION_BUSY',
        message: 'E_COMPLETION_BUSY',
      });
      expect(JSON.stringify(error)).not.toContain('sentinel');
    }

    const pollutedCode = new CompletionBridgeError('E_COMPLETION_BUSY');
    Object.defineProperty(pollutedCode, 'code', {
      enumerable: true,
      value: 'polluted-code-sentinel',
    });
    mockNativeLocalRuntime.completeV2.mockRejectedValueOnce(pollutedCode);
    await expect(
      LocalRuntime.completeV2(schema2Request()),
    ).rejects.toMatchObject({
      code: 'E_COMPLETION_NATIVE',
      message: 'E_COMPLETION_NATIVE',
    });

    const rejectedProxy = new Proxy(
      { code: 'E_COMPLETION_BUSY' },
      {
        getPrototypeOf: () => {
          throw new Error('rejected-proxy-sentinel');
        },
      },
    );
    mockNativeLocalRuntime.completeV2.mockRejectedValueOnce(rejectedProxy);
    await expect(
      LocalRuntime.completeV2(schema2Request()),
    ).rejects.toMatchObject({
      code: 'E_COMPLETION_NATIVE',
      message: 'E_COMPLETION_NATIVE',
    });

    const rejectedGetter: Record<string, unknown> = {};
    Object.defineProperty(rejectedGetter, 'code', {
      enumerable: true,
      get: () => {
        throw new Error('rejected-getter-sentinel');
      },
    });
    mockNativeLocalRuntime.completeV2.mockRejectedValueOnce(rejectedGetter);
    await expect(
      LocalRuntime.completeV2(schema2Request()),
    ).rejects.toMatchObject({
      code: 'E_COMPLETION_NATIVE',
      message: 'E_COMPLETION_NATIVE',
    });
  });

  test('keeps schema1 adapter methods and adds typed round/cancel aliases', async () => {
    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce(schema2Result());
    await DshHarnessAdapter.completeRoundV2(schema2Request());
    expect(mockNativeLocalRuntime.completeV2).toHaveBeenCalledTimes(1);

    mockNativeLocalRuntime.cancelCompletion.mockResolvedValueOnce({
      status: 'cancelled',
    });
    await expect(
      DshHarnessAdapter.cancelRoundV2(ROUND_ID),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(mockNativeLocalRuntime.cancelCompletion).toHaveBeenCalledWith(
      ROUND_ID,
    );

    expect(typeof DshHarnessAdapter.completeV2).toBe('function');
    expect(typeof DshHarnessAdapter.cancel).toBe('function');
  });
});

describe('context-bound completion schema 3 bridge', () => {
  test('projects exact root and context wires then validates receipt metadata', async () => {
    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce(schema3Result());

    const result = await LocalRuntime.completeV2(schema3Request() as never);
    const [json] = mockNativeLocalRuntime.completeV2.mock.calls.at(-1) as [
      string,
    ];
    const wire = JSON.parse(json) as Record<string, unknown>;

    expect(Object.keys(wire).sort()).toEqual(
      [
        'schema_version',
        'harness_id',
        'turn_id',
        'attempt_id',
        'round_id',
        'round_index',
        'model',
        'thinking_mode',
        'visible_history',
        'round_transcript',
        'tools',
        'project_context',
      ].sort(),
    );
    expect(wire.schema_version).toBe(3);
    expect(wire.project_context).toEqual({
      schema_version: 1,
      snapshot_id: SNAPSHOT_ID,
      consent_receipt_id: CONSENT_ID,
      conversation_id: CONVERSATION_ID,
      project_id: PROJECT_ID,
      provider: 'deepseek',
      policy: 'chat-read-v1',
    });
    expect(result).toEqual(schema3Result());
  });

  test('rejects malformed or non-exact context before native dispatch', async () => {
    const base = schema3Request();
    const invalidContexts: unknown[] = [
      null,
      { ...base.projectContext, snapshotId: 'NOT-A-UUID' },
      { ...base.projectContext, consentReceiptId: 'not-a-uuid' },
      {
        ...base.projectContext,
        conversationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      },
      { ...base.projectContext, projectId: 'missing' },
      { ...base.projectContext, provider: 'other' },
      { ...base.projectContext, policy: 'write' },
      { ...base.projectContext, schemaVersion: 2 },
      { ...base.projectContext, raw_context: 'raw-context-sentinel' },
    ];
    for (const projectContext of invalidContexts) {
      await expect(
        LocalRuntime.completeV2({ ...base, projectContext } as never),
      ).rejects.toMatchObject({
        code: 'E_COMPLETION_CONTEXT_INVALID',
        message: 'E_COMPLETION_CONTEXT_INVALID',
      });
    }
    expect(mockNativeLocalRuntime.completeV2).not.toHaveBeenCalled();
  });

  test('leaves the schema2 encoded bytes unchanged', async () => {
    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce(schema2Result());
    await LocalRuntime.completeV2(schema2Request());
    expect(mockNativeLocalRuntime.completeV2).toHaveBeenLastCalledWith(
      JSON.stringify({
        schema_version: 2,
        harness_id: 'dsh',
        turn_id: TURN_ID,
        attempt_id: ATTEMPT_ID,
        round_id: ROUND_ID,
        round_index: 1,
        model: 'deepseek-v4-flash',
        thinking_mode: 'high',
        visible_history: schema2Request().visibleHistory,
        round_transcript: schema2Request().roundTranscript,
        tools: schema2Request().tools,
        project_context: null,
      }),
    );
  });

  test('validates exact receipt keys, types, bounds, and request correlation', async () => {
    const invalidResults: Record<string, unknown>[] = [];
    const missing = schema3Result();
    delete (missing.project_context_receipt as Record<string, unknown>)
      .verified_at;
    invalidResults.push(missing);
    invalidResults.push({
      ...schema3Result(),
      project_context_receipt: {
        ...(schema3Result().project_context_receipt as Record<string, unknown>),
        raw_context: 'raw-context-sentinel',
      },
    });
    for (const patch of [
      { schema_version: 2 },
      { snapshot_id: PROJECT_ID },
      { snapshot_sha256: 'bad' },
      { source_fingerprint: 'bad' },
      { context_bytes: 0 },
      { context_bytes: 256 * 1024 + 1 },
      { context_bytes: -0 },
      { verified_at: 'not-a-time' },
    ]) {
      invalidResults.push({
        ...schema3Result(),
        project_context_receipt: {
          ...(schema3Result().project_context_receipt as Record<string, unknown>),
          ...patch,
        },
      });
    }
    invalidResults.push({ ...schema3Result(), schema_version: 2 });
    invalidResults.push({
      ...schema3Result(),
      project_context_receipt: null,
    });

    for (const invalid of invalidResults) {
      mockNativeLocalRuntime.completeV2.mockResolvedValueOnce(invalid);
      await expect(
        LocalRuntime.completeV2(schema3Request() as never),
      ).rejects.toBeInstanceOf(CompletionBridgeError);
    }
  });

  test('rebuilds known context failures and folds hostile failures to native', async () => {
    const known = [
      'E_COMPLETION_CONTEXT_INVALID',
      'E_PROJECT_NOT_FOUND',
      'E_CONTEXT_CHANGED',
      'E_CONTEXT_SECRET',
      'E_CONTEXT_BUDGET',
      'E_CONTEXT_STORAGE',
      'E_CONTEXT_TIMEOUT',
      'E_CONTEXT_CONSENT_INVALID',
      'E_CONTEXT_INTEGRITY',
      'E_CONTEXT_SNAPSHOT_MISSING',
    ];
    for (const code of known) {
      const nativeError = { code, message: 'raw-context-sentinel' };
      mockNativeLocalRuntime.completeV2.mockRejectedValueOnce(nativeError);
      try {
        await LocalRuntime.completeV2(schema3Request() as never);
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).not.toBe(nativeError);
        expect(error).toMatchObject({ code, message: code });
        expect(JSON.stringify(error)).not.toContain('sentinel');
      }
    }

    const hostile = new Proxy(
      { code: 'E_CONTEXT_CHANGED', raw: 'raw-context-sentinel' },
      { getPrototypeOf: () => { throw new Error('proxy-sentinel'); } },
    );
    mockNativeLocalRuntime.completeV2.mockRejectedValueOnce(hostile);
    await expect(
      LocalRuntime.completeV2(schema3Request() as never),
    ).rejects.toMatchObject({
      code: 'E_COMPLETION_NATIVE',
      message: 'E_COMPLETION_NATIVE',
    });
  });

  test('forwards typed schema3 complete and cancel aliases without raw context', async () => {
    mockNativeLocalRuntime.completeV2.mockResolvedValueOnce(schema3Result());
    const result = await DshHarnessAdapter.completeRoundV3(
      schema3Request() as never,
    );
    expect(result).toEqual(schema3Result());
    const [wireJSON] = mockNativeLocalRuntime.completeV2.mock.calls.at(-1) as [
      string,
    ];
    expect(wireJSON).not.toContain('raw-context-sentinel');
    expect(wireJSON).not.toContain('/private/');

    mockNativeLocalRuntime.cancelCompletion.mockResolvedValueOnce({
      status: 'cancelled',
    });
    await expect(
      DshHarnessAdapter.cancelRoundV3(ROUND_ID),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(mockNativeLocalRuntime.cancelCompletion).toHaveBeenCalledWith(
      ROUND_ID,
    );
    expect(typeof DshHarnessAdapter.completeRoundV2).toBe('function');
    expect(typeof DshHarnessAdapter.completeV2).toBe('function');
  });
});

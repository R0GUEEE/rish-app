const mockNativeLocalRuntime = {
  bootstrap: jest.fn(),
  credentialStatus: jest.fn(),
  presentCredentialPrompt: jest.fn(),
  clearCredential: jest.fn(),
  complete: jest.fn(),
  completeV2: jest.fn(),
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
    ).rejects.toThrow(/completionV2 native method is not linked/);
  } finally {
    mockNativeLocalRuntime.completeV2 = previous;
  }
});

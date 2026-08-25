const mockNativeLocalRuntime = {
  bootstrap: jest.fn(),
  credentialStatus: jest.fn(),
  presentCredentialPrompt: jest.fn(),
  clearCredential: jest.fn(),
  complete: jest.fn(),
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

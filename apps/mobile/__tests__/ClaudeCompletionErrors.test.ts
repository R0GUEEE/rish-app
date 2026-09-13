import { sanitizeCompletionError } from '../src/completion/validation';

test('preserves a known local Claude failure without exposing its message', () => {
  const error = sanitizeCompletionError({
    code: 'E_CLAUDE_OFFICIAL_TEXT_FAILED',
    message: 'private provider response',
  });
  expect(error.code).toBe('E_CLAUDE_OFFICIAL_TEXT_FAILED');
  expect(error.message).not.toContain('private provider response');
});

test('unknown provider codes remain private', () => {
  expect(sanitizeCompletionError({ code: 'E_CLAUDE_PRIVATE_RESPONSE' }).code).toBe('E_COMPLETION_NATIVE');
});

test.each(['E_CLAUDE_OFFICIAL_TEXT_TIMEOUT', 'E_COMPLETION_TIMEOUT'])(
  'normalizes %s to a value-free request timeout', code => {
    const error = sanitizeCompletionError({ code, message: 'private output' });
    expect(error.code).toBe('E_COMPLETION_TIMEOUT');
    expect(error.message).toBe('E_COMPLETION_TIMEOUT');
  },
);

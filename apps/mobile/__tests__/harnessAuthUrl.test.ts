import {validVerificationUrl} from '../src/harnessAuth/url';
test('allows the official Claude authorization-request switch, not callback credentials', () => {
  expect(validVerificationUrl('claude-code', 'https://claude.ai/oauth/authorize?code=true&state=fixture')).toBe(true);
  for (const suffix of ['code=secret', 'code=false', 'code=true&code=true', 'code=true&access_token=secret', 'CODE=true']) {
    expect(validVerificationUrl('claude-code', `https://claude.ai/oauth/authorize?${suffix}`)).toBe(false);
  }
  expect(validVerificationUrl('claude-code', 'https://claude.ai/oauth/callback?code=true')).toBe(false);
  expect(validVerificationUrl('codex', 'https://auth.openai.com/codex/device?code=true')).toBe(false);
});

test('accepts current official Claude CLI authorization path only', () => {
  expect(validVerificationUrl('claude-code', 'https://claude.com/cai/oauth/authorize?code=true&state=fixture')).toBe(true);
  expect(validVerificationUrl('claude-code', 'https://claude.com/cai/oauth/callback?code=true')).toBe(false);
  expect(validVerificationUrl('claude-code', 'https://claude.com/cai/oauth/authorize?code=secret')).toBe(false);
});

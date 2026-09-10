import { NativeModules } from 'react-native';
import { glmCredentialSource, glmSourceProvider, parseGlmAccount, validGlmAuthorizationUrl } from '../src/harnessAuth/glmAccount';
const url = 'https://bigmodel.cn/login?appId=fixture&redirect=https%3A%2F%2Fzcode.z.ai%2Fapi%2Fv1%2Foauth%2Fcli%2Fcallback%2Fbigmodel&state=fixture';
const row = { schema_version: 1, provider: 'bigmodel', status: 'pending', account_label: null, authorize_url: url, expires_at: Date.now() + 60000, error_code: null, mode: null };
test('accepts exact official authorization route and rejects attacker callbacks and duplicate keys', () => {
  expect(validGlmAuthorizationUrl('bigmodel', url)).toBe(true);
  expect(validGlmAuthorizationUrl('zai', url)).toBe(false);
  expect(validGlmAuthorizationUrl('bigmodel', `${url}&state=other`)).toBe(false);
  expect(validGlmAuthorizationUrl('bigmodel', url.replace('zcode.z.ai', 'example.com'))).toBe(false);
  expect(validGlmAuthorizationUrl('bigmodel', url.replace('https:', 'http:'))).toBe(false);
});
test('trial source crosses only the safe status boundary and maps to its login provider', async () => {
  const previous = NativeModules.LocalRuntime;
  const status = {schema_version: 1, source: 'bigmodel_trial', ready: true, error_code: null};
  try {
    NativeModules.LocalRuntime = {glmCredentialSource: jest.fn().mockResolvedValue(status)};
    expect(await glmCredentialSource()).toEqual(status);
    expect(glmSourceProvider('bigmodel_trial')).toBe('bigmodel');
    expect(glmSourceProvider('zai_trial')).toBe('zai');
    expect(glmSourceProvider('api_key')).toBeNull();
    NativeModules.LocalRuntime.glmCredentialSource.mockResolvedValue({...status, credential: 'must-not-cross'});
    expect((await glmCredentialSource()).ready).toBe(false);
  } finally { NativeModules.LocalRuntime = previous; }
});
test('rejects cross-provider, secrets, malformed status and premature plan claims', () => {
  expect(parseGlmAccount(row, 'bigmodel').status).toBe('pending');
  expect(parseGlmAccount(row, 'zai').status).toBe('unavailable');
  expect(parseGlmAccount({ ...row, token: 'not-allowed' }, 'bigmodel').status).toBe('unavailable');
  expect(parseGlmAccount({ ...row, mode: 'coding_plan' }, 'bigmodel').status).toBe('unavailable');
  expect(parseGlmAccount({ ...row, status: 'signed_in', mode: 'account_only', authorize_url: null }, 'bigmodel').mode).toBe('account_only');
});

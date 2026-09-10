import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { GlmAccountCard } from '../src/components/GlmAccountCard';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import { createPreferencesStore } from '../src/preferences';
import * as Auth from '../src/harnessAuth/glmAccount';
jest.mock('../src/harnessAuth/glmAccount', () => ({ ...jest.requireActual('../src/harnessAuth/glmAccount'), glmAccountStatus: jest.fn(), startGlmAccountLogin: jest.fn(), cancelGlmAccountLogin: jest.fn(), logoutGlmAccount: jest.fn(), openGlmAccountAuthorization: jest.fn(), glmCredentialSource: jest.fn(), selectGlmCredentialSource: jest.fn() }));
const signedOut = (provider: Auth.GlmAccountProvider): Auth.GlmAccountStatus => ({ schema_version: 1, provider, status: 'signed_out', account_label: null, authorize_url: null, expires_at: null, error_code: null, mode: null });
beforeEach(() => { jest.clearAllMocks(); (Auth.glmAccountStatus as jest.Mock).mockImplementation(async provider => signedOut(provider)); (Auth.glmCredentialSource as jest.Mock).mockResolvedValue({schema_version: 1, source: 'api_key', ready: true, error_code: null}); });
async function render(onSourceChanged?: () => void) {
  const store = createPreferencesStore(); store.setLocale('zh-CN');
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => { renderer = ReactTestRenderer.create(<AppPresentationProvider store={store}><GlmAccountCard visible onSourceChanged={onSourceChanged} /></AppPresentationProvider>); });
  return renderer;
}
async function press(renderer: ReactTestRenderer.ReactTestRenderer, label: string) {
  await act(async () => { renderer.root.findByProps({ accessibilityLabel: label }).props.onPress(); });
}
test('explicit start and browser opening never claim signed-in or overwrite credentials', async () => {
  const url = 'https://bigmodel.cn/login?appId=fixture&redirect=https%3A%2F%2Fzcode.z.ai%2Fapi%2Fv1%2Foauth%2Fcli%2Fcallback%2Fbigmodel&state=fixture';
  (Auth.startGlmAccountLogin as jest.Mock).mockResolvedValue({ ...signedOut('bigmodel'), status: 'pending', authorize_url: url });
  const open = Auth.openGlmAccountAuthorization as jest.Mock;
  open.mockResolvedValue(undefined);
  const renderer = await render();
  expect(Auth.startGlmAccountLogin).not.toHaveBeenCalled();
  await press(renderer, '登录账号');
  expect(Auth.startGlmAccountLogin).toHaveBeenCalledWith('bigmodel');
  const authButton = renderer.root.findAll(node => node.props.accessibilityRole === 'button').find(node => String(node.props.accessibilityLabel).includes('授权'));
  expect(authButton).toBeDefined();
  await act(async () => { authButton!.props.onPress(); });
  expect(open).toHaveBeenCalledWith('bigmodel');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('账号已登录');
  await act(async () => renderer.unmount());
});
test('failed plan verification exposes the unverified selected source without claiming a manual fallback', async () => {
  (Auth.glmAccountStatus as jest.Mock).mockResolvedValue({...signedOut('bigmodel'), status: 'signed_in', account_label: 'Test', mode: 'account_only'});
  const changed = jest.fn();
  const renderer = await render(changed);
  (Auth.glmCredentialSource as jest.Mock).mockResolvedValue({schema_version: 1, source: 'bigmodel', ready: false, error_code: null});
  (Auth.selectGlmCredentialSource as jest.Mock).mockRejectedValue(new Error('E_ZCODE_PLAN_UNAVAILABLE'));
  await press(renderer, '验证并使用订阅');
  expect(Auth.selectGlmCredentialSource).toHaveBeenCalledWith('bigmodel');
  expect(JSON.stringify(renderer.toJSON())).toContain('使用前请验证套餐');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('已验证 Coding Plan');
  expect(changed).toHaveBeenCalledTimes(1);
  await act(async () => renderer.unmount());
});
test('provider switch ignores a delayed old status and logout remains provider-scoped', async () => {
  let resolveOld!: (value: Auth.GlmAccountStatus) => void;
  (Auth.glmAccountStatus as jest.Mock).mockImplementation(provider => provider === 'bigmodel' ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve({ ...signedOut('zai'), status: 'signed_in', account_label: 'Z.ai account', mode: 'account_only' }));
  (Auth.logoutGlmAccount as jest.Mock).mockResolvedValue(signedOut('zai'));
  const renderer = await render();
  await press(renderer, 'Z.ai');
  await act(async () => resolveOld({ ...signedOut('bigmodel'), status: 'signed_in', account_label: 'Stale BigModel', mode: 'coding_plan' }));
  expect(JSON.stringify(renderer.toJSON())).toContain('Z.ai account');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Stale BigModel');
  const logout = renderer.root.findAll(node => node.props.accessibilityRole === 'button').find(node => String(node.props.accessibilityLabel).includes('退出'));
  expect(logout).toBeDefined();
  await act(async () => logout!.props.onPress());
  expect(Auth.logoutGlmAccount).toHaveBeenCalledWith('zai');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Z.ai account');
  await act(async () => renderer.unmount());
});

test('trial selection is explicit and never claims a paid subscription', async () => {
  (Auth.glmAccountStatus as jest.Mock).mockResolvedValue({ ...signedOut('bigmodel'), status: 'signed_in', account_label: 'Test account', mode: 'account_only' });
  const changed = jest.fn();
  const renderer = await render(changed);
  expect(Auth.selectGlmCredentialSource).not.toHaveBeenCalled();
  (Auth.glmCredentialSource as jest.Mock).mockResolvedValue({schema_version: 1, source: 'bigmodel_trial', ready: true, error_code: null});
  (Auth.selectGlmCredentialSource as jest.Mock).mockResolvedValue({schema_version: 1, source: 'bigmodel_trial', ready: true, error_code: null});
  await press(renderer, '验证并使用体验额度');
  expect(Auth.selectGlmCredentialSource).toHaveBeenCalledWith('bigmodel_trial');
  expect(JSON.stringify(renderer.toJSON())).toContain('体验额度已验证');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('已验证 Coding Plan');
  expect(changed).toHaveBeenCalledTimes(1);
  await act(async () => renderer.unmount());
});

test('failed trial verification retains trial selection without claiming ready', async () => {
  (Auth.glmAccountStatus as jest.Mock).mockResolvedValue({ ...signedOut('bigmodel'), status: 'signed_in', account_label: 'Test account', mode: 'account_only' });
  const renderer = await render();
  (Auth.glmCredentialSource as jest.Mock).mockResolvedValue({schema_version: 1, source: 'bigmodel_trial', ready: false, error_code: null});
  (Auth.selectGlmCredentialSource as jest.Mock).mockRejectedValue({code: 'E_ZCODE_TRIAL_UNAVAILABLE'});
  await press(renderer, '验证并使用体验额度');
  expect(JSON.stringify(renderer.toJSON())).toContain('尚未确认可用的体验额度');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('体验额度已验证');
  expect(Auth.selectGlmCredentialSource).not.toHaveBeenCalledWith('api_key');
  await act(async () => renderer.unmount());
});

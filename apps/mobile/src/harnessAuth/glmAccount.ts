import { NativeModules } from 'react-native';

export type GlmAccountProvider = 'bigmodel' | 'zai';
export type GlmCredentialChoice = 'api_key' | GlmAccountProvider | 'bigmodel_trial' | 'zai_trial';
export function glmSourceProvider(source: GlmCredentialChoice | null): GlmAccountProvider | null {
  return source === 'bigmodel' || source === 'bigmodel_trial' ? 'bigmodel'
    : source === 'zai' || source === 'zai_trial' ? 'zai' : null;
}
export type GlmAccountStatus = {
  schema_version: 1;
  provider: GlmAccountProvider;
  status: 'unavailable' | 'signed_out' | 'starting' | 'pending' | 'signed_in' | 'expired' | 'failed';
  account_label: string | null;
  authorize_url: string | null;
  expires_at: number | null;
  error_code: string | null;
  mode: 'account_only' | 'coding_plan' | null;
};
type Action = 'zcodeAccountStatus' | 'startZcodeAccountLogin' | 'cancelZcodeAccountLogin' | 'logoutZcodeAccount';
type NativeAccount = Partial<Record<Action, (provider: GlmAccountProvider) => Promise<unknown>>>;
export function validGlmAuthorizationUrl(provider: GlmAccountProvider, value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    const bigmodel = provider === 'bigmodel';
    const keys = bigmodel ? ['appId', 'redirect', 'state'] : ['client_id', 'redirect_uri', 'response_type', 'state'];
    const actual = [...url.searchParams.keys()];
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
      url.hostname === (bigmodel ? 'bigmodel.cn' : 'chat.z.ai') &&
      url.pathname === (bigmodel ? '/login' : '/api/oauth/authorize') &&
      actual.length === keys.length && keys.every(key => actual.includes(key) && Boolean(url.searchParams.get(key))) &&
      url.searchParams.get(bigmodel ? 'redirect' : 'redirect_uri') === `https://zcode.z.ai/api/v1/oauth/cli/callback/${provider}` &&
      (bigmodel || url.searchParams.get('response_type') === 'code');
  } catch { return false; }
}
const unavailable = (provider: GlmAccountProvider): GlmAccountStatus => ({
  schema_version: 1, provider, status: 'unavailable', account_label: null,
  authorize_url: null, expires_at: null, error_code: null, mode: null,
});

export function parseGlmAccount(value: unknown, provider: GlmAccountProvider): GlmAccountStatus {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return unavailable(provider);
  const row = value as Record<string, unknown>;
  const keys = ['schema_version', 'provider', 'status', 'account_label', 'authorize_url', 'expires_at', 'error_code', 'mode'];
  if (Object.keys(row).length !== keys.length || !keys.every(key => Object.prototype.hasOwnProperty.call(row, key)) ||
      row.schema_version !== 1 || row.provider !== provider ||
      !['signed_out', 'starting', 'pending', 'signed_in', 'expired', 'failed'].includes(String(row.status)) ||
      !(row.account_label === null || (typeof row.account_label === 'string' && row.account_label.length <= 256)) ||
      !(row.authorize_url === null || validGlmAuthorizationUrl(provider, row.authorize_url)) ||
      !(row.expires_at === null || (typeof row.expires_at === 'number' && Number.isFinite(row.expires_at) && row.expires_at > 0)) ||
      !(row.error_code === null || (typeof row.error_code === 'string' && /^E_[A-Z0-9_]{1,80}$/.test(row.error_code))) ||
      ![null, 'account_only', 'coding_plan'].includes(row.mode as null | string) ||
      (row.status !== 'signed_in' && row.mode !== null) ||
      (row.status === 'signed_in' && row.mode === null)) return unavailable(provider);
  return row as GlmAccountStatus;
}

async function invoke(action: Action, provider: GlmAccountProvider): Promise<GlmAccountStatus> {
  try {
    const native = NativeModules.LocalRuntime as NativeAccount | undefined;
    const fn = native?.[action];
    return typeof fn === 'function' ? parseGlmAccount(await fn.call(native, provider), provider) : unavailable(provider);
  } catch { return { ...unavailable(provider), status: 'failed' }; }
}
export const glmAccountStatus = (provider: GlmAccountProvider) => invoke('zcodeAccountStatus', provider);
export const startGlmAccountLogin = (provider: GlmAccountProvider) => invoke('startZcodeAccountLogin', provider);
export const cancelGlmAccountLogin = (provider: GlmAccountProvider) => invoke('cancelZcodeAccountLogin', provider);
export const logoutGlmAccount = (provider: GlmAccountProvider) => invoke('logoutZcodeAccount', provider);

export async function openGlmAccountAuthorization(provider: GlmAccountProvider): Promise<void> {
  const native = NativeModules.LocalRuntime as {openZcodeAccountAuthorization?: (provider: string) => Promise<unknown>};
  if (!native?.openZcodeAccountAuthorization) throw new Error('E_ZCODE_AUTH_BROWSER');
  await native.openZcodeAccountAuthorization(provider);
}

export type GlmCredentialSource = {
  schema_version: 1;
  source: GlmCredentialChoice | null;
  ready: boolean;
  error_code: string | null;
};
const unavailableSource: GlmCredentialSource = {schema_version: 1, source: null, ready: false, error_code: 'E_ZCODE_PLAN_UNAVAILABLE'};
function parseSource(value: unknown): GlmCredentialSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailableSource;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 4 || row.schema_version !== 1 ||
      ![null, 'api_key', 'bigmodel', 'zai', 'bigmodel_trial', 'zai_trial'].includes(row.source as null | string) ||
      typeof row.ready !== 'boolean' ||
      !(row.error_code === null || (typeof row.error_code === 'string' && /^E_[A-Z0-9_]{1,80}$/.test(row.error_code)))) return unavailableSource;
  return row as GlmCredentialSource;
}
export async function glmCredentialSource(): Promise<GlmCredentialSource> {
  try {
    const native = NativeModules.LocalRuntime as {glmCredentialSource?: () => Promise<unknown>};
    return native?.glmCredentialSource ? parseSource(await native.glmCredentialSource()) : unavailableSource;
  } catch { return unavailableSource; }
}
export async function selectGlmCredentialSource(source: GlmCredentialChoice): Promise<GlmCredentialSource> {
  const native = NativeModules.LocalRuntime as {selectGlmCredentialSource?: (source: string) => Promise<unknown>};
  if (!native?.selectGlmCredentialSource) throw new Error('E_ZCODE_PLAN_UNAVAILABLE');
  return parseSource(await native.selectGlmCredentialSource(source));
}

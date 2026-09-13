import type { HarnessSubscriptionId } from './types';
const HOSTS: Record<HarnessSubscriptionId, ReadonlySet<string>> = { codex: new Set(['auth.openai.com', 'chatgpt.com']), 'claude-code': new Set(['claude.com', 'claude.ai', 'console.anthropic.com', 'platform.claude.com']) };
export function validVerificationUrl(id: HarnessSubscriptionId, value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || (url.port !== '' && url.port !== '443') || url.hash !== '' || !HOSTS[id].has(url.hostname.toLowerCase())) return false;
    const sensitive = new Set(['token', 'access_token', 'refresh_token', 'code', 'user_code', 'id_token']);
    for (const key of Array.from(url.searchParams.keys())) {
      const entry = url.searchParams.get(key);
      // The CLI's authorization-request switch is not an authorization code.
      if (id === 'claude-code' && key === 'code' && entry === 'true' && ((url.hostname === 'claude.ai' && url.pathname === '/oauth/authorize') || (url.hostname === 'claude.com' && url.pathname === '/cai/oauth/authorize')) && url.searchParams.getAll('code').length === 1) continue;
      if (sensitive.has(key.toLowerCase())) return false;
    }
    return true;
  } catch { return false; }
}

import type { HarnessSubscriptionId } from './types';
const HOSTS: Record<HarnessSubscriptionId, ReadonlySet<string>> = { codex: new Set(['auth.openai.com', 'chatgpt.com']), 'claude-code': new Set(['claude.ai', 'console.anthropic.com', 'platform.claude.com']) };
export function validVerificationUrl(id: HarnessSubscriptionId, value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const url = new URL(value); const sensitive = ['token','access_token','refresh_token','code','user_code','id_token']; return url.protocol === 'https:' && url.username === '' && url.password === '' && (url.port === '' || url.port === '443') && url.hash === '' && HOSTS[id].has(url.hostname.toLowerCase()) && !Array.from(url.searchParams.keys()).some(k => sensitive.includes(k.toLowerCase())); } catch { return false; }
}

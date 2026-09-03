import type { ChatStore } from '../state';

/**
 * QA fixture: seeds one conversation containing a GFM table, block math,
 * inline math, and a tap-to-load remote image placeholder. Only reachable
 * when the app is launched with the -DSHSeedMarkdownDemo argument (simctl
 * launch <udid> <bundle> -DSHSeedMarkdownDemo), so production launches are
 * unaffected. Used to capture markdown rendering evidence on the Simulator.
 */

const DOLLAR = String.fromCharCode(36);
const BACKTICK = String.fromCharCode(96);
const BACKSLASH = String.fromCharCode(92);

export const MARKDOWN_DEMO_USER_TEXT =
  'Show me a table, some math, and an image.';

export const MARKDOWN_DEMO_ASSISTANT_TEXT = [
  'Here is a GFM pipe table:',
  '',
  '| Metric | Value | Trend |',
  '| :--- | ---: | :---: |',
  '| latency p50 | **42 ms** | ↓ |',
  '| errors | ' + BACKTICK + '3' + BACKTICK + ' | → |',
  '| uptime | 99.9% | ↑ |',
  '',
  'Block math:',
  '',
  DOLLAR + DOLLAR,
  BACKSLASH + 'sum_{i=1}^{n} i = ' + BACKSLASH + 'frac{n(n+1)}{2}',
  DOLLAR + DOLLAR,
  '',
  'Inline math like ' + DOLLAR + 'x^2' + DOLLAR + ' renders inline, and this remote image stays behind a tap-to-load placeholder:',
  '',
  '![DSH logo](https://example.com/dsh-cover.png)',
].join('\n');

/**
 * Seeds a fresh demo conversation and selects it. The fixture is
 * deterministic: it always creates its own conversation so evidence
 * screenshots are independent of any restored session.
 */
export function seedMarkdownDemoConversation(store: ChatStore): void {
  const conversationId = store.createConversation({ select: true });
  store.appendUserMessage(conversationId, MARKDOWN_DEMO_USER_TEXT);
  store.appendAssistantMessage(conversationId, MARKDOWN_DEMO_ASSISTANT_TEXT);
}

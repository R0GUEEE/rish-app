import { providerFailureDetail, providerFailureMessage } from '../src/components/providerFailureMessage';
import { createTranslator } from '../src/preferences';
import { parseAgentRoundPreviewEvent } from '../src/agent/AgentRoundPreview';

const t = createTranslator('zh-CN');
const failure = (code: string, httpStatus: number | null = null) => ({ attemptId: 'a', code, httpStatus });

// A relay that refuses a key, or answers in another protocol, used to show
// "may have reached the service" (E_AGENT_ROUND_AMBIGUOUS) and nothing else.
test('a provider refusal behind a failed round is said in words', () => {
  expect(providerFailureMessage('E_AGENT_ROUND_AMBIGUOUS', failure('E_COMPLETION_HTTP_STATUS', 401), t)).toContain('HTTP 401');
  expect(providerFailureMessage('E_AGENT_ROUND_AMBIGUOUS', failure('E_COMPLETION_HTTP_STATUS', 401), t)).toContain('密钥');
  expect(providerFailureMessage('E_AGENT_ROUND_AMBIGUOUS', failure('E_COMPLETION_CREDENTIAL_UNAVAILABLE'), t)).toContain('401/403');
  expect(providerFailureMessage('E_AGENT_ROUND_AMBIGUOUS', failure('E_COMPLETION_HTTP_STATUS', 404), t)).toContain('HTTP 404');
  expect(providerFailureMessage('E_AGENT_ROUND_AMBIGUOUS', failure('E_COMPLETION_HTTP_STATUS', 502), t)).toContain('HTTP 502');
  expect(providerFailureMessage('E_AGENT_ROUND_AMBIGUOUS', failure('E_COMPLETION_HTTP_429'), t)).toBe(t('recovery.rateLimit'));
  expect(providerFailureMessage('E_AGENT_TRANSCRIPT', failure('E_COMPLETION_RESPONSE_JSON'), t)).toContain('E_COMPLETION_RESPONSE_JSON');
  expect(providerFailureDetail(failure('E_COMPLETION_HTTP_STATUS', 401))).toBe('provider: E_COMPLETION_HTTP_STATUS HTTP 401');
});

test('nothing more specific, or another kind of failure, adds nothing', () => {
  expect(providerFailureMessage('E_AGENT_ROUND_AMBIGUOUS', failure('E_COMPLETION_TRANSPORT'), t)).toBeNull();
  expect(providerFailureMessage('E_AGENT_ROUND_AMBIGUOUS', null, t)).toBeNull();
  expect(providerFailureMessage('E_AGENT_CANCELLED', failure('E_COMPLETION_HTTP_STATUS', 401), t)).toBeNull();
  expect(providerFailureMessage(null, failure('E_COMPLETION_HTTP_STATUS', 401), t)).toBeNull();
});

test('a preview end carries the status a provider refused with, and only a real one', () => {
  const base = {
    schema_version: 1, kind: 'end', seq: 3, status: 'failed', truncated: false,
    failure_code: 'E_COMPLETION_HTTP_STATUS', task_id: '11111111-1111-4111-8111-111111111111',
    attempt_id: '22222222-2222-4222-8222-222222222222', round_id: '33333333-3333-4333-8333-333333333333',
    round_index: 0, operation_id: '44444444-4444-4444-8444-444444444444',
    provider_request_id: '44444444-4444-4444-8444-444444444444', harness_id: 'codex',
  };
  const parsed = parseAgentRoundPreviewEvent({ ...base, http_status: 401 });
  expect(parsed).toMatchObject({ kind: 'end', failureCode: 'E_COMPLETION_HTTP_STATUS', httpStatus: 401 });
  expect(parseAgentRoundPreviewEvent(base)).not.toHaveProperty('httpStatus');
  expect(parseAgentRoundPreviewEvent({ ...base, http_status: 99 })).toBeNull();
  expect(parseAgentRoundPreviewEvent({ ...base, http_status: '401' })).toBeNull();
});

// A plain chat has no round preview to read a status from; the code alone
// still says whether to look at the relay's address or at its protocol.
test('a plain chat says what the provider answered, in words', () => {
  const { recoveryMessage } = jest.requireActual('../src/components/recoveryMessage');
  expect(recoveryMessage('E_COMPLETION_HTTP_STATUS', t)).toBe(t('recovery.provider.statusUnknown'));
  expect(recoveryMessage('E_COMPLETION_RESPONSE_JSON', t)).toBe(t('recovery.provider.unreadableUnknown'));
  expect(recoveryMessage('E_COMPLETION_RESPONSE_MODEL', t)).toBe(t('recovery.provider.unreadableUnknown'));
  expect(recoveryMessage('E_COMPLETION_CREDENTIAL_UNAVAILABLE', t)).toBe(t('recovery.credential'));
  expect(t('recovery.provider.statusUnknown')).not.toBe(t('recovery.generic'));
});

// A round the provider refused in full ends with a code of its own, which
// the journal keeps: the words are the same after a restart, and a generic
// refusal adds the status while this launch still holds it.
test('a refused round reads in words from its own code', () => {
  const { recoveryMessage } = require('../src/components/recoveryMessage') as typeof import('../src/components/recoveryMessage');
  expect(recoveryMessage('E_AGENT_PROVIDER_CREDENTIAL', t)).toContain('HTTP 401');
  expect(recoveryMessage('E_AGENT_PROVIDER_FORBIDDEN', t)).toContain('HTTP 403');
  expect(recoveryMessage('E_AGENT_PROVIDER_NOT_FOUND', t)).toContain('HTTP 404');
  expect(recoveryMessage('E_AGENT_PROVIDER_RATE_LIMITED', t)).toBe(t('recovery.rateLimit'));
  expect(recoveryMessage('E_AGENT_PROVIDER_REFUSED', t)).toBe(t('recovery.provider.refused'));
  expect(providerFailureMessage('E_AGENT_PROVIDER_REFUSED', failure('E_COMPLETION_HTTP_STATUS', 422), t)).toContain('HTTP 422');
  // The specific codes say it themselves; nothing is layered on top.
  expect(providerFailureMessage('E_AGENT_PROVIDER_CREDENTIAL', failure('E_COMPLETION_CREDENTIAL_UNAVAILABLE', 401), t)).toBeNull();
});

// An answer past what the app keeps arrived whole: it is not one that never
// came, whatever the round's own (ambiguous) code says.
test('an answer too long to keep is said as such', () => {
  expect(providerFailureMessage('E_AGENT_ROUND_AMBIGUOUS', failure('E_COMPLETION_RESPONSE_SIZE'), t)).toBe(t('recovery.provider.tooLong'));
  expect(t('recovery.provider.tooLong')).toContain('拆');
});

// An answer that arrived and could not be recorded is neither lost nor run.
test('an answer that could not be recorded is said as such', () => {
  expect(providerFailureMessage('E_AGENT_ROUND_AMBIGUOUS', failure('E_COMPLETION_ANSWER_UNRECORDED'), t)).toBe(t('recovery.provider.unrecorded'));
});

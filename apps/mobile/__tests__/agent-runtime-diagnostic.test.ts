import {
  agentRuntimeDiagnosticFromError,
  parseAgentRuntimeDiagnostic,
} from '../src/native/agent-runtime-diagnostic';

const marker = 'agent_runtime/v1 operation=complete_agent_round_v2 kind=persistence';

test.each(['persistence', 'unavailable', 'exception', 'unknown'])(
  'accepts fixed %s provenance from the native bridge', kind => {
    const diagnostic = marker.replace('kind=persistence', `kind=${kind}`);
    expect(agentRuntimeDiagnosticFromError({
      code: 'E_AGENT_PERSISTENCE', message: `E_AGENT_PERSISTENCE\n${diagnostic}`,
    })).toBe(diagnostic);
  },
);

test.each([
  `${marker}\n/private/device/path`, `prefix ${marker}`,
  marker.replace('kind=persistence', 'kind=credential-secret'),
  marker.replace('complete_agent_round_v2', 'unknown_operation'),
  marker.replace('/v1 ', '/v2 '),
  `${marker}\n`,
])('rejects raw, appended or unknown native diagnostics: %s', value => {
  expect(parseAgentRuntimeDiagnostic(value)).toBeNull();
  expect(agentRuntimeDiagnosticFromError({
    code: 'E_AGENT_PERSISTENCE', message: `E_AGENT_PERSISTENCE\n${value}`,
  })).toBeNull();
});

test('does not evaluate accessors or accept diagnostics without a stable code', () => {
  const getter = jest.fn(() => marker);
  expect(agentRuntimeDiagnosticFromError(Object.defineProperty(
    { code: 'E_AGENT_PERSISTENCE' }, 'diagnostic', { get: getter },
  ))).toBeNull();
  expect(getter).not.toHaveBeenCalled();
  expect(agentRuntimeDiagnosticFromError({ code: 'not a code', diagnostic: marker })).toBeNull();
  // A message whose first line is not the rejection's own code is not read.
  expect(agentRuntimeDiagnosticFromError({
    code: 'E_AGENT_NATIVE', message: `E_AGENT_CONFLICT\n${marker}`,
  })).toBeNull();
});

// What a native refusal answers with: the operation, whether a rule refused or
// something threw, the class and the app method -- which is what turns a bare
// E_COMPLETION_NATIVE into a place in the code.
test('reads the structured provenance of any native rejection', () => {
  const diagnostic = 'agent_runtime/v1 operation=recover_agent_attempt kind=refused code=E_AGENT_NATIVE cause=Refused site=DSHProviderRoundService.recoverAgentAttempt:212';
  expect(agentRuntimeDiagnosticFromError({
    code: 'E_AGENT_NATIVE', message: `E_AGENT_NATIVE\n${diagnostic}`,
  })).toBe(diagnostic);
  const thrown = 'agent_runtime/v1 operation=complete_agent_round_v2 kind=exception code=E_AGENT_NATIVE cause=NSJSONError site=AgentRuntimeModule.completeAgentRoundV2$1.invoke:431';
  expect(parseAgentRuntimeDiagnostic(thrown)).toBe(thrown);
  // Anything a person wrote cannot ride along.
  expect(parseAgentRuntimeDiagnostic(`${thrown} note=hello`)).toBeNull();
  expect(parseAgentRuntimeDiagnostic(thrown.replace('cause=NSJSONError', 'cause=/data/user/0'))).toBeNull();
});

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

test('does not evaluate accessors or accept diagnostics for a different error', () => {
  const getter = jest.fn(() => marker);
  expect(agentRuntimeDiagnosticFromError(Object.defineProperty(
    { code: 'E_AGENT_PERSISTENCE' }, 'diagnostic', { get: getter },
  ))).toBeNull();
  expect(getter).not.toHaveBeenCalled();
  expect(agentRuntimeDiagnosticFromError({ code: 'E_AGENT_CONFLICT', diagnostic: marker })).toBeNull();
});

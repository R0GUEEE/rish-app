import { agentAmbiguityCode, agentRecoveryAmbiguityCode } from '../src/agent/AgentAmbiguity';

const call = (receipt: { outcome: string } | null, key: string | null, revision: number | null) =>
  ({ receipt, idempotency_key: key, native_row_revision: revision });

// A recovery notice must not soften a tool warning: a tool target, or a call
// whose execution intent was recorded but holds no receipt, may have run.
test('a recovery reads tool uncertainty conservatively', () => {
  const quiet = { phase: 'ambiguous', batch: [call({ outcome: 'ok' }, 'k1', 3)] };
  expect(agentRecoveryAmbiguityCode(quiet, 'round')).toBe('E_AGENT_ROUND_AMBIGUOUS');
  expect(agentRecoveryAmbiguityCode(quiet, 'tool')).toBe('E_AGENT_EXECUTION_AMBIGUOUS');
  const started = { phase: 'ambiguous', batch: [call(null, 'k2', 4)] };
  expect(agentRecoveryAmbiguityCode(started, 'attempt')).toBe('E_AGENT_EXECUTION_AMBIGUOUS');
  // The stored rule is unchanged: persisted attempts are checked against it.
  expect(agentAmbiguityCode(started)).toBe('E_AGENT_ROUND_AMBIGUOUS');
  // A call never assigned to execution did not run.
  expect(agentRecoveryAmbiguityCode({ phase: 'ambiguous', batch: [call(null, null, null)] }, 'round')).toBe('E_AGENT_ROUND_AMBIGUOUS');
  expect(agentRecoveryAmbiguityCode({ phase: 'ambiguous', batch: [call({ outcome: 'ambiguous' }, 'k3', 2)] })).toBe('E_AGENT_EXECUTION_AMBIGUOUS');
});

import {
  withTaskExperience,
  cancelTaskExperienceRun,
} from '../src/taskExperience/controller';
import type {
  CompletionController,
  CompletionControllerOutcome,
  CompletionControllerState,
} from '../src/completion/CompletionController';
jest.mock('../src/taskExperience/bridge', () => ({
  taskExperience: { call: jest.fn() },
}));
function fixture() {
  let listener: (state: CompletionControllerState) => void = () => {};
  let settle!: (value: CompletionControllerOutcome) => void;
  const raw = {
    subscribe: jest.fn(callback => {
      listener = callback;
      return () => {};
    }),
    send: jest.fn(
      () =>
        new Promise<CompletionControllerOutcome>(resolve => {
          settle = resolve;
        }),
    ),
    cancel: jest.fn(async () => {}),
  } as unknown as CompletionController;
  const bridge = {
    call: jest.fn(
      async (_op: string, _payload: Record<string, unknown>) => true,
    ),
  };
  const controller = withTaskExperience(raw, bridge);
  const state = (phase: CompletionControllerState['phase']) =>
    listener({
      phase,
      epoch: 1,
      conversationId: 'conversation',
      attemptId: 'attempt',
      turnId: 'turn',
      roundId: 'round',
      transportSchemaVersion: 3,
      failureCode: null,
    });
  return {
    controller,
    raw,
    bridge,
    state,
    settle: (status: CompletionControllerOutcome['status']) =>
      settle({
        status,
        conversationId: 'conversation',
        attemptId: 'attempt',
        turnId: 'turn',
        code: null,
      }),
  };
}
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const input = {
  conversationId: 'conversation',
  text: 'hello',
  attachments: [],
  harnessId: 'dsh',
} as const;
it('never starts or announces completion from hydrated state', async () => {
  const f = fixture();
  f.state('recovering');
  f.state('resume_available');
  f.state('idle');
  await tick();
  expect(f.bridge.call).not.toHaveBeenCalled();
  expect(f.raw.send).not.toHaveBeenCalled();
});
it('announces success only after the durable operation resolves, never from idle', async () => {
  const f = fixture();
  const pending = f.controller.send(input);
  f.state('preparing');
  f.state('sending');
  f.state('idle');
  await tick();
  expect(f.bridge.call.mock.calls.some(call => call[0] === 'end')).toBe(false);
  f.settle('completed');
  await pending;
  await tick();
  expect(f.bridge.call).toHaveBeenLastCalledWith(
    'end',
    expect.objectContaining({ status: 'completed' }),
  );
});
it.each([
  'cancelled',
  'persistence_pending',
  'commit_pending',
  'retryable',
  'blocked',
] as const)('preserves %s without a success notification', async status => {
  const f = fixture();
  const pending = f.controller.send(input);
  f.state('sending');
  f.settle(status);
  expect((await pending).status).toBe(status);
  await tick();
  expect(f.bridge.call).toHaveBeenLastCalledWith(
    'end',
    expect.objectContaining({ status }),
  );
});
it('ignores stale cancellation and cancels only the matching owner', async () => {
  const f = fixture();
  const pending = f.controller.send(input);
  f.state('sending');
  await tick();
  const runId = f.bridge.call.mock.calls[0][1].runId as string;
  await cancelTaskExperienceRun(f.controller, 'stale');
  expect(f.raw.cancel).not.toHaveBeenCalled();
  await cancelTaskExperienceRun(f.controller, runId);
  expect(f.raw.cancel).toHaveBeenCalledTimes(1);
  f.settle('cancelled');
  await pending;
  await cancelTaskExperienceRun(f.controller, runId);
  expect(f.raw.cancel).toHaveBeenCalledTimes(1);
});
it('does not let a failed display bridge reject a completed task', async () => {
  const f = fixture();
  f.bridge.call.mockRejectedValue(new Error('unavailable'));
  const pending = f.controller.send(input);
  f.state('sending');
  f.settle('completed');
  expect((await pending).status).toBe('completed');
  await tick();
});

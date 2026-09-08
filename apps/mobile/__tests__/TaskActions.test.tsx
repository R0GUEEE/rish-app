import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AppState } from 'react-native';
import { useTaskActions } from '../src/taskExperience/useTaskActions';
import { taskExperience, type TaskEvent } from '../src/taskExperience/bridge';
jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));
jest.mock('../src/taskExperience/bridge', () => ({
  taskExperience: {
    call: jest.fn(async () => []),
    subscribe: jest.fn(() => () => {}),
  },
}));
const event: TaskEvent = {
  action: 'open',
  conversationId: 'conversation',
  runId: 'run',
};
function Harness({
  ready,
  open,
  cancel,
}: {
  ready: boolean;
  open: (id: string) => Promise<boolean>;
  cancel: (id: string) => Promise<void>;
}) {
  useTaskActions('visible', open, cancel, ready);
  return null;
}
beforeEach(() => jest.clearAllMocks());
it('retains a cold-start navigation until hydration/admission is ready and deduplicates delivery', async () => {
  const open = jest.fn(async () => true),
    cancel = jest.fn(async () => {});
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Harness ready={false} open={open} cancel={cancel} />,
    );
  });
  const receive = (taskExperience.subscribe as jest.Mock).mock.calls[0][0];
  await act(async () => receive(event));
  expect(open).not.toHaveBeenCalled();
  await act(async () =>
    renderer.update(<Harness ready open={open} cancel={cancel} />),
  );
  expect(open).toHaveBeenCalledWith('conversation');
  await act(async () => receive(event));
  expect(open).toHaveBeenCalledTimes(1);
  await act(async () => renderer.unmount());
});
it('keeps blocked navigation pending and never converts it into cancellation', async () => {
  const open = jest.fn(async () => false),
    cancel = jest.fn(async () => {});
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Harness ready open={open} cancel={cancel} />,
    );
  });
  const receive = (taskExperience.subscribe as jest.Mock).mock.calls[0][0];
  await act(async () => receive(event));
  open.mockResolvedValue(true);
  await act(async () =>
    renderer.update(<Harness ready={false} open={open} cancel={cancel} />),
  );
  await act(async () =>
    renderer.update(<Harness ready open={open} cancel={cancel} />),
  );
  expect(open).toHaveBeenCalledTimes(2);
  expect(cancel).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});
it('does not claim a conversation is visible when the app is backgrounded', async () => {
  const listener = AppState.addEventListener as jest.Mock;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Harness ready open={async () => true} cancel={async () => {}} />,
    );
  });
  (AppState as any).currentState = 'background';
  await act(async () => listener.mock.calls[0][1]('background'));
  expect(taskExperience.call).toHaveBeenCalledWith('visible', {
    conversationId: null,
  });
  (AppState as any).currentState = 'active';
  await act(async () => renderer.unmount());
});

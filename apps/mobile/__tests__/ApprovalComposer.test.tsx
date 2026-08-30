import React from 'react';
import ReactTestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer as Renderer,
} from 'react-test-renderer';

import { ApprovalComposer } from '../src/components/ApprovalComposer';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import {
  createDefaultPreferences,
  createPreferencesStore,
} from '../src/preferences';
import type { ApprovalRequestSpec } from '../src/agent/AgentApprovals';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

function presentation(children: React.ReactNode) {
  const store = createPreferencesStore({
    initialPreferences: {
      ...createDefaultPreferences(),
      locale: 'en-US',
    },
  });
  return (
    <AppPresentationProvider store={store}>{children}</AppPresentationProvider>
  );
}

const request: ApprovalRequestSpec = {
  approvalId: 'ap-1',
  toolCallId: 'c1',
  toolName: 'write_file',
  argumentsJson: '{"path":"notes.md","content":"hi"}',
  scopes: ['once', 'conversation'],
  expiresAtMs: Date.now() + 120_000,
};

function byTestId(root: ReactTestInstance, testID: string) {
  const node = root.findByProps({ testID });
  if (node === undefined) throw new Error('missing ' + testID);
  return node;
}

async function renderComposer(): Promise<{
  renderer: Renderer;
  onDecide: jest.Mock;
}> {
  const onDecide = jest.fn();
  let renderer: Renderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      presentation(<ApprovalComposer request={request} onDecide={onDecide} />),
    );
  });
  if (renderer === undefined) throw new Error('renderer was not created');
  return { renderer, onDecide };
}

test('shows the tool call, the offered scopes, and allow/deny actions', async () => {
  const { renderer } = await renderComposer();
  const root = renderer.root;
  expect(root.findByProps({ testID: 'approval-composer-card' })).toBeDefined();
  expect(root.findByProps({ testID: 'approval-scope-once' })).toBeDefined();
  expect(root.findByProps({ testID: 'approval-scope-conversation' })).toBeDefined();
  expect(root.findByProps({ testID: 'approval-allow' })).toBeDefined();
  expect(root.findByProps({ testID: 'approval-deny' })).toBeDefined();
  // The gated tool is visible.
  const labels = root.findAllByProps({ children: 'write_file' });
  expect(labels.length).toBeGreaterThan(0);
});

test('allow submits the selected scope (once by default)', async () => {
  const { renderer, onDecide } = await renderComposer();
  const allow = byTestId(renderer.root, 'approval-allow');
  await act(async () => {
    allow.props.onPress();
  });
  expect(onDecide).toHaveBeenCalledWith('ap-1', {
    status: 'approved',
    scope: 'once',
  });
});

test('allow submits the conversation scope after selection', async () => {
  const { renderer, onDecide } = await renderComposer();
  const conversation = byTestId(renderer.root, 'approval-scope-conversation');
  await act(async () => {
    conversation.props.onPress();
  });
  const allow = byTestId(renderer.root, 'approval-allow');
  await act(async () => {
    allow.props.onPress();
  });
  expect(onDecide).toHaveBeenCalledWith('ap-1', {
    status: 'approved',
    scope: 'conversation',
  });
});

test('deny submits a denial and modal dismissal denies too', async () => {
  const { renderer, onDecide } = await renderComposer();
  const deny = byTestId(renderer.root, 'approval-deny');
  await act(async () => {
    deny.props.onPress();
  });
  expect(onDecide).toHaveBeenCalledWith('ap-1', { status: 'denied' });
  const modal = byTestId(renderer.root, 'approval-composer-modal');
  await act(async () => {
    modal.props.onRequestClose();
  });
  expect(onDecide).toHaveBeenCalledTimes(2);
  expect(onDecide).toHaveBeenLastCalledWith('ap-1', { status: 'denied' });
});

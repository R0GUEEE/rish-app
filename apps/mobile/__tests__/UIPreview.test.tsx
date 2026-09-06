jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}) }));
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

import { UIPreview, parseUIPreviewKind } from '../src/preview/UIPreview';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import { createPreferencesStore } from '../src/preferences';

async function render(kind: 'approval-single' | 'approval-batch' | 'policy-panel') {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <AppPresentationProvider store={createPreferencesStore()}>
        <UIPreview kind={kind} />
      </AppPresentationProvider>,
    );
  });
  if (renderer === undefined) throw new Error('renderer was not created');
  return renderer;
}

test('parseUIPreviewKind accepts only the known preview kinds', () => {
  expect(parseUIPreviewKind('approval-single')).toBe('approval-single');
  expect(parseUIPreviewKind('approval-batch')).toBe('approval-batch');
  expect(parseUIPreviewKind('policy-panel')).toBe('policy-panel');
  expect(parseUIPreviewKind('anything-else')).toBeNull();
  expect(parseUIPreviewKind(undefined)).toBeNull();
  expect(parseUIPreviewKind(1)).toBeNull();
});

test('the single approval preview renders the composer with a diff and discards decisions', async () => {
  const renderer = await render('approval-single');
  const root = renderer.root;
  expect(root.findByProps({ testID: 'approval-composer-card' })).toBeDefined();
  expect(root.findByProps({ testID: 'approval-preview-path' }).props.children).toBe('notes/todo.md');
  expect(root.findByProps({ testID: 'approval-diff' })).toBeDefined();
  await act(async () => {
    root.findByProps({ testID: 'approval-allow' }).props.onPress();
  });
  // The decision only updates the caption; no broker or store is involved.
  expect(root.findByProps({ testID: 'ui-preview-caption' }).props.children).toBe(
    'preview-write:approved',
  );
});

test('the batch approval preview renders every item with a single commit', async () => {
  const renderer = await render('approval-batch');
  const root = renderer.root;
  expect(root.findByProps({ testID: 'approval-batch-list' })).toBeDefined();
  expect(root.findByProps({ testID: 'approval-batch-item-0' })).toBeDefined();
  expect(root.findByProps({ testID: 'approval-batch-item-1' })).toBeDefined();
  expect(root.findByProps({ testID: 'approval-batch-commit' })).toBeDefined();
});

test('the policy preview renders capabilities, tool access, budgets, and a grant', async () => {
  const renderer = await render('policy-panel');
  const root = renderer.root;
  expect(root.findByProps({ testID: 'agent-policy-card' })).toBeDefined();
  expect(root.findByProps({ testID: 'agent-policy-workspace' }).props.children).toBe('Release notes');
  expect(root.findByProps({ testID: 'agent-policy-tools' })).toBeDefined();
  expect(root.findByProps({ testID: 'agent-policy-budget' })).toBeDefined();
  expect(
    root.findByProps({ testID: 'agent-policy-revoke-a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1' }),
  ).toBeDefined();
});

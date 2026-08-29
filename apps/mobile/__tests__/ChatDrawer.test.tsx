import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';

import { ChatDrawer } from '../src/components/ChatDrawer';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import {
  createDefaultPreferences,
  createPreferencesStore,
} from '../src/preferences';

const noop = () => undefined;

function renderDrawer(
  conversations: Array<{
    id: string;
    title: string;
    preview: string;
    updatedAt: number;
    messageCount?: number;
  }>,
  activeId: string | null = null,
  pendingProjectCleanup = false,
  onOpenPendingProjectCleanup = noop,
) {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  const store = createPreferencesStore({
    initialPreferences: { ...createDefaultPreferences(), locale: 'en-US' },
  });
  act(() => {
    renderer = ReactTestRenderer.create(
      <AppPresentationProvider store={store}>
        <ChatDrawer
          activeId={activeId}
          conversations={conversations}
          runtimeLabel="verified"
          runtimeStatus="verified"
          covered={false}
          visible
          pendingProjectCleanup={pendingProjectCleanup}
          onClose={noop}
          onDismiss={noop}
          onNewChat={noop}
          onOpenConversationMenu={noop}
          onOpenAccount={noop}
          onOpenFiles={noop}
          onOpenProjects={noop}
          onOpenPendingProjectCleanup={onOpenPendingProjectCleanup}
          onOpenHarnesses={noop}
          onOpenRuntime={noop}
          onOpenSettings={noop}
          onSelect={noop}
        />
      </AppPresentationProvider>,
    );
  });
  if (renderer === undefined) throw new Error('renderer missing');
  return renderer;
}

const NOW = Date.now();

test('empty conversations are not treated as history entries', async () => {
  const renderer = renderDrawer([
    { id: 'empty-1', title: 'New chat', preview: '', updatedAt: NOW - 60_000 },
    {
      id: 'real-1',
      title: 'Real chat',
      preview: 'hello',
      updatedAt: NOW - 120_000,
      messageCount: 2,
    },
    {
      id: 'empty-2',
      title: 'New chat',
      preview: '',
      updatedAt: NOW - 180_000,
      messageCount: 0,
    },
  ]);

  const output = JSON.stringify(renderer.toJSON());
  expect(output).toContain('Open chat Real chat');
  // The header's "Create new chat" button shares the words, so assert on the
  // per-entry accessibility label instead of the bare string.
  expect(output).not.toContain('Open chat New chat');

  // The visible count reflects only real history entries.
  expect(output).toContain('"1"');
});

test('an empty conversation stays hidden even when it is the active one', async () => {
  const renderer = renderDrawer(
    [{ id: 'empty-active', title: 'New chat', preview: '', updatedAt: NOW }],
    'empty-active',
  );

  const output = JSON.stringify(renderer.toJSON());
  expect(output).not.toContain('Open chat New chat');
});

test('conversations without a message count are treated as empty', async () => {
  const renderer = renderDrawer([
    { id: 'legacy', title: 'Legacy entry', preview: 'p', updatedAt: NOW },
  ]);

  const output = JSON.stringify(renderer.toJSON());
  expect(output).not.toContain('Legacy entry');
});

test('shows one value-free 44 point pending cleanup action when requested', async () => {
  const onOpen = jest.fn();
  const renderer = renderDrawer([], null, true, onOpen);
  const action = renderer.root.findByProps({
    accessibilityLabel: 'Pending project cleanup',
  });
  const rawStyle =
    typeof action.props.style === 'function'
      ? action.props.style({ pressed: false })
      : action.props.style;
  const style = Array.isArray(rawStyle)
    ? Object.assign({}, ...rawStyle.filter(Boolean))
    : rawStyle;

  expect(action.props.accessibilityRole).toBe('button');
  expect(style.minHeight ?? style.height).toBeGreaterThanOrEqual(44);
  expect(style.height).toBeUndefined();
  const label = renderer.root
    .findAllByType(Text)
    .find(node => node.props.children === 'Pending project cleanup');
  expect(StyleSheet.flatten(label?.props.style)).toMatchObject({
    flex: 1,
    flexShrink: 1,
  });
  expect(JSON.stringify(renderer.toJSON())).not.toMatch(
    /conversation-target|snapshot|project-[0-9]|\/private\//,
  );
  await act(async () => action.props.onPress());
  expect(onOpen).toHaveBeenCalledTimes(1);
});

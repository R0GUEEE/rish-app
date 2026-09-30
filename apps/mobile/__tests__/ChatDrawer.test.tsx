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
  pinnedIds: readonly string[] = [],
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
          pinnedIds={pinnedIds}
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

/** The heading a section draws, with the count beside it. */
function heading(
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): unknown[] {
  return renderer.root
    .findAllByProps({ testID })
    .flatMap(node => node.findAllByType(Text))
    .map(node => node.props.children);
}

test('a pinned conversation is listed under its own heading, not in recent', async () => {
  const renderer = renderDrawer(
    [
      { id: 'pin-1', title: 'Kept close', preview: 'p', updatedAt: NOW, messageCount: 2 },
      { id: 'recent-1', title: 'Something else', preview: 'q', updatedAt: NOW - 1000, messageCount: 2 },
    ],
    null,
    false,
    noop,
    ['pin-1'],
  );

  expect(heading(renderer, 'drawer-pinned')).toEqual(['PINNED', 1]);
  expect(heading(renderer, 'drawer-recent')).toEqual(['RECENT', 1]);
  const output = JSON.stringify(renderer.toJSON());
  expect(output).toContain('Open chat Kept close');
  expect(output).toContain('Open chat Something else');
});

test('without pins there is no pinned heading at all', async () => {
  const renderer = renderDrawer([
    { id: 'recent-1', title: 'Something else', preview: 'q', updatedAt: NOW, messageCount: 2 },
  ]);

  expect(renderer.root.findAllByProps({ testID: 'drawer-pinned' })).toHaveLength(0);
  expect(heading(renderer, 'drawer-recent')).toEqual(['RECENT', 1]);
});

test('a pin naming a conversation that is gone is not drawn', async () => {
  const renderer = renderDrawer(
    [{ id: 'recent-1', title: 'Something else', preview: 'q', updatedAt: NOW, messageCount: 2 }],
    null,
    false,
    noop,
    ['deleted'],
  );

  expect(renderer.root.findAllByProps({ testID: 'drawer-pinned' })).toHaveLength(0);
  expect(heading(renderer, 'drawer-recent')).toEqual(['RECENT', 1]);
});

test('searching keeps a matching pinned conversation on its shelf', async () => {
  const renderer = renderDrawer(
    [
      { id: 'pin-1', title: 'Kept close', preview: 'p', updatedAt: NOW, messageCount: 2 },
      { id: 'recent-1', title: 'Something else', preview: 'q', updatedAt: NOW, messageCount: 2 },
    ],
    null,
    false,
    noop,
    ['pin-1'],
  );

  const search = renderer.root
    .findAllByProps({ accessibilityLabel: 'Search conversations' })
    .find(node => typeof node.props.onChangeText === 'function');
  if (search === undefined) throw new Error('no search field');
  await act(async () => search.props.onChangeText('kept'));

  expect(heading(renderer, 'drawer-pinned')).toEqual(['PINNED', 1]);
  expect(renderer.root.findAllByProps({ testID: 'drawer-recent' })).toHaveLength(0);
});

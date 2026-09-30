import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer as Renderer,
} from 'react-test-renderer';

import {
  ChatDrawer,
  type ConversationSummary,
} from '../src/components/ChatDrawer';
import { ConversationActionSheet } from '../src/components/ConversationActionSheet';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import {
  createDefaultPreferences,
  createPreferencesStore,
} from '../src/preferences';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

async function render(children: React.ReactNode): Promise<Renderer> {
  const store = createPreferencesStore({
    initialPreferences: { ...createDefaultPreferences(), locale: 'en-US' },
  });
  let renderer: Renderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <AppPresentationProvider store={store}>
        {children}
      </AppPresentationProvider>,
    );
  });
  if (renderer === undefined) throw new Error('renderer was not created');
  return renderer;
}

const summary = (
  id: string,
  title: string,
  updatedAt = 1_700_000_000_000,
): ConversationSummary => ({
  id,
  title,
  preview: `${title} preview`,
  updatedAt,
  messageCount: 2,
});

const conversations: ConversationSummary[] = [
  summary('c1', 'Agent tools'),
  summary('c2', 'Notes'),
  summary('c3', 'Release'),
];

function drawer(
  overrides: Partial<React.ComponentProps<typeof ChatDrawer>> = {},
) {
  return (
    <ChatDrawer
      activeId={null}
      conversations={conversations}
      covered={false}
      docked={false}
      pendingProjectCleanup={false}
      pinnedIds={[]}
      runtimeLabel="local"
      runtimeStatus="verified"
      visible
      onClose={jest.fn()}
      onDismiss={jest.fn()}
      onNewChat={jest.fn()}
      onOpenAccount={jest.fn()}
      onOpenConversationMenu={jest.fn()}
      onOpenFiles={jest.fn()}
      onOpenHarnesses={jest.fn()}
      onOpenPendingProjectCleanup={jest.fn()}
      onOpenProjects={jest.fn()}
      onOpenRuntime={jest.fn()}
      onOpenSettings={jest.fn()}
      onSelect={jest.fn()}
      {...overrides}
    />
  );
}

function headingCounts(root: ReactTestInstance, testID: string): unknown[] {
  return root
    .findAllByProps({ testID })
    .flatMap(node => node.findAllByType(Text))
    .map(node => node.props.children);
}

describe('ChatDrawer sections', () => {
  test('with nothing pinned there is no pinned heading at all', async () => {
    const renderer = await render(drawer());
    expect(
      renderer.root.findAllByProps({ testID: 'drawer-pinned' }),
    ).toHaveLength(0);
    expect(headingCounts(renderer.root, 'drawer-recent')).toEqual([
      'RECENT',
      3,
    ]);
  });

  test('pinned conversations get their own heading and leave the recent list', async () => {
    const renderer = await render(drawer({ pinnedIds: ['c2', 'c3'] }));
    expect(headingCounts(renderer.root, 'drawer-pinned')).toEqual([
      'PINNED',
      2,
    ]);
    expect(headingCounts(renderer.root, 'drawer-recent')).toEqual([
      'RECENT',
      1,
    ]);
  });

  test('a pin naming a conversation that is gone is not drawn', async () => {
    const renderer = await render(drawer({ pinnedIds: ['deleted'] }));
    expect(
      renderer.root.findAllByProps({ testID: 'drawer-pinned' }),
    ).toHaveLength(0);
    expect(headingCounts(renderer.root, 'drawer-recent')).toEqual([
      'RECENT',
      3,
    ]);
  });

  test('searching keeps a matching pinned chat on its shelf', async () => {
    const renderer = await render(drawer({ pinnedIds: ['c2'] }));
    const search = renderer.root
      .findAllByProps({ accessibilityLabel: 'Search conversations' })
      .find(node => typeof node.props.onChangeText === 'function');
    if (search === undefined) throw new Error('no search field');
    await act(async () => {
      search.props.onChangeText('notes');
    });
    expect(headingCounts(renderer.root, 'drawer-pinned')).toEqual([
      'PINNED',
      1,
    ]);
    expect(
      renderer.root.findAllByProps({ testID: 'drawer-recent' }),
    ).toHaveLength(0);
  });
});

describe('ConversationActionSheet pinning', () => {
  const sheet = (
    overrides: Partial<
      React.ComponentProps<typeof ConversationActionSheet>
    > = {},
  ) => (
    <ConversationActionSheet
      title="Notes"
      visible
      onClose={jest.fn()}
      onDelete={jest.fn()}
      onDismiss={jest.fn()}
      onExport={jest.fn()}
      onRename={jest.fn()}
      onTogglePin={jest.fn()}
      pinned={false}
      {...overrides}
    />
  );

  test('an unpinned conversation offers pinning and reports the press', async () => {
    const onTogglePin = jest.fn();
    const renderer = await render(sheet({ onTogglePin }));
    const row = renderer.root.findByProps({
      testID: 'conversation-toggle-pin',
    });
    expect(row.props.accessibilityLabel).toBe('Pin to top');
    expect(row.props.accessibilityState).toEqual({ selected: false });
    await act(async () => {
      row.props.onPress();
    });
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });

  test('a pinned conversation offers the way back off the shelf', async () => {
    const renderer = await render(sheet({ pinned: true }));
    const row = renderer.root.findByProps({
      testID: 'conversation-toggle-pin',
    });
    expect(row.props.accessibilityLabel).toBe('Remove from top');
    expect(row.props.accessibilityState).toEqual({ selected: true });
  });
});

import React from 'react';
import ReactTestRenderer, {
  act,
  type ReactTestRenderer as Renderer,
} from 'react-test-renderer';

import { ConversationActionSheet } from '../src/components/ConversationActionSheet';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import {
  createDefaultPreferences,
  createPreferencesStore,
} from '../src/preferences';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

async function renderSheet(
  overrides: Partial<React.ComponentProps<typeof ConversationActionSheet>> = {},
): Promise<Renderer> {
  const store = createPreferencesStore({
    initialPreferences: { ...createDefaultPreferences(), locale: 'en-US' },
  });
  let renderer: Renderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <AppPresentationProvider store={store}>
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
      </AppPresentationProvider>,
    );
  });
  if (renderer === undefined) throw new Error('renderer was not created');
  return renderer;
}

test('an unpinned conversation offers pinning and reports the press', async () => {
  const onTogglePin = jest.fn();
  const renderer = await renderSheet({ onTogglePin });
  const row = renderer.root.findByProps({ testID: 'conversation-toggle-pin' });

  expect(row.props.accessibilityLabel).toBe('Pin to top');
  expect(row.props.accessibilityState).toEqual({ selected: false });
  await act(async () => row.props.onPress());
  expect(onTogglePin).toHaveBeenCalledTimes(1);
});

test('a pinned conversation offers the way back off the shelf', async () => {
  const renderer = await renderSheet({ pinned: true });
  const row = renderer.root.findByProps({ testID: 'conversation-toggle-pin' });

  expect(row.props.accessibilityLabel).toBe('Remove from top');
  expect(row.props.accessibilityState).toEqual({ selected: true });
  expect(JSON.stringify(renderer.toJSON())).not.toMatch(
    /snapshot|project-[0-9]|\/private\//,
  );
});

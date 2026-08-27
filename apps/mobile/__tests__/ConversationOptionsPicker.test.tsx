import React from 'react';
import { Modal, StyleSheet } from 'react-native';
import ReactTestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer as Renderer,
} from 'react-test-renderer';

import {
  ConversationOptionsPicker,
} from '../src/components/ConversationOptionsPicker';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import {
  createDefaultPreferences,
  createPreferencesStore,
} from '../src/preferences';

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

async function render(children: React.ReactNode): Promise<Renderer> {
  let renderer: Renderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(presentation(children));
  });
  if (renderer === undefined) throw new Error('renderer was not created');
  return renderer;
}

function actionByLabel(root: ReactTestInstance, label: string) {
  const action = root
    .findAllByProps({ accessibilityLabel: label })
    .find(instance => typeof instance.props.onPress === 'function');
  if (action === undefined) throw new Error(`no actionable ${label}`);
  return action;
}

type Harness = {
  renderer: Renderer;
  onClose: jest.Mock;
  onSelectModel: jest.Mock<void, [Parameters<
    typeof ConversationOptionsPicker
  >[0]['model']]>;
  onSelectThinkingMode: jest.Mock<void, [string]>;
};

async function renderPicker(
  overrides?: Partial<React.ComponentProps<typeof ConversationOptionsPicker>>,
): Promise<Harness> {
  const onClose = jest.fn();
  const onSelectModel = jest.fn();
  const onSelectThinkingMode = jest.fn();
  const renderer = await render(
    <ConversationOptionsPicker
      model="deepseek-v4-flash"
      thinkingMode="high"
      visible
      onClose={onClose}
      onSelectModel={onSelectModel}
      onSelectThinkingMode={onSelectThinkingMode}
      {...overrides}
    />,
  );
  return { renderer, onClose, onSelectModel, onSelectThinkingMode };
}

test('presents model and effort together in one compact anchored panel', async () => {
  const { renderer } = await renderPicker();

  const modal = renderer.root.findByType(Modal);
  expect(modal.props.animationType).toBe('fade');
  expect(modal.props.presentationStyle).toBe('overFullScreen');
  expect(modal.props.statusBarTranslucent).toBe(true);
  expect(
    StyleSheet.flatten(
      renderer.root.findByProps({ testID: 'conversation-options-popover' })
        .props.style,
    ).width,
  ).toBe(300);

  expect(actionByLabel(renderer.root, 'Use V4 Pro')).toBeDefined();
  expect(actionByLabel(renderer.root, 'Use Max thinking')).toBeDefined();
});

test('updates the model repeatedly without closing the panel', async () => {
  const harness = await renderPicker();

  await act(async () => {
    actionByLabel(harness.renderer.root, 'Use V4 Pro').props.onPress();
  });
  await act(async () => {
    actionByLabel(
      harness.renderer.root,
      'Use Flash Exp',
    ).props.onPress();
  });

  expect(harness.onSelectModel).toHaveBeenNthCalledWith(
    1,
    'deepseek-v4-pro',
  );
  expect(harness.onSelectModel).toHaveBeenNthCalledWith(
    2,
    'deepseek-v4-flash-vision-exp',
  );
  expect(harness.renderer.root.findByType(Modal).props.visible).toBe(true);
  expect(harness.onClose).not.toHaveBeenCalled();
});

test('updates the effort without closing the panel', async () => {
  const harness = await renderPicker();

  await act(async () => {
    actionByLabel(harness.renderer.root, 'Use Max thinking').props.onPress();
  });
  await act(async () => {
    actionByLabel(harness.renderer.root, 'Use Off thinking').props.onPress();
  });

  expect(harness.onSelectThinkingMode).toHaveBeenNthCalledWith(1, 'max');
  expect(harness.onSelectThinkingMode).toHaveBeenNthCalledWith(2, 'off');
  expect(harness.renderer.root.findByType(Modal).props.visible).toBe(true);
  expect(harness.onClose).not.toHaveBeenCalled();
});

test('closes through the explicit done control and the light scrim', async () => {
  const harness = await renderPicker();

  await act(async () => {
    actionByLabel(harness.renderer.root, 'Done').props.onPress();
  });
  expect(harness.onClose).toHaveBeenCalledTimes(1);

  await act(async () => {
    harness.renderer.root
      .findByProps({ testID: 'conversation-options-backdrop' })
      .props.onPress();
  });
  expect(harness.onClose).toHaveBeenCalledTimes(2);

  await act(async () =>
    harness.renderer.root.findByType(Modal).props.onRequestClose(),
  );
  expect(harness.onClose).toHaveBeenCalledTimes(3);
  expect(harness.onSelectModel).not.toHaveBeenCalled();
  expect(harness.onSelectThinkingMode).not.toHaveBeenCalled();
});

test('reflects controlled selection states from current props', async () => {
  const harness = await renderPicker();

  expect(
    actionByLabel(
      harness.renderer.root,
      'Use V4 Flash',
    ).props.accessibilityState,
  ).toEqual({ checked: true });
  expect(
    actionByLabel(harness.renderer.root, 'Use High thinking').props
      .accessibilityState,
  ).toEqual({ checked: true });
  expect(
    actionByLabel(harness.renderer.root, 'Use V4 Pro').props
      .accessibilityState,
  ).toEqual({ checked: false });
});

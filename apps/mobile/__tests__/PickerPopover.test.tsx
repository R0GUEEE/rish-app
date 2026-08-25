import React from 'react';
import { Modal, StyleSheet } from 'react-native';
import ReactTestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer as Renderer,
} from 'react-test-renderer';

import {
  ModelPicker,
  type SupportedModel,
} from '../src/components/ModelPicker';
import { ThinkingPicker } from '../src/components/ThinkingPicker';
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

test('selects a model and closes the compact anchored popover', async () => {
  const onClose = jest.fn();
  const onSelect = jest.fn<void, [SupportedModel]>();
  const renderer = await render(
    <ModelPicker
      selected="deepseek-v4-flash"
      visible
      onClose={onClose}
      onSelect={onSelect}
    />,
  );

  const modal = renderer.root.findByType(Modal);
  expect(modal.props.animationType).toBe('fade');
  expect(modal.props.presentationStyle).toBe('overFullScreen');
  expect(modal.props.statusBarTranslucent).toBe(true);
  expect(
    StyleSheet.flatten(
      renderer.root.findByProps({ testID: 'model-picker-popover' }).props.style,
    ).width,
  ).toBe(286);
  expect(
    StyleSheet.flatten(
      renderer.root.findByProps({ testID: 'model-picker-anchor' }).props.style,
    ).paddingBottom,
  ).toBe(108);

  await act(async () => {
    actionByLabel(renderer.root, 'Use V4 Pro').props.onPress();
  });

  expect(onSelect).toHaveBeenCalledWith('deepseek-v4-pro');
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('keeps the settings model menu compact above the safe-area edge', async () => {
  const renderer = await render(
    <ModelPicker
      placement="settings"
      selected="deepseek-v4-flash"
      visible
      onClose={jest.fn()}
      onSelect={jest.fn()}
    />,
  );

  const anchorStyle = StyleSheet.flatten(
    renderer.root.findByProps({ testID: 'model-picker-anchor' }).props.style,
  );
  const popoverStyle = StyleSheet.flatten(
    renderer.root.findByProps({ testID: 'model-picker-popover' }).props.style,
  );
  expect(anchorStyle.paddingBottom).toBe(18);
  expect(anchorStyle.paddingHorizontal).toBe(18);
  expect(popoverStyle.width).toBe('auto');
});

test('closes the model popover from its light scrim without selecting', async () => {
  const onClose = jest.fn();
  const onSelect = jest.fn();
  const renderer = await render(
    <ModelPicker
      selected="deepseek-v4-flash"
      visible
      onClose={onClose}
      onSelect={onSelect}
    />,
  );

  await act(async () => {
    renderer.root
      .findByProps({ testID: 'model-picker-backdrop' })
      .props.onPress();
  });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onSelect).not.toHaveBeenCalled();

  await act(async () => {
    renderer.root.findByType(Modal).props.onRequestClose();
  });
  expect(onClose).toHaveBeenCalledTimes(2);
});

test('selects effort and closes its smaller anchored popover', async () => {
  const onClose = jest.fn();
  const onSelect = jest.fn();
  const renderer = await render(
    <ThinkingPicker
      selected="high"
      visible
      onClose={onClose}
      onSelect={onSelect}
    />,
  );

  expect(
    StyleSheet.flatten(
      renderer.root.findByProps({ testID: 'thinking-picker-popover' }).props
        .style,
    ).width,
  ).toBe(230);

  await act(async () => {
    actionByLabel(renderer.root, 'Use Max thinking').props.onPress();
  });

  expect(onSelect).toHaveBeenCalledWith('max');
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('closes the effort popover from its backdrop without selecting', async () => {
  const onClose = jest.fn();
  const onSelect = jest.fn();
  const renderer = await render(
    <ThinkingPicker
      selected="high"
      visible
      onClose={onClose}
      onSelect={onSelect}
    />,
  );

  await act(async () => {
    renderer.root
      .findByProps({ testID: 'thinking-picker-backdrop' })
      .props.onPress();
  });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onSelect).not.toHaveBeenCalled();

  await act(async () => {
    renderer.root.findByType(Modal).props.onRequestClose();
  });
  expect(onClose).toHaveBeenCalledTimes(2);
});

import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Modal, Text } from 'react-native';

import { BottomSheet } from '../src/components/BottomSheet';

test('animates sheet content without the system modal slide transition', async () => {
  const onClose = jest.fn();
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

  await act(async () => {
    renderer = ReactTestRenderer.create(
      <BottomSheet
        closeAccessibilityLabel="Close picker"
        onClose={onClose}
        visible
      >
        <Text>Picker</Text>
      </BottomSheet>,
    );
  });

  const modal = renderer!.root.findByType(Modal);
  expect(modal.props.animationType).toBe('none');
  expect(modal.props.presentationStyle).toBe('overFullScreen');
  expect(modal.props.statusBarTranslucent).toBe(true);

  await act(async () => {
    renderer!.root
      .findByProps({ accessibilityLabel: 'Close picker' })
      .props.onPress();
  });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('reports dismissal once after its internal close animation', async () => {
  const onDismiss = jest.fn();
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

  await act(async () => {
    renderer = ReactTestRenderer.create(
      <BottomSheet
        closeAccessibilityLabel="Close picker"
        onClose={() => undefined}
        onDismiss={onDismiss}
        visible
      >
        <Text>Picker</Text>
      </BottomSheet>,
    );
  });
  await act(async () => {
    renderer!.update(
      <BottomSheet
        closeAccessibilityLabel="Close picker"
        onClose={() => undefined}
        onDismiss={onDismiss}
        visible={false}
      >
        <Text>Picker</Text>
      </BottomSheet>,
    );
  });

  expect(onDismiss).toHaveBeenCalledTimes(1);
});

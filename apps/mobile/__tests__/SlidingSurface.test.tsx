import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Modal, Text } from 'react-native';

import { SlidingSurface } from '../src/components/SlidingSurface';

test('keeps navigation transitions out of React Native Modal', async () => {
  const onDismiss = jest.fn();
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

  await act(async () => {
    renderer = ReactTestRenderer.create(
      <SlidingSurface
        closeAccessibilityLabel="Close surface"
        onClose={() => undefined}
        onDismiss={onDismiss}
        visible={false}
      >
        <Text>Settings surface</Text>
      </SlidingSurface>,
    );
  });

  expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
  expect(
    renderer!.root.findAllByProps({ children: 'Settings surface' }),
  ).toHaveLength(0);

  await act(async () => {
    renderer!.update(
      <SlidingSurface
        closeAccessibilityLabel="Close surface"
        onClose={() => undefined}
        onDismiss={onDismiss}
        visible
      >
        <Text>Settings surface</Text>
      </SlidingSurface>,
    );
  });
  expect(
    renderer!.root.findByProps({ children: 'Settings surface' }),
  ).toBeDefined();

  await act(async () => {
    renderer!.update(
      <SlidingSurface
        closeAccessibilityLabel="Close surface"
        onClose={() => undefined}
        onDismiss={onDismiss}
        visible={false}
      >
        <Text>Settings surface</Text>
      </SlidingSurface>,
    );
  });
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

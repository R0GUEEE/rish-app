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

test('emits one presentation-complete event only after every open transition', async () => {
  const onPresented = jest.fn();
  const onDismiss = jest.fn();
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  const surface = (visible: boolean) => (
    <SlidingSurface
      closeAccessibilityLabel="Close surface"
      onClose={() => undefined}
      onDismiss={onDismiss}
      onPresented={onPresented}
      visible={visible}
    >
      <Text>Context surface</Text>
    </SlidingSurface>
  );

  await act(async () => {
    renderer = ReactTestRenderer.create(surface(true));
    expect(onPresented).not.toHaveBeenCalled();
  });
  expect(onPresented).toHaveBeenCalledTimes(1);

  await act(async () => {
    renderer!.update(surface(true));
  });
  expect(onPresented).toHaveBeenCalledTimes(1);

  await act(async () => {
    renderer!.update(surface(false));
  });
  expect(onDismiss).toHaveBeenCalledTimes(1);
  expect(onPresented).toHaveBeenCalledTimes(1);

  await act(async () => {
    renderer!.update(surface(true));
    expect(onPresented).toHaveBeenCalledTimes(1);
  });
  expect(onPresented).toHaveBeenCalledTimes(2);

  await act(async () => {
    renderer!.update(surface(false));
  });
  expect(onDismiss).toHaveBeenCalledTimes(2);
  expect(onPresented).toHaveBeenCalledTimes(2);
});

test('keeps a docked surface mounted when visible is false', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <SlidingSurface
        closeAccessibilityLabel="Close navigation"
        docked
        onClose={() => undefined}
        visible={false}
        maxWidth={296}
      >
        <Text>Docked navigation</Text>
      </SlidingSurface>,
    );
  });
  expect(renderer!.root.findByProps({ children: 'Docked navigation' })).toBeDefined();
  expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
});

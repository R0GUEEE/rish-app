const mockScroll = jest.fn();
const mockListeners = new Map<string, () => void>();
jest.mock('react-native', () => {
  const React = require('react');
  const native = jest.requireActual('react-native');
  return {
    Platform: native.Platform,
    StyleSheet: native.StyleSheet,
    Keyboard: {
      isVisible: () => false,
      addListener: (name: string, listener: () => void) => {
        mockListeners.set(name, listener);
        return { remove: () => mockListeners.delete(name) };
      },
    },
    KeyboardAvoidingView: (props: unknown) =>
      React.createElement('KeyboardAvoidingView', props),
    ScrollView: React.forwardRef((props: unknown, ref: unknown) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd: mockScroll }));
      return React.createElement('ScrollView', props);
    }),
  };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 20, bottom: 0, left: 0, right: 0 }),
}));
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ComposerViewport } from '../src/components/ComposerViewport';

beforeEach(() => {
  jest.useFakeTimers();
  mockScroll.mockClear();
  mockListeners.clear();
});
afterEach(() => jest.useRealTimers());

test('reveals actions when keyboard appears and denial hints grow, then cancels pending work on close', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ComposerViewport />);
  });
  const scroller = renderer.root.findByProps({
    testID: 'composer-dialog-scroll',
  });
  await act(async () => {
    mockListeners.get('keyboardDidShow')!();
    jest.runOnlyPendingTimers();
  });
  expect(mockScroll).toHaveBeenCalledWith({ animated: false });
  mockScroll.mockClear();
  await act(async () => {
    scroller.props.onContentSizeChange(320, 1800);
    jest.runOnlyPendingTimers();
  });
  expect(mockScroll).toHaveBeenCalledTimes(1);
  mockScroll.mockClear();
  await act(async () => {
    mockListeners.get('keyboardDidHide')!();
    scroller.props.onLayout();
    jest.runOnlyPendingTimers();
  });
  expect(mockScroll).not.toHaveBeenCalled();
  await act(async () => {
    mockListeners.get('keyboardDidShow')!();
    renderer.unmount();
  });
  jest.runOnlyPendingTimers();
  expect(mockScroll).not.toHaveBeenCalled();
  expect(mockListeners.size).toBe(0);
});

test('a batch does not jump away from an earlier focused input to its final item', async () => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<ComposerViewport revealEndOnKeyboard={false} />);
  });
  await act(async () => {
    mockListeners.get('keyboardDidShow')!();
    jest.runOnlyPendingTimers();
  });
  expect(mockScroll).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});

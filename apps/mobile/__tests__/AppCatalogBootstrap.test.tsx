import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import App from '../App';
import { DshModelCatalog } from '../src/models/native';

jest.mock('../src/models/native', () => ({
  DshModelCatalog: {
    isAvailable: jest.fn(() => false),
    refresh: jest.fn(),
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: React.PropsWithChildren) => children,
}));
jest.mock('../src/screens/HomeScreen', () => ({
  HomeScreen: () => {
    const { Text } = jest.requireActual('react-native');
    return <Text testID="session-bootstrap-ready">Session bootstrap</Text>;
  },
}));

const refresh = DshModelCatalog.refresh as jest.MockedFunction<
  typeof DshModelCatalog.refresh
>;
let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  jest.clearAllMocks();
});

test('waits for catalog refresh before session bootstrap when initial availability is false', async () => {
  let finishRefresh!: () => void;
  refresh.mockReturnValue(
    new Promise<void>(resolve => {
      finishRefresh = resolve;
    }),
  );
  await act(async () => {
    renderer = create(<App />);
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(
    renderer!.root.findAllByProps({ testID: 'session-bootstrap-ready' }),
  ).toHaveLength(0);

  await act(async () => finishRefresh());
  expect(
    renderer!.root.findAllByProps({ testID: 'session-bootstrap-ready' }),
  ).not.toHaveLength(0);
});

test('keeps session bootstrap blocked when catalog loading fails', async () => {
  refresh.mockRejectedValue(new Error('E_MODEL_CATALOG'));
  await act(async () => {
    renderer = create(<App />);
  });
  expect(
    renderer!.root.findAllByProps({ testID: 'session-bootstrap-ready' }),
  ).toHaveLength(0);
});

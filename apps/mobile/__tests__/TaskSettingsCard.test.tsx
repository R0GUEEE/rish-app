import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Switch } from 'react-native';
import { TaskSettingsCard } from '../src/components/TaskSettingsCard';
import {
  taskExperience,
  defaultTaskPreferences,
} from '../src/taskExperience/bridge';
jest.mock('../src/presentation/AppPresentation', () => ({
  useAppPresentation: () => ({
    locale: 'en-US',
    colors: { line: '#333', text: '#fff', muted: '#999', accent: '#0f0' },
  }),
}));
jest.mock('../src/taskExperience/bridge', () => ({
  defaultTaskPreferences: {
    completed: false,
    failed: false,
    attention: false,
    liveActivity: true,
    background: false,
    muted: [],
  },
  taskExperience: { available: () => true, call: jest.fn() },
}));
beforeEach(() => {
  jest.clearAllMocks();
  (taskExperience.call as jest.Mock).mockImplementation(
    async (_op, payload) => ({
      available: true,
      notifications: 'notDetermined',
      liveActivitiesAvailable: true,
      backgroundAvailable: true,
      preferences: payload?.preferences ?? { ...defaultTaskPreferences },
    }),
  );
});
it('never requests notification permission just by opening settings', async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <TaskSettingsCard conversationId="conversation" />,
    );
  });
  expect(taskExperience.call).toHaveBeenCalledWith('settings');
  expect(
    (taskExperience.call as jest.Mock).mock.calls.some(
      call => call[0] === 'permission',
    ),
  ).toBe(false);
  await act(async () => renderer.unmount());
});
it('requests permission only on an explicit alert opt-in and persists that choice', async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<TaskSettingsCard />);
  });
  const completed = renderer.root
    .findAllByType(Switch)
    .find(node => node.props.accessibilityLabel === 'Task completed')!;
  await act(async () => completed.props.onValueChange(true));
  expect(taskExperience.call).toHaveBeenCalledWith('permission');
  expect(taskExperience.call).toHaveBeenCalledWith('preferences', {
    preferences: expect.objectContaining({ completed: true }),
  });
  await act(async () => renderer.unmount());
});
it('persists per-conversation mute without requesting permission', async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <TaskSettingsCard conversationId="conversation" />,
    );
  });
  const mute = renderer.root
    .findAllByType(Switch)
    .find(node => node.props.accessibilityLabel === 'Mute this conversation')!;
  await act(async () => mute.props.onValueChange(true));
  expect(taskExperience.call).toHaveBeenCalledWith('preferences', {
    preferences: expect.objectContaining({ muted: ['conversation'] }),
  });
  expect(
    (taskExperience.call as jest.Mock).mock.calls.some(
      call => call[0] === 'permission',
    ),
  ).toBe(false);
  await act(async () => renderer.unmount());
});

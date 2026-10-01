import React from 'react';
import ReactTestRenderer, {
  act,
  type ReactTestRenderer as Renderer,
} from 'react-test-renderer';

import { PluginManagerSheet } from '../src/components/PluginManagerSheet';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import {
  createDefaultPreferences,
  createPreferencesStore,
} from '../src/preferences';
import type { Plugin, PluginToolPosture } from '../src/plugins/plugins';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const plugin = (overrides: Partial<Plugin> = {}): Plugin => ({
  id: 'sample',
  name: 'Sample',
  version: '1.0.0',
  description: 'A sample plugin.',
  enabled: true,
  tools: [
    {
      name: 'deploy',
      description: 'Deploy the workspace.',
      capability: 'guest_service',
      requiresApproval: true,
    },
  ],
  ...overrides,
});

async function renderSheet(
  overrides: Partial<React.ComponentProps<typeof PluginManagerSheet>> = {},
): Promise<Renderer> {
  const store = createPreferencesStore({
    initialPreferences: { ...createDefaultPreferences(), locale: 'en-US' },
  });
  let renderer: Renderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <AppPresentationProvider store={store}>
        <PluginManagerSheet
          visible
          plugins={[]}
          posture={'awaiting_native' as PluginToolPosture}
          onClose={jest.fn()}
          onAddPlugin={jest.fn()}
          onEditPlugin={jest.fn()}
          onOpenMarketplace={jest.fn()}
          onRemove={jest.fn()}
          onToggle={jest.fn()}
          {...overrides}
        />
      </AppPresentationProvider>,
    );
  });
  if (renderer === undefined) throw new Error('renderer was not created');
  return renderer;
}

test('an empty manager says so rather than showing nothing', async () => {
  const renderer = await renderSheet();
  const output = JSON.stringify(renderer.toJSON());
  expect(output).toContain('No plugins yet.');
  expect(renderer.root.findAllByProps({ testID: 'plugin-row-sample' })).toHaveLength(
    0,
  );
});

test('a plugin shows its tools under the names the provider would see, and says when a call asks first', async () => {
  const renderer = await renderSheet({ plugins: [plugin()] });
  const output = JSON.stringify(renderer.toJSON());

  expect(output).toContain('sample__deploy');
  expect(output).toContain('guest services');
  expect(output).toContain('asks first');
  expect(output).toContain('Sample');
  expect(output).toContain('1.0.0');
});

test('the switch reports the value it was moved to, not the one it had', async () => {
  const onToggle = jest.fn();
  const renderer = await renderSheet({ plugins: [plugin()], onToggle });
  const toggle = renderer.root.findByProps({ testID: 'plugin-toggle-sample' });

  expect(toggle.props.value).toBe(true);
  await act(async () => toggle.props.onValueChange(false));
  expect(onToggle).toHaveBeenCalledWith('sample', false);
});

test('removing names the plugin it would remove', async () => {
  const onRemove = jest.fn();
  const renderer = await renderSheet({ plugins: [plugin()], onRemove });
  const row = renderer.root.findByProps({ testID: 'plugin-remove-sample' });

  expect(row.props.accessibilityLabel).toBe('Remove plugin Sample');
  await act(async () => row.props.onPress());
  expect(onRemove).toHaveBeenCalledWith('sample');
});

test('the posture line says whether the Agent can be told about these tools', async () => {
  const awaiting = await renderSheet({ posture: 'awaiting_native' });
  expect(
    awaiting.root.findByProps({ testID: 'plugin-posture' }).props.children,
  ).toContain('not offered yet');

  const admitted = await renderSheet({ posture: 'admitted' });
  expect(
    admitted.root.findByProps({ testID: 'plugin-posture' }).props.children,
  ).toContain('offered to the Agent');

  const unknown = await renderSheet({ posture: 'unknown' });
  expect(
    unknown.root.findByProps({ testID: 'plugin-posture' }).props.children,
  ).toContain('has not been read yet');
});

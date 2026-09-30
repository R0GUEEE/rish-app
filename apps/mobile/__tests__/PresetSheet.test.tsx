import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

import { PresetSheet } from '../src/components/PresetSheet';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import { createDefaultPreferences, createPreferencesStore } from '../src/preferences';
import type { AgentPreset } from '../src/presets/presets';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const preset = (overrides: Partial<AgentPreset> = {}): AgentPreset => ({
  id: 'p1',
  name: 'Careful',
  modelId: 'deepseek-v4-pro',
  thinkingMode: 'max',
  toolPermission: 'read-only',
  ...overrides,
});

const current = {
  modelId: 'deepseek-v4-flash',
  thinkingMode: 'high' as const,
  toolPermission: 'workspace-write' as const,
};

function render(overrides: Partial<React.ComponentProps<typeof PresetSheet>> = {}) {
  const handlers = {
    onApply: jest.fn(),
    onDelete: jest.fn(),
    onSaveCurrent: jest.fn(),
    onClose: jest.fn(),
  };
  const store = createPreferencesStore({
    initialPreferences: { ...createDefaultPreferences(), locale: 'en-US' },
  });
  const props = {
    visible: true,
    presets: [] as readonly AgentPreset[],
    current,
    ...handlers,
    ...overrides,
  };
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <AppPresentationProvider store={store}>
        <PresetSheet {...props} />
      </AppPresentationProvider>,
    );
  });
  return { renderer, ...handlers };
}

const byId = (renderer: ReactTestRenderer.ReactTestRenderer, testID: string) =>
  renderer.root.findAllByProps({ testID })[0];

describe('PresetSheet', () => {
  test('says so when there is nothing saved yet', () => {
    const { renderer } = render();
    const text = renderer.root.findAll(
      node =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('No presets yet'),
    );
    expect(text.length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ testID: 'preset-apply-p1' })).toHaveLength(0);
  });

  test('shows what each preset would change', () => {
    const { renderer } = render({ presets: [preset()] });
    expect(renderer.root.findAllByProps({ children: 'Careful' }).length).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({
        children: 'deepseek-v4-pro · max · read-only',
      }).length,
    ).toBeGreaterThan(0);
  });

  test('applying names the preset that was pressed', () => {
    const { renderer, onApply } = render({
      presets: [preset({ id: 'a' }), preset({ id: 'b', name: 'Fast' })],
    });
    act(() => {
      byId(renderer, 'preset-apply-b').props.onPress();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0].id).toBe('b');
  });

  test('deleting names the preset that was pressed', () => {
    const { renderer, onDelete } = render({ presets: [preset({ id: 'a' })] });
    act(() => {
      byId(renderer, 'preset-delete-a').props.onPress();
    });
    expect(onDelete).toHaveBeenCalledWith('a');
  });

  test('refuses to save a blank name, and trims one that is given', () => {
    const { renderer, onSaveCurrent } = render();
    expect(byId(renderer, 'preset-save').props.disabled).toBe(true);
    act(() => {
      byId(renderer, 'preset-name').props.onChangeText('   ');
    });
    expect(byId(renderer, 'preset-save').props.disabled).toBe(true);
    act(() => {
      byId(renderer, 'preset-name').props.onChangeText('  Tight scope  ');
    });
    expect(byId(renderer, 'preset-save').props.disabled).toBe(false);
    act(() => {
      byId(renderer, 'preset-save').props.onPress();
    });
    expect(onSaveCurrent).toHaveBeenCalledWith('Tight scope');
  });

  test('clears the typed name after saving it', () => {
    const { renderer } = render();
    act(() => {
      byId(renderer, 'preset-name').props.onChangeText('Scope');
    });
    act(() => {
      byId(renderer, 'preset-save').props.onPress();
    });
    expect(byId(renderer, 'preset-name').props.value).toBe('');
  });

  test('a name longer than the bound cannot be saved', () => {
    const { renderer } = render();
    act(() => {
      byId(renderer, 'preset-name').props.onChangeText('x'.repeat(61));
    });
    expect(byId(renderer, 'preset-save').props.disabled).toBe(true);
  });

  test('forgets the half-typed name and the applied tick when it closes', () => {
    const store = createPreferencesStore({
      initialPreferences: { ...createDefaultPreferences(), locale: 'en-US' },
    });
    const renderer = (visible: boolean) => (
      <AppPresentationProvider store={store}>
        <PresetSheet
          current={current}
          onApply={jest.fn()}
          onClose={jest.fn()}
          onDelete={jest.fn()}
          onSaveCurrent={jest.fn()}
          presets={[preset()]}
          visible={visible}
        />
      </AppPresentationProvider>
    );
    let tree!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      tree = ReactTestRenderer.create(renderer(true));
    });
    act(() => {
      byId(tree, 'preset-name').props.onChangeText('Half typed');
    });
    act(() => {
      tree.update(renderer(false));
    });
    act(() => {
      tree.update(renderer(true));
    });
    expect(byId(tree, 'preset-name').props.value).toBe('');
  });
});

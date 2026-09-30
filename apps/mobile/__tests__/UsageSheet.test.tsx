import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

import { UsageSheet } from '../src/components/UsageSheet';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import { createDefaultPreferences, createPreferencesStore } from '../src/preferences';
import type { UsageConversation } from '../src/usage/contextUsage';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const contextConversation = (
  id: string,
  manifest: Record<string, unknown>,
): UsageConversation => ({
  id,
  title: `Chat ${id}`,
  projectContext: { status: 'ready', manifest },
});

function render(conversations: readonly UsageConversation[]) {
  const store = createPreferencesStore({
    initialPreferences: { ...createDefaultPreferences(), locale: 'en-US' },
  });
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <AppPresentationProvider store={store}>
        <UsageSheet
          conversations={conversations}
          onClose={() => undefined}
          visible
        />
      </AppPresentationProvider>,
    );
  });
  return renderer;
}

const byId = (renderer: ReactTestRenderer.ReactTestRenderer, testID: string) =>
  renderer.root.findAllByProps({ testID })[0];

const texts = (renderer: ReactTestRenderer.ReactTestRenderer): string[] =>
  renderer.root
    .findAll(node => typeof node.props.children === 'string')
    .map(node => node.props.children as string);

describe('UsageSheet', () => {
  test('says so when nothing has attached context', () => {
    const renderer = render([
      { id: 'a', title: 'Plain chat', projectContext: null },
    ]);
    expect(texts(renderer).join('\n')).toContain(
      'No conversation has attached project context yet.',
    );
    expect(renderer.root.findAllByProps({ testID: 'usage-total-tokens' })).toHaveLength(0);
  });

  test('states plainly what is not recorded', () => {
    const renderer = render([contextConversation('a', { context_bytes: 4, estimated_tokens: 1 })]);
    expect(texts(renderer).join('\n')).toContain(
      'does not record model tokens or cost',
    );
  });

  test('totals the estimates it does have', () => {
    const renderer = render([
      contextConversation('a', {
        project_name: 'one',
        context_bytes: 4000,
        estimated_tokens: 1000,
        included: [{ path: 'a' }, { path: 'b' }],
      }),
      contextConversation('b', {
        project_name: 'two',
        context_bytes: 8000,
        estimated_tokens: 2000,
        included: [{ path: 'c' }],
      }),
    ]);
    // 3000 tokens renders with a separator.
    expect(byId(renderer, 'usage-total-tokens').props.children).toBe('3,000');
    expect(texts(renderer).join('\n')).toContain('3.9 KB');
  });

  test('lists one row per contributing conversation', () => {
    const renderer = render([
      contextConversation('a', { project_name: 'one', context_bytes: 400, estimated_tokens: 100 }),
      contextConversation('b', { project_name: 'two', context_bytes: 400, estimated_tokens: 100 }),
      { id: 'c', title: 'No context', projectContext: null },
    ]);
    // React Native forwards a testID to more than one host node, so a row is
    // present when anything matches and absent when nothing does.
    expect(renderer.root.findAllByProps({ testID: 'usage-row-a' }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ testID: 'usage-row-b' }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ testID: 'usage-row-c' })).toHaveLength(0);
    expect(texts(renderer).join('\n')).toContain('~100');
  });

  test('mentions omitted files only when something was omitted', () => {
    const withOmissions = render([
      contextConversation('a', {
        project_name: 'one',
        context_bytes: 400,
        estimated_tokens: 100,
        included: [{ path: 'a' }],
        omitted: [{ path: 'b' }, { path: 'c' }],
      }),
    ]);
    expect(texts(withOmissions).join('\n')).toContain('(+2)');

    const without = render([
      contextConversation('a', {
        project_name: 'one',
        context_bytes: 400,
        estimated_tokens: 100,
        included: [{ path: 'a' }],
        omitted: [],
      }),
    ]);
    expect(texts(without).join('\n')).not.toContain('(+');
  });

  test('a conversation with no readable snapshot is not counted', () => {
    const renderer = render([
      { id: 'a', title: 'Pending', projectContext: { status: 'pending', manifest: { context_bytes: 400 } } },
    ]);
    expect(texts(renderer).join('\n')).toContain(
      'No conversation has attached project context yet.',
    );
  });
});

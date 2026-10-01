import React from 'react';
import ReactTestRenderer, {
  act,
  type ReactTestRenderer as Renderer,
} from 'react-test-renderer';

import { MarketplaceSheet } from '../src/components/MarketplaceSheet';
import { SkillManagerSheet } from '../src/components/SkillManagerSheet';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import {
  createDefaultPreferences,
  createPreferencesStore,
} from '../src/preferences';
import { BUILTIN_MARKETPLACE } from '../src/marketplace';
import type { Skill } from '../src/skills';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

async function render(children: React.ReactNode): Promise<Renderer> {
  const store = createPreferencesStore({
    initialPreferences: { ...createDefaultPreferences(), locale: 'en-US' },
  });
  let renderer: Renderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <AppPresentationProvider store={store}>
        {children}
      </AppPresentationProvider>,
    );
  });
  if (renderer === undefined) throw new Error('renderer was not created');
  return renderer;
}

const skill: Skill = {
  id: 'release_notes',
  name: 'Release notes',
  version: '1.0.0',
  description: 'Turn changes into notes.',
  instructions: 'Read the diff.',
};

function skillManager(
  overrides: Partial<React.ComponentProps<typeof SkillManagerSheet>> = {},
) {
  return (
    <SkillManagerSheet
      skills={[]}
      visible
      onClose={jest.fn()}
      onOpenMarketplace={jest.fn()}
      onRemove={jest.fn()}
      onUse={jest.fn()}
      {...overrides}
    />
  );
}

function marketplace(
  overrides: Partial<React.ComponentProps<typeof MarketplaceSheet>> = {},
) {
  return (
    <MarketplaceSheet
      catalog={BUILTIN_MARKETPLACE}
      installedVersions={{}}
      visible
      onClose={jest.fn()}
      onInstall={jest.fn()}
      {...overrides}
    />
  );
}

test('the skill manager says when it is empty and names what it holds', async () => {
  const empty = await render(skillManager());
  expect(empty.root.findByProps({ testID: 'skills-empty' })).toBeDefined();

  const holding = await render(skillManager({ skills: [skill] }));
  const output = JSON.stringify(holding.toJSON());
  expect(output).toContain('Release notes');
  expect(output).toContain('release_notes');
  expect(output).toContain('Turn changes into notes.');
  expect(
    holding.root.findAllByProps({ testID: 'skills-empty' }),
  ).toHaveLength(0);
});

test('using a skill reports it, and removing names it', async () => {
  const onUse = jest.fn();
  const onRemove = jest.fn();
  const renderer = await render(skillManager({ skills: [skill], onRemove, onUse }));

  const use = renderer.root.findByProps({ testID: 'skill-use-release_notes' });
  await act(async () => use.props.onPress());
  expect(onUse).toHaveBeenCalledWith(skill);

  const remove = renderer.root.findByProps({
    testID: 'skill-remove-release_notes',
  });
  expect(remove.props.accessibilityLabel).toBe('Remove skill Release notes');
  await act(async () => remove.props.onPress());
  expect(onRemove).toHaveBeenCalledWith('release_notes');
});

test('the marketplace lists the shipped catalog with its source', async () => {
  const renderer = await render(marketplace());
  const output = JSON.stringify(renderer.toJSON());

  expect(
    renderer.root.findByProps({ testID: 'marketplace-source' }).props.children,
  ).toContain('Bundled with Rish');
  expect(output).toContain('Release notes');
  expect(output).toContain('Web reader');
  expect(output).toContain('by Rish');
  expect(output).toContain('SKILL');
  expect(output).toContain('PLUGIN');
  expect(output).toContain('Install');
});

test('an installed entry offers nothing to do, and an older one offers an update', async () => {
  const installed = await render(
    marketplace({
      installedVersions: {
        'skill:release_notes': '1.0.0',
        'plugin:web_reader': '0.9.0',
      },
    }),
  );
  const skillAction = installed.root.findByProps({
    testID: 'marketplace-action-skill-release_notes',
  });
  expect(skillAction.props.disabled).toBe(true);

  const pluginAction = installed.root.findByProps({
    testID: 'marketplace-action-plugin-web_reader',
  });
  expect(pluginAction.props.disabled).toBe(false);
  expect(JSON.stringify(installed.toJSON())).toContain('Update');
});

test('installing reports the entry it would install', async () => {
  const onInstall = jest.fn();
  const renderer = await render(marketplace({ onInstall }));
  const action = renderer.root.findByProps({
    testID: 'marketplace-action-skill-release_notes',
  });
  await act(async () => action.props.onPress());

  expect(onInstall).toHaveBeenCalledTimes(1);
  expect(onInstall.mock.calls[0]![0]).toMatchObject({ kind: 'skill' });
});

import React from 'react';
import ReactTestRenderer, {
  act,
  type ReactTestRenderer as Renderer,
} from 'react-test-renderer';

import { PluginEditorSheet } from '../src/components/PluginEditorSheet';
import { SkillEditorSheet } from '../src/components/SkillEditorSheet';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import {
  createDefaultPreferences,
  createPreferencesStore,
} from '../src/preferences';
import type { Plugin } from '../src/plugins/plugins';
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

async function type(
  renderer: Renderer,
  testID: string,
  value: string,
): Promise<void> {
  const field = renderer.root.findByProps({ testID });
  await act(async () => field.props.onChangeText(value));
}

const existingSkill: Skill = {
  id: 'release_notes',
  name: 'Release notes',
  version: '1.0.0',
  description: 'Turn changes into notes.',
  instructions: 'Read the diff.',
};

const existingPlugin: Plugin = {
  id: 'web_reader',
  name: 'Web reader',
  version: '1.0.0',
  description: 'Reads a page.',
  enabled: true,
  tools: [
    {
      name: 'fetch_page',
      description: 'Fetch a page.',
      capability: 'file_read',
      requiresApproval: false,
    },
  ],
};

describe('writing a skill by hand', () => {
  test('nothing is saveable until every field the library needs is there', async () => {
    const renderer = await render(
      <SkillEditorSheet
        editing={null}
        visible
        onClose={jest.fn()}
        onSave={jest.fn()}
      />,
    );
    const save = () =>
      renderer.root.findByProps({ testID: 'skill-editor-save' });
    expect(save().props.disabled).toBe(true);

    await type(renderer, 'skill-editor-id', 'release_notes');
    await type(renderer, 'skill-editor-name', 'Release notes');
    await type(renderer, 'skill-editor-description', 'Turn changes into notes.');
    await type(renderer, 'skill-editor-instructions', 'Read the diff.');
    expect(save().props.disabled).toBe(false);
  });

  test('an id the library would refuse keeps the button off', async () => {
    const renderer = await render(
      <SkillEditorSheet
        editing={null}
        visible
        onClose={jest.fn()}
        onSave={jest.fn()}
      />,
    );
    await type(renderer, 'skill-editor-id', 'Release Notes');
    await type(renderer, 'skill-editor-name', 'Release notes');
    await type(renderer, 'skill-editor-description', 'Notes.');
    await type(renderer, 'skill-editor-instructions', 'Read the diff.');

    expect(
      renderer.root.findByProps({ testID: 'skill-editor-save' }).props.disabled,
    ).toBe(true);
    expect(
      renderer.root.findByProps({ testID: 'skill-editor-reason' }),
    ).toBeDefined();
  });

  test('saving hands back exactly what was typed, trimmed', async () => {
    const onSave = jest.fn();
    const renderer = await render(
      <SkillEditorSheet
        editing={null}
        visible
        onClose={jest.fn()}
        onSave={onSave}
      />,
    );
    await type(renderer, 'skill-editor-id', 'release_notes');
    await type(renderer, 'skill-editor-name', '  Release notes  ');
    await type(renderer, 'skill-editor-description', 'Turn changes into notes.');
    await type(renderer, 'skill-editor-instructions', '  Read the diff.  ');
    await act(async () => {
      renderer.root.findByProps({ testID: 'skill-editor-save' }).props.onPress();
    });

    expect(onSave).toHaveBeenCalledWith({
      id: 'release_notes',
      name: 'Release notes',
      version: '1.0.0',
      description: 'Turn changes into notes.',
      instructions: 'Read the diff.',
    });
  });

  test('correcting a skill starts from what it already says', async () => {
    const renderer = await render(
      <SkillEditorSheet
        editing={existingSkill}
        visible
        onClose={jest.fn()}
        onSave={jest.fn()}
      />,
    );
    expect(
      renderer.root.findByProps({ testID: 'skill-editor-instructions' }).props
        .value,
    ).toBe('Read the diff.');
    expect(
      renderer.root.findByProps({ testID: 'skill-editor-save' }).props.disabled,
    ).toBe(false);
  });
});

describe('writing a plugin by hand', () => {
  test('a declaration with no tools is saveable, and a tool must be complete to be added', async () => {
    const renderer = await render(
      <PluginEditorSheet
        editing={null}
        visible
        onClose={jest.fn()}
        onSave={jest.fn()}
      />,
    );
    const save = () =>
      renderer.root.findByProps({ testID: 'plugin-editor-save' });
    expect(save().props.disabled).toBe(true);

    await type(renderer, 'plugin-editor-id', 'web_reader');
    await type(renderer, 'plugin-editor-name', 'Web reader');
    await type(renderer, 'plugin-editor-description', 'Reads a page.');
    expect(save().props.disabled).toBe(false);

    await act(async () => {
      renderer.root.findByProps({ testID: 'plugin-editor-add-tool' }).props.onPress();
    });
    expect(save().props.disabled).toBe(true);

    await type(renderer, 'plugin-editor-tool-name-0', 'fetch_page');
    await type(renderer, 'plugin-editor-tool-description-0', 'Fetch a page.');
    expect(save().props.disabled).toBe(false);
  });

  test('the capability a tool needs is the one that was chosen', async () => {
    const onSave = jest.fn();
    const renderer = await render(
      <PluginEditorSheet
        editing={existingPlugin}
        visible
        onClose={jest.fn()}
        onSave={onSave}
      />,
    );
    await act(async () => {
      renderer.root
        .findByProps({ testID: 'plugin-editor-capability-guest_service-0' })
        .props.onPress();
    });
    await act(async () => {
      renderer.root
        .findByProps({ testID: 'plugin-editor-tool-approval-0' })
        .props.onValueChange(true);
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'plugin-editor-save' }).props.onPress();
    });

    expect(onSave).toHaveBeenCalledWith({
      ...existingPlugin,
      tools: [
        {
          name: 'fetch_page',
          description: 'Fetch a page.',
          capability: 'guest_service',
          requiresApproval: true,
        },
      ],
    });
  });

  test('a tool the app already offers is refused while it is typed', async () => {
    const renderer = await render(
      <PluginEditorSheet
        editing={existingPlugin}
        visible
        onClose={jest.fn()}
        onSave={jest.fn()}
      />,
    );
    await type(renderer, 'plugin-editor-tool-name-0', 'read_file');

    expect(
      renderer.root.findByProps({ testID: 'plugin-editor-save' }).props.disabled,
    ).toBe(true);
    expect(
      renderer.root.findByProps({ testID: 'plugin-editor-reason' }),
    ).toBeDefined();
  });
});

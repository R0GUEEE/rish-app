import React from 'react';
import { NativeModules } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  DEFAULT_DSH_MODELS,
  dshModelSupportsImages,
  getDshCatalog,
  installDshCatalog,
  validateDshModels,
} from '../src/models/catalog';
import { harnessForModel, isHarnessModelId } from '../src/harness/types';
import { DSH_HARNESS } from '../src/harness/builtins';
import {
  createChatStore,
  hydrateChatState,
  serializeChatState,
} from '../src/state';
import { encodeCompleteV2Request } from '../src/completion/validation';
import { DshModelCatalogCard } from '../src/components/DshModelCatalogCard';
const custom = {
  id: 'catalog-fixture-vNext',
  name: 'New model',
  supports_images: false,
};
const defaults = () => DEFAULT_DSH_MODELS.map(row => ({ ...row }));
afterEach(() =>
  installDshCatalog({
    schema_version: 1,
    models: defaults(),
    retired_models: [],
  }),
);
test('registered model routes to DSH and survives serialization after picker removal', () => {
  expect(isHarnessModelId(custom.id)).toBe(false);
  installDshCatalog({
    schema_version: 1,
    models: [...defaults(), custom],
    retired_models: [],
  });
  expect(harnessForModel(custom.id)).toBe('dsh');
  const store = createChatStore();
  const id = store.createConversation({ modelId: custom.id });
  const serialized = serializeChatState(store.getState());
  installDshCatalog({
    schema_version: 1,
    models: defaults(),
    retired_models: [custom],
  });
  expect(DSH_HARNESS.models.some(row => row.id === custom.id)).toBe(false);
  expect(hydrateChatState(serialized).conversations[id].modelId).toBe(
    custom.id,
  );
});
test('completion encoder accepts only registered dynamic IDs and keeps the wire ID', () => {
  const request = {
    schemaVersion: 2 as const,
    harnessId: 'dsh' as const,
    turnId: '11111111-1111-4111-8111-111111111111',
    attemptId: '22222222-2222-4222-8222-222222222222',
    roundId: '33333333-3333-4333-8333-333333333333',
    roundIndex: 0,
    model: custom.id,
    thinkingMode: 'off' as const,
    visibleHistory: [
      { role: 'user' as const, content: 'fixture', attachments: [] },
    ],
    roundTranscript: [],
    tools: [],
    projectContext: null,
  };
  expect(() => encodeCompleteV2Request(request)).toThrow();
  installDshCatalog({
    schema_version: 1,
    models: [...defaults(), custom],
    retired_models: [],
  });
  expect(JSON.parse(encodeCompleteV2Request(request)).model).toBe(custom.id);
});
test('duplicate, reserved and malformed model IDs fail validation', () => {
  for (const models of [
    [custom, custom],
    [{ ...custom, id: 'gpt-5.6' }],
    [{ ...custom, id: 'bad\nmodel' }],
    [],
  ]) {
    expect(() => validateDshModels(models)).toThrow();
  }
});
test('editor saves additions through native catalog and refreshes the picker catalog', async () => {
  const previous = NativeModules.LocalRuntime;
  const saveDshModelCatalog = jest.fn(async value => ({
    ...value,
    retired_models: [],
  }));
  NativeModules.LocalRuntime = {
    dshModelCatalog: jest.fn(),
    saveDshModelCatalog,
  };
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(
        <DshModelCatalogCard
          model="deepseek-v4-flash"
          disabled={false}
          visible
        />,
      );
    });
    const press = (text: string) =>
      renderer.root
        .findAllByProps({ accessibilityLabel: text })
        .find(node => typeof node.props.onPress === 'function')!
        .props.onPress();
    await act(async () => {
      press('Add model');
    });
    await act(async () => {
      renderer.root
        .findByProps({ testID: 'dsh-model-id-3' })
        .props.onChangeText(custom.id);
      renderer.root
        .findByProps({ testID: 'dsh-model-name-3' })
        .props.onChangeText(custom.name);
    });
    await act(async () => {
      await press('Save model catalog');
    });
    expect(saveDshModelCatalog).toHaveBeenCalledWith({
      schema_version: 1,
      models: [...defaults(), custom],
    });
    expect(getDshCatalog().models.at(-1)).toEqual(custom);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    NativeModules.LocalRuntime = previous;
  }
});

test('default Flash accepts images while Pro remains text only and saved overrides win', () => {
  expect(dshModelSupportsImages('deepseek-v4-flash')).toBe(true);
  expect(dshModelSupportsImages('deepseek-v4-pro')).toBe(false);
  installDshCatalog({schema_version: 1, models: defaults().map(row => row.id === 'deepseek-v4-flash' ? {...row, supports_images: false} : row), retired_models: []});
  expect(dshModelSupportsImages('deepseek-v4-flash')).toBe(false);
});

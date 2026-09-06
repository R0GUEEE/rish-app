import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

import { MessageList, type DisplayMessage } from '../src/components/MessageList';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import { createPreferencesStore } from '../src/preferences';

async function renderMessages(messages: DisplayMessage[]) {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(<MessageList messages={messages} />);
  });
  if (renderer === undefined) throw new Error('renderer missing');
  return renderer;
}

test.each([
  ['deepseek-v4-flash', 'DEEPSEEK'],
  ['GLM-5.3', 'ZHIPU GLM'],
  ['GLM-5.3-Flash', 'ZHIPU GLM'],
  ['claude-sonnet-5', 'ANTHROPIC'],
  ['gpt-5.6', 'OPENAI'],
] as const)('labels %s assistant output by the message model identity', async (modelId, label) => {
  const renderer = await renderMessages([{
    id: 'answer', role: 'assistant', text: 'Saved answer', modelId,
    meta: 'deepseek-v4-flash · 3203 ms',
  }]);
  expect(renderer.root.findByProps({ testID: 'assistant-provider-answer' }).props.children).toBe(label);
  await act(async () => renderer.unmount());
});

test('keeps the DeepSeek label for legacy assistant messages without model identity', async () => {
  const renderer = await renderMessages([{
    id: 'legacy', role: 'assistant', text: 'Old answer', meta: '3203 ms',
  }]);
  expect(renderer.root.findByProps({ testID: 'assistant-provider-legacy' }).props.children).toBe('DEEPSEEK');
  await act(async () => renderer.unmount());
});

test('preserves provider labels in mixed history when the selected Harness changes and a new provider answers', async () => {
  const store = createPreferencesStore();
  const history: DisplayMessage[] = [
    { id: 'dsh', role: 'assistant', text: 'First answer', modelId: 'deepseek-v4-pro' },
    { id: 'glm', role: 'assistant', text: 'Second answer', modelId: 'GLM-5.3-Flash' },
    { id: 'claude', role: 'assistant', text: 'Third answer', modelId: 'claude-opus-5' },
  ];
  const render = (messages: DisplayMessage[]) => (
    <AppPresentationProvider store={store}>
      <MessageList messages={messages} />
    </AppPresentationProvider>
  );
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => { renderer = ReactTestRenderer.create(render(history)); });
  if (renderer === undefined) throw new Error('renderer missing');
  const labels = () => ['dsh', 'glm', 'claude'].map(id =>
    renderer!.root.findByProps({ testID: `assistant-provider-${id}` }).props.children,
  );
  expect(labels()).toEqual(['DEEPSEEK', 'ZHIPU GLM', 'ANTHROPIC']);
  await act(async () => {
    store.setSelectedHarness('codex');
    renderer!.update(render([
      ...history,
      { id: 'codex', role: 'assistant', text: 'Next answer', modelId: 'gpt-5.6' },
    ]));
  });
  expect(labels()).toEqual(['DEEPSEEK', 'ZHIPU GLM', 'ANTHROPIC']);
  expect(renderer.root.findByProps({ testID: 'assistant-provider-codex' }).props.children).toBe('OPENAI');
  await act(async () => renderer!.unmount());
});

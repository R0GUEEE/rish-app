import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

import {
  MessageList,
  type DisplayMessage,
} from '../src/components/MessageList';
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
] as const)(
  'labels %s assistant output by the message model identity',
  async (modelId, label) => {
    const renderer = await renderMessages([
      {
        id: 'answer',
        role: 'assistant',
        text: 'Saved answer',
        modelId,
        meta: 'deepseek-v4-flash · 3203 ms',
      },
    ]);
    expect(
      renderer.root.findByProps({ testID: 'assistant-provider-answer' }).props
        .children,
    ).toBe(label);
    await act(async () => renderer.unmount());
  },
);

test('keeps the DeepSeek label for legacy assistant messages without model identity', async () => {
  const renderer = await renderMessages([
    {
      id: 'legacy',
      role: 'assistant',
      text: 'Old answer',
      meta: '3203 ms',
    },
  ]);
  expect(
    renderer.root.findByProps({ testID: 'assistant-provider-legacy' }).props
      .children,
  ).toBe('DEEPSEEK');
  await act(async () => renderer.unmount());
});

test('preserves provider labels in mixed history when the selected Harness changes and a new provider answers', async () => {
  const store = createPreferencesStore();
  const history: DisplayMessage[] = [
    {
      id: 'dsh',
      role: 'assistant',
      text: 'First answer',
      modelId: 'deepseek-v4-pro',
    },
    {
      id: 'glm',
      role: 'assistant',
      text: 'Second answer',
      modelId: 'GLM-5.3-Flash',
    },
    {
      id: 'claude',
      role: 'assistant',
      text: 'Third answer',
      modelId: 'claude-opus-5',
    },
  ];
  const render = (messages: DisplayMessage[]) => (
    <AppPresentationProvider store={store}>
      <MessageList messages={messages} />
    </AppPresentationProvider>
  );
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(render(history));
  });
  if (renderer === undefined) throw new Error('renderer missing');
  const labels = () =>
    ['dsh', 'glm', 'claude'].map(
      id =>
        renderer!.root.findByProps({ testID: `assistant-provider-${id}` }).props
          .children,
    );
  expect(labels()).toEqual(['DEEPSEEK', 'ZHIPU GLM', 'ANTHROPIC']);
  await act(async () => {
    store.setSelectedHarness('codex');
    renderer!.update(
      render([
        ...history,
        {
          id: 'codex',
          role: 'assistant',
          text: 'Next answer',
          modelId: 'gpt-5.6',
        },
      ]),
    );
  });
  expect(labels()).toEqual(['DEEPSEEK', 'ZHIPU GLM', 'ANTHROPIC']);
  expect(
    renderer.root.findByProps({ testID: 'assistant-provider-codex' }).props
      .children,
  ).toBe('OPENAI');
  await act(async () => renderer!.unmount());
});

test('history indicator survives stream, tool and attachment updates until explicit return', async () => {
  let messages: DisplayMessage[] = [
    { id: 'live', role: 'assistant', text: 'Initial' },
  ];
  const renderer = await renderMessages(messages);
  const event = (offset: number) => ({
    nativeEvent: {
      contentOffset: { x: 0, y: offset },
      contentSize: { width: 400, height: 2000 },
      layoutMeasurement: { width: 400, height: 500 },
    },
  });
  const scroller = () =>
    renderer.root.findByProps({ testID: 'message-scroll' });
  await act(async () => {
    scroller().props.onScroll(event(1500));
    scroller().props.onScrollBeginDrag();
    scroller().props.onScroll(event(300));
    scroller().props.onScrollEndDrag(event(300));
  });
  expect(
    renderer.root.findByProps({ testID: 'message-jump-latest' }).props
      .accessibilityLabel,
  ).toBe('Back to latest');
  const updates: DisplayMessage[][] = [
    [{ ...messages[0], text: 'Initial streamed continuation' }],
    [
      {
        ...messages[0],
        blocks: [
          {
            id: 'tool',
            type: 'tool-call',
            name: 'read_file',
            arguments: '{}',
            status: 'success',
          },
        ],
      },
    ],
    [
      {
        id: 'attachment',
        role: 'user',
        text: '',
        attachments: [
          {
            schema_version: 1,
            id: 'image',
            kind: 'image',
            name: 'receipt.png',
            mime_type: 'image/png',
            size: 2048,
            thumbnail_data_url: 'data:image/png;base64,cHJldmlldw==',
          },
        ],
      },
      ...messages,
    ],
  ];
  for (const update of updates) {
    messages = update;
    await act(async () => renderer.update(<MessageList messages={messages} />));
    await act(async () => scroller().props.onContentSizeChange(400, 2200));
    expect(
      renderer.root.findByProps({ testID: 'message-jump-latest' }).props
        .accessibilityLabel,
    ).toBe('New content · Back to latest');
  }
  await act(async () =>
    renderer.root
      .findByProps({ testID: 'message-jump-latest' })
      .props.onPress(),
  );
  expect(
    renderer.root.findAllByProps({ testID: 'message-jump-latest' }),
  ).toHaveLength(0);
  await act(async () => renderer.unmount());
});

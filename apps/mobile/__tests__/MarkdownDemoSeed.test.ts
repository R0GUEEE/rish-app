import {
  MARKDOWN_DEMO_ASSISTANT_TEXT,
  MARKDOWN_DEMO_USER_TEXT,
  seedMarkdownDemoConversation,
} from '../src/dev/markdownDemo';
import { createChatStore } from '../src/state';

function makeStore() {
  let counter = 0;
  return createChatStore({
    createId: kind => kind + '-' + (++counter),
  });
}

describe('markdown demo seed fixture', () => {
  test('seeds one selected conversation with user and assistant messages', () => {
    const store = makeStore();
    seedMarkdownDemoConversation(store);
    const state = store.getState();
    const conversations = Object.values(state.conversations);
    expect(conversations.length).toBe(1);
    expect(state.selectedConversationId).toBe(conversations[0].id);
    expect(conversations[0].messages.map(message => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(conversations[0].messages[0].text).toBe(MARKDOWN_DEMO_USER_TEXT);
    expect(conversations[0].messages[1].text).toBe(MARKDOWN_DEMO_ASSISTANT_TEXT);
  });

  test('contains the demo table, block math, inline math, and image', () => {
    const text = MARKDOWN_DEMO_ASSISTANT_TEXT;
    expect(text).toContain('| Metric | Value | Trend |');
    expect(text).toContain('| :--- | ---: | :---: |');
    expect(text).toContain(String.fromCharCode(36) + String.fromCharCode(36));
    expect(text).toContain(String.fromCharCode(92) + 'sum_{i=1}^{n}');
    expect(text).toContain(String.fromCharCode(36) + 'x^2' + String.fromCharCode(36));
    expect(text).toContain('![DSH logo](https://example.com/dsh-cover.png)');
  });

  test('always seeds a fresh selected conversation', () => {
    const store = makeStore();
    const existing = store.createConversation({ select: true });
    store.appendUserMessage(existing, 'existing message');
    seedMarkdownDemoConversation(store);
    const state = store.getState();
    expect(Object.values(state.conversations).length).toBe(2);
    const seeded = Object.values(state.conversations).find(
      conversation =>
        conversation.messages[0]?.text === MARKDOWN_DEMO_USER_TEXT,
    );
    expect(seeded).toBeDefined();
    expect(state.selectedConversationId).toBe(seeded?.id);
  });
});

import {
  conversationToMarkdown,
  formatAttachmentSize,
  type ExportableConversation,
} from '../src/export/conversationMarkdown';

const conversation = (
  overrides: Partial<ExportableConversation> = {},
): ExportableConversation => ({
  title: 'Refactor the parser',
  modelId: 'deepseek-v4-flash',
  createdAt: '2026-09-30T08:00:00.000Z',
  messages: [],
  ...overrides,
});

describe('formatAttachmentSize', () => {
  test('reads as bytes, kilobytes and megabytes', () => {
    expect(formatAttachmentSize(0)).toBe('0 B');
    expect(formatAttachmentSize(512)).toBe('512 B');
    expect(formatAttachmentSize(1024)).toBe('1.0 KB');
    expect(formatAttachmentSize(2048)).toBe('2.0 KB');
    expect(formatAttachmentSize(52_428)).toBe('51 KB');
    expect(formatAttachmentSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatAttachmentSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  test('refuses to render a nonsensical size as something it is not', () => {
    expect(formatAttachmentSize(-1)).toBe('0 B');
    expect(formatAttachmentSize(Number.NaN)).toBe('0 B');
    expect(formatAttachmentSize(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});

describe('conversationToMarkdown', () => {
  test('names the conversation, its model and when it started', () => {
    const markdown = conversationToMarkdown(conversation());
    expect(markdown).toContain('# Refactor the parser');
    expect(markdown).toContain('`deepseek-v4-flash`');
    expect(markdown).toContain('2026-09-30T08:00:00.000Z');
    expect(markdown).toContain('Messages: 0');
  });

  test('never emits a blank heading for a conversation with no title', () => {
    expect(conversationToMarkdown(conversation({ title: '   ' }))).toContain(
      '# Untitled chat',
    );
    expect(conversationToMarkdown(conversation({ title: '' }))).toContain(
      '# Untitled chat',
    );
  });

  test('says so instead of trailing off when there is nothing to export', () => {
    expect(conversationToMarkdown(conversation())).toContain(
      '_This conversation has no messages._',
    );
  });

  test('renders each turn under the role that said it', () => {
    const markdown = conversationToMarkdown(
      conversation({
        messages: [
          { role: 'user', text: 'Why is it slow?' },
          { role: 'assistant', text: 'Because the parser rescans.' },
        ],
      }),
    );
    expect(markdown).toContain('## User');
    expect(markdown).toContain('Why is it slow?');
    expect(markdown).toContain('## Assistant');
    expect(markdown).toContain('Because the parser rescans.');
    expect(markdown).toContain('Messages: 2');
  });

  test('keeps a message that said nothing rather than dropping it', () => {
    const markdown = conversationToMarkdown(
      conversation({ messages: [{ role: 'assistant', text: '   ' }] }),
    );
    expect(markdown).toContain('## Assistant');
    expect(markdown).toContain('_No text._');
  });

  test('lists attachments with their kind and readable size', () => {
    const markdown = conversationToMarkdown(
      conversation({
        messages: [
          {
            role: 'user',
            text: 'Look at this',
            attachments: [
              { name: 'trace.log', kind: 'text', size: 2048 },
              { name: 'shot.png', kind: 'image', size: 1024 * 1024 },
            ],
          },
        ],
      }),
    );
    expect(markdown).toContain('**Attachments**');
    expect(markdown).toContain('`trace.log` (text, 2.0 KB)');
    expect(markdown).toContain('`shot.png` (image, 1.0 MB)');
  });

  test('does not invent an attachment list for a message with none', () => {
    const withNone = conversationToMarkdown(
      conversation({ messages: [{ role: 'user', text: 'hi' }] }),
    );
    expect(withNone).not.toContain('**Attachments**');
    const withEmpty = conversationToMarkdown(
      conversation({
        messages: [{ role: 'user', text: 'hi', attachments: [] }],
      }),
    );
    expect(withEmpty).not.toContain('**Attachments**');
  });

  test('folds reasoning shut, and only when the model produced one', () => {
    const withReasoning = conversationToMarkdown(
      conversation({
        messages: [
          {
            role: 'assistant',
            text: 'Answer',
            metadata: { reasoning: 'I considered the cache.' },
          },
        ],
      }),
    );
    expect(withReasoning).toContain('<details>');
    expect(withReasoning).toContain('<summary>Reasoning</summary>');
    expect(withReasoning).toContain('I considered the cache.');
    expect(withReasoning).toContain('</details>');

    const without = conversationToMarkdown(
      conversation({ messages: [{ role: 'assistant', text: 'Answer' }] }),
    );
    expect(without).not.toContain('<details>');

    const blank = conversationToMarkdown(
      conversation({
        messages: [
          { role: 'assistant', text: 'Answer', metadata: { reasoning: '  ' } },
        ],
      }),
    );
    expect(blank).not.toContain('<details>');
  });

  test('ends with exactly one newline, so a written file is well-formed', () => {
    const markdown = conversationToMarkdown(
      conversation({
        messages: [
          { role: 'user', text: 'one' },
          { role: 'assistant', text: 'two' },
        ],
      }),
    );
    expect(markdown.endsWith('\n')).toBe(true);
    expect(markdown.endsWith('\n\n')).toBe(false);
    expect(markdown).not.toMatch(/\n\n\n/u);
  });

  test('is a pure function of the conversation it is given', () => {
    const input = conversation({
      messages: [{ role: 'user', text: 'stable' }],
    });
    const frozen = JSON.stringify(input);
    expect(conversationToMarkdown(input)).toBe(conversationToMarkdown(input));
    expect(JSON.stringify(input)).toBe(frozen);
  });
});

import {
  MAX_MESSAGES_SCANNED,
  MAX_MESSAGE_MATCHES,
  MESSAGE_SNIPPET_RADIUS,
  MIN_MESSAGE_QUERY_LENGTH,
  searchMessageMatches,
  type DrawerSearchableConversation,
} from '../src/components/chatDrawerSections';

const conversation = (
  id: string,
  title: string,
  texts: readonly string[],
): DrawerSearchableConversation => ({
  id,
  title,
  messages: texts.map((text, index) => ({
    id: `${id}-m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text,
  })),
});

describe('searching inside conversations', () => {
  test('a query too short to be useful finds nothing', () => {
    const conversations = [conversation('c1', 'Parser', ['the parser rescans'])];
    expect(MIN_MESSAGE_QUERY_LENGTH).toBeGreaterThan(1);
    expect(searchMessageMatches(conversations, 'a')).toEqual([]);
    expect(searchMessageMatches(conversations, '  ')).toEqual([]);
  });

  test('a phrase only inside a message is found, and its chat is named', () => {
    const conversations = [
      conversation('c1', 'Parser', ['why is it slow?', 'it rescans the file']),
      conversation('c2', 'Other', ['nothing to see']),
    ];
    const matches = searchMessageMatches(conversations, 'RESCANS');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      conversationId: 'c1',
      conversationTitle: 'Parser',
      messageId: 'c1-m1',
      role: 'assistant',
    });
    expect(matches[0]!.snippet).toContain('rescans the file');
  });

  test('a long message is shown around the match, with the cut marked', () => {
    const before = 'a'.repeat(200);
    const after = 'b'.repeat(200);
    const matches = searchMessageMatches(
      [conversation('c1', 'Long', [`${before} needle ${after}`])],
      'needle',
    );
    const snippet = matches[0]!.snippet;
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).toContain('needle');
    expect(snippet.length).toBeLessThanOrEqual(MESSAGE_SNIPPET_RADIUS * 2 + 12);
  });

  test('a snippet is clipped between characters, not through one', () => {
    const emoji = '🙂'.repeat(80);
    const matches = searchMessageMatches(
      [conversation('c1', 'Emoji', [`${emoji} needle`])],
      'needle',
    );
    const snippet = matches[0]!.snippet;
    // A cut through a surrogate pair would leave a lone surrogate behind.
    expect(/[\uD800-\uDFFF]/u.test(snippet.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu, ''))).toBe(false);
    expect(snippet).toContain('needle');
  });

  test('results stop at the shown limit, and the scan stops at its own', () => {
    const many = conversation(
      'c1',
      'Many',
      Array.from({ length: MAX_MESSAGE_MATCHES + 10 }, () => 'needle'),
    );
    expect(searchMessageMatches([many], 'needle')).toHaveLength(
      MAX_MESSAGE_MATCHES,
    );

    const beyondScan = conversation(
      'c1',
      'Deep',
      [
        ...Array.from({ length: MAX_MESSAGES_SCANNED }, () => 'nothing here'),
        'needle',
      ],
    );
    expect(searchMessageMatches([beyondScan], 'needle')).toEqual([]);
  });
});

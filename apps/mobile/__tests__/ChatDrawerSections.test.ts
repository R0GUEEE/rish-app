import {
  matchesConversationQuery,
  partitionConversations,
  type DrawerConversationLike,
} from '../src/components/chatDrawerSections';

const conversation = (
  id: string,
  title: string,
  preview = '',
): DrawerConversationLike => ({ id, title, preview });

const history: DrawerConversationLike[] = [
  conversation('c1', 'Agent tools', 'approved a write'),
  conversation('c2', 'Notes', 'summarised the PDF'),
  conversation('c3', 'Release', 'tagged v0.1.0'),
];

describe('partitionConversations', () => {
  test('with nothing pinned, history is recent as given', () => {
    const sections = partitionConversations(history, []);
    expect(sections.pinned).toEqual([]);
    expect(sections.recent).toBe(history);
  });

  test('the shelf follows pin order, not history order', () => {
    const sections = partitionConversations(history, ['c3', 'c1']);
    expect(sections.pinned.map(item => item.id)).toEqual(['c3', 'c1']);
  });

  test('a pinned conversation is not also offered in recent', () => {
    const sections = partitionConversations(history, ['c2']);
    expect(sections.recent.map(item => item.id)).toEqual(['c1', 'c3']);
  });

  test('a pin whose conversation is gone is skipped rather than shown blank', () => {
    const sections = partitionConversations(history, ['deleted', 'c2']);
    expect(sections.pinned.map(item => item.id)).toEqual(['c2']);
    expect(sections.recent.map(item => item.id)).toEqual(['c1', 'c3']);
  });

  test('an id listed twice is drawn once', () => {
    const sections = partitionConversations(history, ['c2', 'c2']);
    expect(sections.pinned.map(item => item.id)).toEqual(['c2']);
  });

  test('pins that match nothing leave the recent list untouched', () => {
    const sections = partitionConversations(history, ['deleted']);
    expect(sections.pinned).toEqual([]);
    expect(sections.recent.map(item => item.id)).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('matchesConversationQuery', () => {
  const item = conversation('c1', 'Agent tools', 'approved a write');

  test('an empty or blank query matches everything', () => {
    expect(matchesConversationQuery(item, '')).toBe(true);
    expect(matchesConversationQuery(item, '   ')).toBe(true);
  });

  test('the title and the preview are both searched, without case', () => {
    expect(matchesConversationQuery(item, 'agent')).toBe(true);
    expect(matchesConversationQuery(item, 'WRITE')).toBe(true);
    expect(matchesConversationQuery(item, '  tools  ')).toBe(true);
    expect(matchesConversationQuery(item, 'missing')).toBe(false);
  });
});

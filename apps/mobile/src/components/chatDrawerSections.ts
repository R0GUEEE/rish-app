/**
 * How the drawer splits its history into the pinned shelf and the rest.
 *
 * Kept apart from the component so the rule can be tested without Monaco or a
 * rendering surface, and so the drawer itself stays a layout.
 */

/** The least a row needs for the drawer to order and search it. */
export type DrawerConversationLike = {
  readonly id: string;
  readonly title: string;
  readonly preview: string;
};

/** Whether a conversation matches what was typed into the drawer search. */
export function matchesConversationQuery(
  conversation: DrawerConversationLike,
  query: string,
): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return true;
  return `${conversation.title}\n${conversation.preview}`
    .toLocaleLowerCase()
    .includes(normalized);
}

export type ConversationSections<T> = {
  /** Pinned conversations, in pin order; a pin whose chat is gone is skipped. */
  readonly pinned: readonly T[];
  /** Everything else, in the order it was given. */
  readonly recent: readonly T[];
};

/**
 * Splits conversations into the pinned shelf and the recent list.
 *
 * The shelf follows the order the pins were made rather than recency of use,
 * and a conversation is only ever in one of the two lists: a pinned chat that
 * also sat in RECENT would be offered twice.
 */
export function partitionConversations<T extends DrawerConversationLike>(
  conversations: readonly T[],
  pinnedIds: readonly string[],
): ConversationSections<T> {
  if (pinnedIds.length === 0) {
    return { pinned: [], recent: conversations };
  }
  const byId = new Map(conversations.map(item => [item.id, item]));
  const pinned: T[] = [];
  const onShelf = new Set<string>();
  for (const id of pinnedIds) {
    if (onShelf.has(id)) continue;
    const item = byId.get(id);
    if (item === undefined) continue;
    onShelf.add(id);
    pinned.push(item);
  }
  if (pinned.length === 0) {
    return { pinned: [], recent: conversations };
  }
  return {
    pinned,
    recent: conversations.filter(item => !onShelf.has(item.id)),
  };
}

/** The least a message needs for the drawer to search and show it. */
export type DrawerMessageLike = {
  readonly id: string;
  readonly role: string;
  readonly text: string;
};

/** The least a conversation needs for the drawer to search its messages. */
export type DrawerSearchableConversation = {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly DrawerMessageLike[];
};

/**
 * A query shorter than this is not searched in messages.
 *
 * One letter matches nearly every message in a long history, and the scan it
 * costs is paid on each keystroke; the title search above still runs.
 */
export const MIN_MESSAGE_QUERY_LENGTH = 2;
/** How many matches the drawer will show. */
export const MAX_MESSAGE_MATCHES = 20;
/** How many messages one search will read before it stops. */
export const MAX_MESSAGES_SCANNED = 4000;
/** How much of a message is shown around the match, on each side. */
export const MESSAGE_SNIPPET_RADIUS = 60;

export type MessageSearchMatch = {
  readonly conversationId: string;
  readonly conversationTitle: string;
  readonly messageId: string;
  readonly role: string;
  /** The message text around the first match, bounded. */
  readonly snippet: string;
};

/**
 * The text around the first match, with ellipses where it was cut.
 *
 * The snippet is taken by code point, not by UTF-16 unit, so a match in a
 * message full of emoji cannot be cut through the middle of one.
 */
function snippetAround(text: string, normalized: string): string {
  const at = text.toLocaleLowerCase().indexOf(normalized);
  const points = [...text];
  const prefix = at === -1 ? 0 : [...text.slice(0, at)].length;
  const length = [...normalized].length;
  const start = Math.max(0, prefix - MESSAGE_SNIPPET_RADIUS);
  const end = Math.min(points.length, prefix + length + MESSAGE_SNIPPET_RADIUS);
  const body = points.slice(start, end).join('').replace(/\s+/gu, ' ');
  return `${start > 0 ? '…' : ''}${body}${end < points.length ? '…' : ''}`;
}

/**
 * Searches the messages of every conversation, most recent conversation first.
 *
 * The drawer's own search matches a title and the one-line preview it holds;
 * this is what finds a phrase that only appears inside a conversation. Results
 * are bounded in every direction -- the query length, the messages read, and
 * the matches returned -- because this runs while a person types.
 */
export function searchMessageMatches(
  conversations: readonly DrawerSearchableConversation[],
  query: string,
): readonly MessageSearchMatch[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length < MIN_MESSAGE_QUERY_LENGTH) return [];
  const matches: MessageSearchMatch[] = [];
  let scanned = 0;
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      if (scanned >= MAX_MESSAGES_SCANNED) return matches;
      scanned += 1;
      if (!message.text.toLocaleLowerCase().includes(normalized)) continue;
      matches.push({
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        messageId: message.id,
        role: message.role,
        snippet: snippetAround(message.text, normalized),
      });
      if (matches.length >= MAX_MESSAGE_MATCHES) return matches;
    }
  }
  return matches;
}

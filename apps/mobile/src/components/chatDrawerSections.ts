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

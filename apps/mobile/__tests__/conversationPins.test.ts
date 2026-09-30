import {
  MAX_PINNED_CONVERSATIONS,
  createDefaultPreferences,
  createPreferencesStore,
  hydrateAppPreferences,
  isConversationPinned,
  isPinnedConversationId,
  preferencesReducer,
  selectPinnedConversations,
  serializeAppPreferences,
  type AppPreferences,
} from '../src/preferences';

const pin = (
  preferences: AppPreferences,
  conversationId: string,
  pinned = true,
): AppPreferences =>
  preferencesReducer(preferences, {
    type: 'preferences/set-conversation-pin',
    payload: { conversationId, pinned },
  });

const id = (index: number) => `conv-${index}`;

describe('conversation pin validation', () => {
  test('accepts a bounded printable conversation id', () => {
    expect(isPinnedConversationId('conv-1')).toBe(true);
    expect(isPinnedConversationId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(
      true,
    );
    expect(isPinnedConversationId('x'.repeat(256))).toBe(true);
    expect(isPinnedConversationId('')).toBe(false);
    expect(isPinnedConversationId('x'.repeat(257))).toBe(false);
    expect(isPinnedConversationId('has\u0000control')).toBe(false);
    expect(isPinnedConversationId(7)).toBe(false);
    expect(isPinnedConversationId(null)).toBe(false);
  });
});

describe('set-conversation-pin', () => {
  test('starts with nothing pinned', () => {
    expect(selectPinnedConversations(createDefaultPreferences())).toEqual([]);
    expect(isConversationPinned(createDefaultPreferences(), 'conv-1')).toBe(
      false,
    );
  });

  test('pinning adds a conversation and reports it as pinned', () => {
    const preferences = pin(createDefaultPreferences(), 'conv-1');
    expect(selectPinnedConversations(preferences)).toEqual(['conv-1']);
    expect(isConversationPinned(preferences, 'conv-1')).toBe(true);
  });

  test('the newest pin is first, so the shelf does not reorder itself', () => {
    const preferences = pin(
      pin(createDefaultPreferences(), 'conv-1'),
      'conv-2',
    );
    expect(selectPinnedConversations(preferences)).toEqual([
      'conv-2',
      'conv-1',
    ]);
  });

  test('pinning something already at the front changes nothing, not even identity', () => {
    const preferences = pin(createDefaultPreferences(), 'conv-1');
    expect(pin(preferences, 'conv-1')).toBe(preferences);
  });

  test('unpinning removes it, and unpinning again is not a change', () => {
    const preferences = pin(createDefaultPreferences(), 'conv-1');
    const unpinned = pin(preferences, 'conv-1', false);
    expect(selectPinnedConversations(unpinned)).toEqual([]);
    expect(pin(unpinned, 'conv-1', false)).toBe(unpinned);
  });

  test('an id a conversation could never carry leaves the list alone', () => {
    const preferences = pin(createDefaultPreferences(), 'conv-1');
    expect(pin(preferences, '')).toBe(preferences);
    expect(pin(preferences, 'x'.repeat(257))).toBe(preferences);
  });

  test('a full shelf drops the oldest pin rather than refusing the newest', () => {
    let preferences = createDefaultPreferences();
    for (let index = 0; index < MAX_PINNED_CONVERSATIONS; index += 1) {
      preferences = pin(preferences, id(index));
    }
    expect(selectPinnedConversations(preferences)).toHaveLength(
      MAX_PINNED_CONVERSATIONS,
    );
    expect(selectPinnedConversations(preferences)[0]).toBe(id(49));

    const overflowed = pin(preferences, 'newest');
    const pinned = selectPinnedConversations(overflowed);
    expect(pinned).toHaveLength(MAX_PINNED_CONVERSATIONS);
    expect(pinned[0]).toBe('newest');
    expect(pinned).not.toContain(id(0));
    expect(pinned).toContain(id(49));
  });

  test('the whole shelf survives a save and load unchanged', () => {
    const preferences = pin(
      pin(createDefaultPreferences(), 'conv-a'),
      'conv-b',
    );
    const restored = hydrateAppPreferences(
      serializeAppPreferences(preferences),
    );
    expect(selectPinnedConversations(restored)).toEqual(['conv-b', 'conv-a']);
  });

  test('a state written before pinning existed loads as nothing pinned', () => {
    const serialized = JSON.parse(
      serializeAppPreferences(createDefaultPreferences()),
    ) as Record<string, unknown>;
    delete serialized.pinned_conversations;
    expect(
      selectPinnedConversations(hydrateAppPreferences(serialized)),
    ).toEqual([]);
  });
});

describe('pinned conversations persistence', () => {
  const withPins = (value: unknown): Record<string, unknown> => {
    const serialized = JSON.parse(
      serializeAppPreferences(createDefaultPreferences()),
    ) as Record<string, unknown>;
    serialized.pinned_conversations = value;
    return serialized;
  };

  test('refuses a list that is not a list of unique bounded ids', () => {
    expect(() => hydrateAppPreferences(withPins('conv-1'))).toThrow();
    expect(() =>
      hydrateAppPreferences(withPins(['conv-1', 'conv-1'])),
    ).toThrow();
    expect(() => hydrateAppPreferences(withPins(['']))).toThrow();
    expect(() => hydrateAppPreferences(withPins([42]))).toThrow();
    expect(() =>
      hydrateAppPreferences(
        withPins(
          Array.from({ length: MAX_PINNED_CONVERSATIONS + 1 }, (_, i) => id(i)),
        ),
      ),
    ).toThrow();
  });

  test('an empty list is how a person who unpinned everything is stored', () => {
    expect(
      selectPinnedConversations(hydrateAppPreferences(withPins([]))),
    ).toEqual([]);
  });
});

describe('preferences store pinning', () => {
  test('notifies once per real change, and not for a repeated pin', () => {
    const store = createPreferencesStore();
    const listener = jest.fn();
    store.subscribe(listener);

    store.setConversationPin('conv-1', true);
    store.setConversationPin('conv-1', true);
    store.setConversationPin('conv-1', false);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(selectPinnedConversations(store.getState())).toEqual([]);
  });
});

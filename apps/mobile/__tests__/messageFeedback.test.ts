import {
  MAX_MESSAGE_FEEDBACK_ENTRIES,
  createDefaultPreferences,
  createPreferencesStore,
  hydrateAppPreferences,
  isFeedbackMessageId,
  isMessageFeedbackRating,
  preferencesReducer,
  selectMessageFeedback,
  selectMessageFeedbackFor,
  serializeAppPreferences,
  type AppPreferences,
  type MessageFeedbackRating,
} from '../src/preferences';

const rate = (
  preferences: AppPreferences,
  messageId: string,
  rating: MessageFeedbackRating | null,
): AppPreferences =>
  preferencesReducer(preferences, {
    type: 'preferences/set-message-feedback',
    payload: { messageId, rating },
  });

describe('message feedback validation', () => {
  test('accepts the two ratings and nothing else', () => {
    expect(isMessageFeedbackRating('up')).toBe(true);
    expect(isMessageFeedbackRating('down')).toBe(true);
    expect(isMessageFeedbackRating('sideways')).toBe(false);
    expect(isMessageFeedbackRating('')).toBe(false);
    expect(isMessageFeedbackRating(null)).toBe(false);
    expect(isMessageFeedbackRating(1)).toBe(false);
  });

  test('accepts a bounded printable message id', () => {
    expect(isFeedbackMessageId('msg-1')).toBe(true);
    expect(isFeedbackMessageId('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
    expect(isFeedbackMessageId('')).toBe(false);
    expect(isFeedbackMessageId('x'.repeat(257))).toBe(false);
    expect(isFeedbackMessageId('x'.repeat(256))).toBe(true);
    expect(isFeedbackMessageId('has\u0000control')).toBe(false);
    expect(isFeedbackMessageId(42)).toBe(false);
  });
});

describe('set-message-feedback', () => {
  test('starts with no ratings at all', () => {
    const preferences = createDefaultPreferences();
    expect(selectMessageFeedback(preferences)).toEqual({});
    expect(selectMessageFeedbackFor(preferences, 'msg-1')).toBeNull();
  });

  test('records one rating per message', () => {
    const preferences = rate(createDefaultPreferences(), 'msg-1', 'up');
    expect(selectMessageFeedbackFor(preferences, 'msg-1')).toBe('up');
    expect(selectMessageFeedback(preferences)).toEqual({ 'msg-1': 'up' });
  });

  test('clearing is explicit, so the same rating twice is simply a no-op', () => {
    const once = rate(createDefaultPreferences(), 'msg-1', 'up');
    expect(rate(once, 'msg-1', 'up')).toBe(once);
  });

  test('clearing by passing null is what makes the control a toggle', () => {
    const once = rate(createDefaultPreferences(), 'msg-1', 'up');
    const cleared = rate(once, 'msg-1', null);
    expect(selectMessageFeedbackFor(cleared, 'msg-1')).toBeNull();
    expect(selectMessageFeedback(cleared)).toEqual({});
  });

  test('changes side without clearing, and keeps other messages', () => {
    const both = rate(rate(createDefaultPreferences(), 'msg-1', 'up'), 'msg-2', 'down');
    const flipped = rate(both, 'msg-1', 'down');
    expect(selectMessageFeedbackFor(flipped, 'msg-1')).toBe('down');
    expect(selectMessageFeedbackFor(flipped, 'msg-2')).toBe('down');
  });

  test('clearing an unrated message changes nothing, by reference', () => {
    const preferences = rate(createDefaultPreferences(), 'msg-1', 'up');
    expect(rate(preferences, 'msg-9', null)).toBe(preferences);
  });

  test('refuses a rating the app does not define', () => {
    const preferences = createDefaultPreferences();
    expect(rate(preferences, 'msg-1', 'sideways' as MessageFeedbackRating)).toBe(
      preferences,
    );
  });

  test('refuses an id that could not be a message id', () => {
    const preferences = createDefaultPreferences();
    expect(rate(preferences, '', 'up')).toBe(preferences);
    expect(rate(preferences, 'x'.repeat(257), 'up')).toBe(preferences);
    expect(rate(preferences, 'bad\u0000id', 'up')).toBe(preferences);
  });

  test('never mutates the preferences it was given', () => {
    const before = createDefaultPreferences();
    const snapshot = JSON.stringify(before);
    rate(before, 'msg-1', 'up');
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  test('bounds itself by dropping the oldest rating, not the newest', () => {
    let preferences = createDefaultPreferences();
    for (let index = 0; index <= MAX_MESSAGE_FEEDBACK_ENTRIES; index += 1) {
      preferences = rate(preferences, `msg-${index}`, 'up');
    }
    const feedback = selectMessageFeedback(preferences);
    expect(Object.keys(feedback)).toHaveLength(MAX_MESSAGE_FEEDBACK_ENTRIES);
    // The first rating is gone; the newest is kept.
    expect(feedback['msg-0']).toBeUndefined();
    expect(feedback[`msg-${MAX_MESSAGE_FEEDBACK_ENTRIES}`]).toBe('up');
  });

  test('a changed rating counts as the most recent, so it survives a trim', () => {
    let preferences = createDefaultPreferences();
    // Fill to the bound.
    for (let index = 0; index < MAX_MESSAGE_FEEDBACK_ENTRIES; index += 1) {
      preferences = rate(preferences, `msg-${index}`, 'up');
    }
    // Re-rate the oldest one, then add one more to force an eviction.
    preferences = rate(preferences, 'msg-0', 'down');
    preferences = rate(preferences, 'msg-new', 'up');
    const feedback = selectMessageFeedback(preferences);
    expect(Object.keys(feedback)).toHaveLength(MAX_MESSAGE_FEEDBACK_ENTRIES);
    expect(feedback['msg-0']).toBe('down');
    expect(feedback['msg-1']).toBeUndefined();
    expect(feedback['msg-new']).toBe('up');
  });

  test('reset clears ratings along with everything else', () => {
    const rated = rate(createDefaultPreferences(), 'msg-1', 'up');
    const reset = preferencesReducer(rated, { type: 'preferences/reset' });
    expect(selectMessageFeedback(reset)).toEqual({});
  });
});

describe('message feedback persistence', () => {
  test('round-trips through the persisted envelope', () => {
    const preferences = rate(rate(createDefaultPreferences(), 'a', 'up'), 'b', 'down');
    const encoded = serializeAppPreferences(preferences);
    expect(JSON.parse(encoded).message_feedback).toEqual({ a: 'up', b: 'down' });
    expect(hydrateAppPreferences(encoded)).toEqual(preferences);
  });

  test('a state written before feedback existed hydrates to none', () => {
    const legacy = JSON.parse(
      serializeAppPreferences(createDefaultPreferences()),
    ) as Record<string, unknown>;
    delete legacy.message_feedback;
    expect(hydrateAppPreferences(legacy).messageFeedback).toEqual({});
  });

  test('rejects a rating that is not one of the two', () => {
    const encoded = JSON.parse(
      serializeAppPreferences(createDefaultPreferences()),
    ) as Record<string, unknown>;
    encoded.message_feedback = { 'msg-1': 'sideways' };
    expect(() => hydrateAppPreferences(encoded)).toThrow(/up or down/u);
  });

  test('rejects a key that could not be a message id', () => {
    const encoded = JSON.parse(
      serializeAppPreferences(createDefaultPreferences()),
    ) as Record<string, unknown>;
    encoded.message_feedback = { '': 'up' };
    expect(() => hydrateAppPreferences(encoded)).toThrow(/message id/u);
  });

  test('rejects a blob carrying more ratings than the app would ever write', () => {
    const encoded = JSON.parse(
      serializeAppPreferences(createDefaultPreferences()),
    ) as Record<string, unknown>;
    const oversized: Record<string, string> = {};
    for (let index = 0; index <= MAX_MESSAGE_FEEDBACK_ENTRIES; index += 1) {
      oversized[`msg-${index}`] = 'up';
    }
    encoded.message_feedback = oversized;
    expect(() => hydrateAppPreferences(encoded)).toThrow(/at most/u);
  });

  test('rejects a feedback field that is not an object', () => {
    const encoded = JSON.parse(
      serializeAppPreferences(createDefaultPreferences()),
    ) as Record<string, unknown>;
    encoded.message_feedback = ['up'];
    expect(() => hydrateAppPreferences(encoded)).toThrow(/must be an object/u);
  });
});

describe('feedback through the preferences store', () => {
  test('a rating reaches subscribers, because the control has to repaint', () => {
    const store = createPreferencesStore();
    const seen: Array<AppPreferences> = [];
    store.subscribe(preferences => seen.push(preferences));

    store.setMessageFeedback('msg-1', 'up');

    expect(seen).toHaveLength(1);
    expect(selectMessageFeedbackFor(store.getState(), 'msg-1')).toBe('up');
  });

  test('re-rating the same message reaches subscribers again', () => {
    const store = createPreferencesStore();
    store.setMessageFeedback('msg-1', 'up');
    const seen: Array<AppPreferences> = [];
    store.subscribe(preferences => seen.push(preferences));

    store.setMessageFeedback('msg-1', 'down');

    expect(seen).toHaveLength(1);
    expect(selectMessageFeedbackFor(store.getState(), 'msg-1')).toBe('down');
  });

  test('clearing a rating reaches subscribers', () => {
    const store = createPreferencesStore();
    store.setMessageFeedback('msg-1', 'up');
    const seen: Array<AppPreferences> = [];
    store.subscribe(preferences => seen.push(preferences));

    store.setMessageFeedback('msg-1', null);

    expect(seen).toHaveLength(1);
    expect(selectMessageFeedbackFor(store.getState(), 'msg-1')).toBeNull();
  });

  test('repeating the current rating notifies nobody', () => {
    const store = createPreferencesStore();
    store.setMessageFeedback('msg-1', 'up');
    const seen: Array<AppPreferences> = [];
    store.subscribe(preferences => seen.push(preferences));

    store.setMessageFeedback('msg-1', 'up');

    expect(seen).toHaveLength(0);
  });

  test('survives a serialize and hydrate round-trip through the store', () => {
    const store = createPreferencesStore();
    store.setMessageFeedback('msg-1', 'down');
    const reloaded = createPreferencesStore();
    reloaded.hydrate(store.serialize());
    expect(selectMessageFeedbackFor(reloaded.getState(), 'msg-1')).toBe('down');
  });
});

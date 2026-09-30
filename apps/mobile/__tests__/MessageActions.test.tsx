import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

import { MessageList, type DisplayMessage } from '../src/components/MessageList';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import {
  createDefaultPreferences,
  createPreferencesStore,
} from '../src/preferences';
import type { MessageFeedbackRating } from '../src/preferences/types';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

function presentation(children: React.ReactNode) {
  const store = createPreferencesStore({
    initialPreferences: { ...createDefaultPreferences(), locale: 'en-US' },
  });
  return (
    <AppPresentationProvider store={store}>{children}</AppPresentationProvider>
  );
}

const userMessage: DisplayMessage = {
  id: 'u1',
  role: 'user',
  text: 'Why is the parser slow?',
};
const assistantMessage: DisplayMessage = {
  id: 'a1',
  role: 'assistant',
  text: 'Because it rescans the file.',
};

function renderList(
  props: Partial<React.ComponentProps<typeof MessageList>> = {},
  messages: DisplayMessage[] = [userMessage, assistantMessage],
) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    tree = ReactTestRenderer.create(
      presentation(<MessageList messages={messages} {...props} />),
    );
  });
  return tree;
}

const find = (tree: ReactTestRenderer.ReactTestRenderer, testID: string) =>
  tree.root.findAllByProps({ testID });

/**
 * React Native forwards a testID down to more than one host node, so a
 * control is present when anything matches and absent when nothing does.
 */
const has = (tree: ReactTestRenderer.ReactTestRenderer, testID: string) =>
  find(tree, testID).length > 0;

describe('per-message actions', () => {
  test('offers nothing at all when the surface passes no handlers', () => {
    const tree = renderList();
    expect(has(tree, 'message-copy-u1')).toBe(false);
    expect(has(tree, 'message-copy-a1')).toBe(false);
    expect(has(tree, 'message-feedback-up-a1')).toBe(false);
    expect(has(tree, 'message-feedback-down-a1')).toBe(false);
  });

  test('offers copy on both roles, worded for what is being copied', () => {
    const tree = renderList({ onCopyMessage: () => undefined });
    expect(has(tree, 'message-copy-u1')).toBe(true);
    expect(has(tree, 'message-copy-a1')).toBe(true);
    // The person's own prompt is just "Copy"; the reply is a "Copy response".
    expect(tree.root.findAllByProps({ children: 'Copy' }).length).toBeGreaterThan(0);
    expect(
      tree.root.findAllByProps({ children: 'Copy response' }).length,
    ).toBeGreaterThan(0);
  });

  test('copies the message it belongs to, and says so afterwards', () => {
    const copied: DisplayMessage[] = [];
    const tree = renderList({ onCopyMessage: message => copied.push(message) });
    act(() => {
      find(tree, 'message-copy-a1')[0].props.onPress();
    });
    expect(copied.map(message => message.id)).toEqual(['a1']);
    expect(
      tree.root.findAllByProps({ children: 'Copied' }).length,
    ).toBeGreaterThan(0);
  });

  test('rates only a reply, never the prompt', () => {
    const tree = renderList({ onFeedbackMessage: () => undefined });
    expect(has(tree, 'message-feedback-up-u1')).toBe(false);
    expect(has(tree, 'message-feedback-down-u1')).toBe(false);
    expect(has(tree, 'message-feedback-up-a1')).toBe(true);
    expect(has(tree, 'message-feedback-down-a1')).toBe(true);
  });

  test('leaves a rating, and clears it when the same one is pressed again', () => {
    const calls: Array<[string, MessageFeedbackRating | null]> = [];
    const tree = renderList({
      onFeedbackMessage: (id, rating) => calls.push([id, rating]),
      feedbackFor: () => null,
    });
    act(() => {
      find(tree, 'message-feedback-up-a1')[0].props.onPress();
    });
    expect(calls).toEqual([['a1', 'up']]);

    // Re-render as if that rating had landed, then press it again.
    const rated = renderList({
      onFeedbackMessage: (id, rating) => calls.push([id, rating]),
      feedbackFor: () => 'up',
    });
    act(() => {
      find(rated, 'message-feedback-up-a1')[0].props.onPress();
    });
    expect(calls[1]).toEqual(['a1', null]);
  });

  test('switches side rather than clearing when the other one is pressed', () => {
    const calls: Array<[string, MessageFeedbackRating | null]> = [];
    const tree = renderList({
      onFeedbackMessage: (id, rating) => calls.push([id, rating]),
      feedbackFor: () => 'up',
    });
    act(() => {
      find(tree, 'message-feedback-down-a1')[0].props.onPress();
    });
    expect(calls).toEqual([['a1', 'down']]);
  });

  test('shows which rating a message already carries', () => {
    const tree = renderList({
      onFeedbackMessage: () => undefined,
      feedbackFor: messageId => (messageId === 'a1' ? 'down' : null),
    });
    expect(
      find(tree, 'message-feedback-down-a1')[0].props.accessibilityState,
    ).toEqual({ selected: true });
    expect(
      find(tree, 'message-feedback-up-a1')[0].props.accessibilityState,
    ).toEqual({ selected: false });
  });

  test('marks the copied message, not every message', () => {
    const tree = renderList({ onCopyMessage: () => undefined });
    act(() => {
      find(tree, 'message-copy-u1')[0].props.onPress();
    });
    expect(find(tree, 'message-copy-u1')[0].props.accessibilityLabel).toBe(
      'Copied',
    );
    expect(find(tree, 'message-copy-a1')[0].props.accessibilityLabel).toBe(
      'Copy response',
    );
  });
});

describe('edit and regenerate', () => {
  test('offer nothing when the surface passes no handler', () => {
    const tree = renderList();
    expect(has(tree, 'message-edit-u1')).toBe(false);
    expect(has(tree, 'message-regenerate-a1')).toBe(false);
  });

  test('edit belongs to a prompt and regenerate to a reply', () => {
    const tree = renderList({
      onEditMessage: () => undefined,
      onRegenerateMessage: () => undefined,
    });
    expect(has(tree, 'message-edit-u1')).toBe(true);
    expect(has(tree, 'message-edit-a1')).toBe(false);
    expect(has(tree, 'message-regenerate-a1')).toBe(true);
    expect(has(tree, 'message-regenerate-u1')).toBe(false);
  });

  test('pressing edit hands over the prompt it belongs to', () => {
    const edited: DisplayMessage[] = [];
    const tree = renderList({ onEditMessage: message => edited.push(message) });
    act(() => {
      find(tree, 'message-edit-u1')[0].props.onPress();
    });
    expect(edited.map(message => message.id)).toEqual(['u1']);
    expect(edited[0].text).toBe('Why is the parser slow?');
  });

  test('pressing regenerate hands over the reply it belongs to', () => {
    const regenerated: DisplayMessage[] = [];
    const tree = renderList({
      onRegenerateMessage: message => regenerated.push(message),
    });
    act(() => {
      find(tree, 'message-regenerate-a1')[0].props.onPress();
    });
    expect(regenerated.map(message => message.id)).toEqual(['a1']);
  });

  test('a prompt cannot be regenerated and a reply cannot be edited', () => {
    const edited: DisplayMessage[] = [];
    const regenerated: DisplayMessage[] = [];
    const tree = renderList({
      onEditMessage: message => edited.push(message),
      onRegenerateMessage: message => regenerated.push(message),
    });
    // Both controls exist for their own role, so neither list can receive the
    // other role by accident.
    act(() => {
      find(tree, 'message-edit-u1')[0].props.onPress();
      find(tree, 'message-regenerate-a1')[0].props.onPress();
    });
    expect(edited.map(message => message.role)).toEqual(['user']);
    expect(regenerated.map(message => message.role)).toEqual(['assistant']);
  });
});

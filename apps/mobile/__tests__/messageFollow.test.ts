import { createMessageFollowController } from '../src/components/messageFollow';

const bottom = { offset: 1500, contentHeight: 2000, viewportHeight: 500 };
const history = { ...bottom, offset: 300 };

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function setup() {
  const scroll = jest.fn();
  const indicator = jest.fn();
  const follow = createMessageFollowController(scroll, indicator);
  return { scroll, indicator, follow };
}

test('initial load and bottom layout updates follow after layout, coalesced', () => {
  const { scroll, follow } = setup();
  follow.messagesChanged();
  follow.layoutChanged();
  follow.layoutChanged();
  jest.advanceTimersByTime(30);
  expect(scroll.mock.calls).toEqual([[false]]);
  follow.scrolled(bottom);
  follow.layoutChanged();
  // Growth must not be misclassified as the user scrolling up.
  follow.scrolled({ ...bottom, contentHeight: 2200 });
  jest.advanceTimersByTime(30);
  expect(scroll.mock.calls).toEqual([[false], [false]]);
  follow.dispose();
});

test('an upward gesture cancels a queued follow immediately', () => {
  const { scroll, follow } = setup();
  follow.messagesChanged();
  follow.dragStarted();
  follow.scrolled(history);
  follow.dragEnded(history);
  jest.advanceTimersByTime(100);
  expect(scroll).not.toHaveBeenCalled();
  follow.dispose();
});

test.each(['stream text', 'tool state', 'attachment layout'])(
  '%s does not move a reader in history',
  () => {
    const { scroll, indicator, follow } = setup();
    follow.scrolled(bottom);
    follow.dragStarted();
    follow.scrolled(history);
    follow.dragEnded(history);
    follow.messagesChanged();
    follow.layoutChanged();
    jest.advanceTimersByTime(100);
    expect(scroll).not.toHaveBeenCalled();
    expect(indicator).toHaveBeenLastCalledWith({
      visible: true,
      hasNewContent: true,
    });
    follow.dispose();
  },
);

test('an accessibility jump upward is respected without a drag-begin event', () => {
  const { scroll, indicator, follow } = setup();
  follow.scrolled(bottom);
  follow.layoutChanged();
  follow.scrolled(history);
  follow.messagesChanged();
  jest.advanceTimersByTime(100);
  expect(scroll).not.toHaveBeenCalled();
  expect(indicator).toHaveBeenLastCalledWith({
    visible: true,
    hasNewContent: true,
  });
  follow.dispose();
});

test('explicit jump hides the badge and resumes following without animation flicker', () => {
  const { scroll, indicator, follow } = setup();
  follow.dragStarted();
  follow.scrolled(history);
  follow.dragEnded(history);
  follow.messagesChanged();
  follow.jumpToLatest();
  expect(scroll).toHaveBeenLastCalledWith(true);
  expect(indicator).toHaveBeenLastCalledWith({
    visible: false,
    hasNewContent: false,
  });
  follow.momentumStarted();
  follow.scrolled({ ...bottom, offset: 800 });
  expect(indicator).toHaveBeenLastCalledWith({
    visible: false,
    hasNewContent: false,
  });
  follow.dragEnded(bottom);
  follow.messagesChanged();
  jest.advanceTimersByTime(30);
  expect(scroll).toHaveBeenLastCalledWith(false);
  follow.dispose();
});

test('returning within 72 points of the bottom resumes following', () => {
  const { scroll, follow } = setup();
  follow.dragStarted();
  follow.scrolled(history);
  follow.dragEnded(history);
  follow.dragStarted();
  follow.scrolled({ ...bottom, offset: 1430 });
  follow.dragEnded({ ...bottom, offset: 1430 });
  follow.layoutChanged();
  jest.advanceTimersByTime(30);
  expect(scroll).toHaveBeenCalledWith(false);
  follow.dispose();
});

test('user input interrupts an explicit jump and expiry cleanup cancels old work', () => {
  const { scroll, follow } = setup();
  follow.jumpToLatest();
  scroll.mockClear();
  follow.dragStarted();
  follow.scrolled(history);
  follow.dragEnded(history);
  follow.messagesChanged();
  jest.advanceTimersByTime(100);
  expect(scroll).not.toHaveBeenCalled();
  follow.jumpToLatest();
  follow.messagesChanged();
  scroll.mockClear();
  follow.dispose();
  jest.advanceTimersByTime(100);
  expect(scroll).not.toHaveBeenCalled();
});

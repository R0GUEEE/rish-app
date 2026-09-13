export type MessageViewport = {
  offset: number;
  contentHeight: number;
  viewportHeight: number;
};
export type MessageFollowIndicator = {
  visible: boolean;
  hasNewContent: boolean;
};

/** Follow layout updates only while the reader remains near the end. */
export function createMessageFollowController(
  scrollToEnd: (animated: boolean) => void,
  onIndicator: (state: MessageFollowIndicator) => void,
) {
  let following = true;
  let interacting = false;
  // A finger is down somewhere in the list. Any programmatic scroll while it
  // is down cancels that touch on iOS, which is how a tap on a link inside a
  // list that follows its end never became a press. Defer following until
  // the touch ends.
  let touching = false;
  let jumping = false;
  let disposed = false;
  let metrics: MessageViewport | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let indicator: MessageFollowIndicator = {
    visible: false,
    hasNewContent: false,
  };
  const emit = (visible: boolean, hasNewContent: boolean) => {
    if (
      disposed ||
      (visible === indicator.visible &&
        hasNewContent === indicator.hasNewContent)
    )
      return;
    indicator = { visible, hasNewContent };
    onIndicator(indicator);
  };
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pendingForce = false;
  };
  // True once the last known viewport already shows the end of the content;
  // following again from there only spins (each scrollToEnd fires a layout
  // event, which asked for another scrollToEnd, thirty times a second).
  const atEnd = () =>
    metrics !== null &&
    metrics.viewportHeight > 0 &&
    metrics.contentHeight - metrics.viewportHeight - metrics.offset <= 1;
  let pendingForce = false;
  const follow = (force: boolean) => {
    if (disposed || !following || interacting || touching) return;
    if (timer !== null) {
      // A forced follow (new message) must not be swallowed by a pending
      // layout-only follow that will decline at the end.
      pendingForce = pendingForce || force;
      return;
    }
    if (!force && atEnd()) return;
    pendingForce = force;
    timer = setTimeout(() => {
      timer = null;
      const forced = pendingForce;
      pendingForce = false;
      if (!disposed && following && !interacting && !touching && (forced || !atEnd())) {
        scrollToEnd(false);
      }
    }, 30);
  };
  const layoutChanged = (contentHeight?: number, viewportHeight?: number) => {
    if (metrics !== null) {
      if (typeof contentHeight === 'number' && contentHeight > 0) {
        metrics = { ...metrics, contentHeight };
      }
      if (typeof viewportHeight === 'number' && viewportHeight > 0) {
        metrics = { ...metrics, viewportHeight };
      }
    }
    follow(false);
  };
  const scrolled = (next: MessageViewport) => {
    if (disposed || next.viewportHeight <= 0) return;
    const previous = metrics;
    metrics = next;
    const near = next.contentHeight - next.viewportHeight - next.offset <= 72;
    const geometryChanged =
      previous !== null &&
      (previous.contentHeight !== next.contentHeight ||
        previous.viewportHeight !== next.viewportHeight);
    // Content growth can emit a scroll event before our follow completes.
    // Do not mistake that for an upward gesture. Actual upward movement wins.
    if (
      !interacting &&
      following &&
      (jumping || timer !== null || geometryChanged) &&
      (previous === null || next.offset >= previous.offset)
    ) {
      if (near) {
        jumping = false;
        emit(false, false);
      }
      if (!near) layoutChanged();
      return;
    }
    following = near;
    if (near) {
      jumping = false;
      emit(false, false);
    } else {
      cancel();
      jumping = false;
      emit(true, indicator.hasNewContent);
    }
  };
  const dragStarted = () => {
    interacting = true;
    following = false;
    jumping = false;
    cancel();
  };
  return {
    layoutChanged,
    scrolled,
    touchStarted: () => {
      touching = true;
      cancel();
    },
    touchEnded: () => {
      touching = false;
      if (following && !interacting) layoutChanged();
    },
    messagesChanged: () => {
      if (disposed) return;
      // A message change is a real change even before its layout lands.
      if (following && !interacting) follow(true);
      else emit(true, true);
    },
    dragStarted,
    momentumStarted: () => {
      if (!jumping) dragStarted();
    },
    dragEnded: (next: MessageViewport) => {
      interacting = false;
      scrolled(next);
      layoutChanged();
    },
    jumpToLatest: () => {
      if (disposed) return;
      cancel();
      interacting = false;
      following = true;
      jumping = true;
      emit(false, false);
      scrollToEnd(true);
    },
    dispose: () => {
      disposed = true;
      cancel();
    },
  };
}

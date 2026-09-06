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
  };
  const layoutChanged = () => {
    if (disposed || !following || interacting || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (!disposed && following && !interacting) scrollToEnd(false);
    }, 30);
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
    messagesChanged: () => {
      if (disposed) return;
      if (following && !interacting) layoutChanged();
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

import {
  WIDE_CONTENT_MAX_WIDTH,
  WIDE_LAYOUT_MIN_WIDTH,
  WIDE_SIDEBAR_WIDTH,
  resolveAdaptiveLayout,
} from '../src/layout/adaptive';

describe('adaptive layout', () => {
  it('keeps narrow windows on the mobile flow', () => {
    expect(resolveAdaptiveLayout(WIDE_LAYOUT_MIN_WIDTH - 1)).toEqual({
      isWide: false,
      sidebarWidth: WIDE_SIDEBAR_WIDTH,
      contentMaxWidth: WIDE_CONTENT_MAX_WIDTH,
    });
  });

  it('docks navigation and caps reading width for wide windows', () => {
    expect(resolveAdaptiveLayout(WIDE_LAYOUT_MIN_WIDTH)).toEqual({
      isWide: true,
      sidebarWidth: WIDE_SIDEBAR_WIDTH,
      contentMaxWidth: WIDE_CONTENT_MAX_WIDTH,
    });
  });
});

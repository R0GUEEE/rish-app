export const WIDE_LAYOUT_MIN_WIDTH = 900;
export const WIDE_SIDEBAR_WIDTH = 296;
export const WIDE_CONTENT_MAX_WIDTH = 1180;

export type AdaptiveLayout = {
  isWide: boolean;
  sidebarWidth: number;
  contentMaxWidth: number;
};

export function resolveAdaptiveLayout(width: number): AdaptiveLayout {
  const isWide = width >= WIDE_LAYOUT_MIN_WIDTH;
  return {
    isWide,
    sidebarWidth: WIDE_SIDEBAR_WIDTH,
    contentMaxWidth: WIDE_CONTENT_MAX_WIDTH,
  };
}

// The sessions panel's width and whether it is shown, kept in the WebView's localStorage between
// runs (agent86-web's scheme). Storage can be unavailable; the panel then just uses the defaults.

const KEY = "agent86.sidebar.v1";

export interface SidebarLayout {
  /** Pixels. */
  width: number;
  shown: boolean;
}

export const SIDEBAR_DEFAULT = 256;
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 560;

/** `width` kept within the panel's limits, in whole pixels. */
export function clampSidebar(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT;
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)));
}

/** The layout last saved, or the default (shown, 256 px). */
export function loadSidebar(): SidebarLayout {
  let saved: Partial<SidebarLayout> = {};
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") saved = parsed as Partial<SidebarLayout>;
  } catch {
    // Unreadable or unavailable: the defaults.
  }
  return {
    width: clampSidebar(typeof saved.width === "number" ? saved.width : SIDEBAR_DEFAULT),
    shown: saved.shown !== false,
  };
}

export function saveSidebar(layout: SidebarLayout): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    // Kept for this run only.
  }
}

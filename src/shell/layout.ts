// The sessions panel's width and whether it is shown, and the document pane's width, kept in the
// WebView's localStorage between runs (agent86-web's scheme). Storage can be unavailable; the
// panels then just use the defaults.

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

const DOCUMENT_KEY = "agent86.document-pane.v1";

/** The Markdown viewer's pane beside the transcript (pixels; CSS also caps it at 70%). */
export const DOCUMENT_DEFAULT = 480;
export const DOCUMENT_MIN = 300;
export const DOCUMENT_MAX = 960;

export function clampDocumentPane(width: number): number {
  if (!Number.isFinite(width)) return DOCUMENT_DEFAULT;
  return Math.round(Math.min(DOCUMENT_MAX, Math.max(DOCUMENT_MIN, width)));
}

/** The document pane's width last saved, or the default. */
export function loadDocumentPane(): number {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DOCUMENT_KEY) ?? "null");
    if (parsed && typeof parsed === "object" && "width" in parsed) {
      const { width } = parsed as { width: unknown };
      if (typeof width === "number") return clampDocumentPane(width);
    }
  } catch {
    // Unreadable or unavailable: the default.
  }
  return DOCUMENT_DEFAULT;
}

export function saveDocumentPane(width: number): void {
  try {
    window.localStorage.setItem(DOCUMENT_KEY, JSON.stringify({ width }));
  } catch {
    // Kept for this run only.
  }
}

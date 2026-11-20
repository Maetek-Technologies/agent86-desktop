// The app's colours: the system's, or always light or dark (Settings, Appearance). styles.css
// holds both palettes; `data-theme` on <html> picks one, and without it the system decides.
import type { Theme } from "../desktop-client/events.ts";

const KEY = "agent86.theme";

/** Show `theme` and remember it, so the next start shows it before the settings load. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    // Storage may be unavailable; the theme still applies for this run.
  }
}

/** The theme last shown, for the first paint. */
export function rememberedTheme(): Theme {
  try {
    const value = window.localStorage.getItem(KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // As above.
  }
  return "system";
}

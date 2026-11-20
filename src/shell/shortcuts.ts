// The app's keyboard shortcuts. They work anywhere in the window (they are not system-wide);
// "Mod" is Ctrl, or ⌘ on macOS.

export type Shortcut =
  | { type: "newThread" }
  | { type: "closeTab" }
  | { type: "nextTab" }
  | { type: "previousTab" }
  | { type: "tab"; index: number }
  | { type: "lastTab" }
  | { type: "focusPrompt" }
  | { type: "stopTurn" }
  | { type: "settings" };

/** The parts of a `KeyboardEvent` a shortcut depends on. */
export interface Keys {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** How a shortcut's modifier reads on this platform, for tooltips: "Ctrl+" or "⌘". */
export function modLabel(): string {
  return isMac() ? "⌘" : "Ctrl+";
}

/** The shortcut `keys` stands for, if any. */
export function shortcutFor(keys: Keys, mac: boolean): Shortcut | null {
  if (keys.altKey) return null;
  // Ctrl+Tab switches tabs on every platform, as in browsers.
  if (keys.ctrlKey && !keys.metaKey && keys.key === "Tab") {
    return { type: keys.shiftKey ? "previousTab" : "nextTab" };
  }
  const mod = mac ? keys.metaKey && !keys.ctrlKey : keys.ctrlKey && !keys.metaKey;
  if (!mod) return null;
  const key = keys.key.length === 1 ? keys.key.toLowerCase() : keys.key;
  if (keys.shiftKey) {
    // ⌘⇧] and ⌘⇧[ on macOS (the key reads "}" / "{" with Shift on US layouts).
    if (key === "]" || key === "}") return { type: "nextTab" };
    if (key === "[" || key === "{") return { type: "previousTab" };
    return null;
  }
  switch (key) {
    case "t":
    case "n":
      return { type: "newThread" };
    case "w":
      return { type: "closeTab" };
    case "PageDown":
      return { type: "nextTab" };
    case "PageUp":
      return { type: "previousTab" };
    case "l":
      return { type: "focusPrompt" };
    case ".":
      return { type: "stopTurn" };
    case ",":
      return { type: "settings" };
    case "9":
      return { type: "lastTab" };
  }
  if (/^[1-8]$/.test(key)) return { type: "tab", index: Number(key) - 1 };
  return null;
}

/** The shortcuts as Settings lists them. */
export function shortcutList(mac: boolean): { keys: string; action: string }[] {
  const mod = mac ? "⌘" : "Ctrl+";
  return [
    { keys: `${mod}T`, action: "New thread (choose a workspace)" },
    { keys: `${mod}W`, action: "Close tab" },
    {
      keys: mac ? "Ctrl+Tab, ⌘⇧]" : "Ctrl+Tab, Ctrl+PageDown",
      action: "Next tab",
    },
    {
      keys: mac ? "Ctrl+Shift+Tab, ⌘⇧[" : "Ctrl+Shift+Tab, Ctrl+PageUp",
      action: "Previous tab",
    },
    { keys: `${mod}1 … ${mod}8, ${mod}9`, action: "Go to tab 1 to 8, or the last" },
    { keys: `${mod}L`, action: "Focus the prompt" },
    { keys: `${mod}.`, action: "Stop the running turn" },
    { keys: `${mod},`, action: "Settings" },
  ];
}

/** The tab `shortcut` moves to among `keys`, from `active`; `null` when it does not move. */
export function tabTarget(
  shortcut: Shortcut,
  keys: string[],
  active: string | null,
): string | null {
  if (keys.length === 0) return null;
  const at = active ? keys.indexOf(active) : -1;
  switch (shortcut.type) {
    case "nextTab":
      return keys[(at + 1) % keys.length] ?? null;
    case "previousTab":
      return keys[(at - 1 + keys.length) % keys.length] ?? null;
    case "tab":
      return keys[shortcut.index] ?? null;
    case "lastTab":
      return keys[keys.length - 1] ?? null;
    default:
      return null;
  }
}

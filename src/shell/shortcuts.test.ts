import { expect, test } from "vitest";
import { shortcutFor, tabTarget, type Keys } from "./shortcuts.ts";

function keys(key: string, mods: Partial<Omit<Keys, "key">> = {}): Keys {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods };
}

test("Ctrl is the modifier on Windows and Linux, ⌘ on macOS", () => {
  expect(shortcutFor(keys("t", { ctrlKey: true }), false)).toEqual({ type: "newThread" });
  expect(shortcutFor(keys("t", { metaKey: true }), false)).toBeNull();
  expect(shortcutFor(keys("t", { metaKey: true }), true)).toEqual({ type: "newThread" });
  expect(shortcutFor(keys("t", { ctrlKey: true }), true)).toBeNull();
  // Caps Lock gives an upper-case key.
  expect(shortcutFor(keys("W", { ctrlKey: true }), false)).toEqual({ type: "closeTab" });
});

test("each action has its keys", () => {
  const ctrl = (key: string, shiftKey = false) =>
    shortcutFor(keys(key, { ctrlKey: true, shiftKey }), false);
  expect(ctrl("l")).toEqual({ type: "focusPrompt" });
  expect(ctrl(".")).toEqual({ type: "stopTurn" });
  expect(ctrl(",")).toEqual({ type: "settings" });
  expect(ctrl("b")).toEqual({ type: "toggleSidebar" });
  expect(ctrl("Tab")).toEqual({ type: "nextTab" });
  expect(ctrl("Tab", true)).toEqual({ type: "previousTab" });
  expect(ctrl("PageDown")).toEqual({ type: "nextTab" });
  expect(ctrl("PageUp")).toEqual({ type: "previousTab" });
  expect(ctrl("3")).toEqual({ type: "tab", index: 2 });
  expect(ctrl("9")).toEqual({ type: "lastTab" });
  // Ctrl+Tab works on macOS too; ⌘⇧] and ⌘⇧[ as well.
  expect(shortcutFor(keys("Tab", { ctrlKey: true }), true)).toEqual({ type: "nextTab" });
  expect(shortcutFor(keys("}", { metaKey: true, shiftKey: true }), true)).toEqual({
    type: "nextTab",
  });
  expect(shortcutFor(keys("[", { metaKey: true, shiftKey: true }), true)).toEqual({
    type: "previousTab",
  });
});

test("other keys, Alt, and typing are left alone", () => {
  expect(shortcutFor(keys("t"), false)).toBeNull();
  expect(shortcutFor(keys("c", { ctrlKey: true }), false)).toBeNull();
  expect(shortcutFor(keys("t", { ctrlKey: true, altKey: true }), false)).toBeNull();
  expect(shortcutFor(keys("t", { ctrlKey: true, shiftKey: true }), false)).toBeNull();
});

test("tab moves wrap around and stay in range", () => {
  const tabs = ["a", "b", "c"];
  expect(tabTarget({ type: "nextTab" }, tabs, "c")).toBe("a");
  expect(tabTarget({ type: "previousTab" }, tabs, "a")).toBe("c");
  expect(tabTarget({ type: "nextTab" }, tabs, null)).toBe("a");
  expect(tabTarget({ type: "tab", index: 1 }, tabs, "a")).toBe("b");
  expect(tabTarget({ type: "tab", index: 5 }, tabs, "a")).toBeNull();
  expect(tabTarget({ type: "lastTab" }, tabs, "a")).toBe("c");
  expect(tabTarget({ type: "nextTab" }, [], null)).toBeNull();
});

import { beforeEach, expect, test } from "vitest";
import { clampSidebar, loadSidebar, saveSidebar, SIDEBAR_DEFAULT } from "./layout.ts";

beforeEach(() => window.localStorage.clear());

test("widths stay within the panel's limits", () => {
  expect(clampSidebar(100)).toBe(180);
  expect(clampSidebar(1000)).toBe(560);
  expect(clampSidebar(300.6)).toBe(301);
  expect(clampSidebar(Number.NaN)).toBe(SIDEBAR_DEFAULT);
});

test("the layout is saved, and anything unreadable gives the defaults", () => {
  expect(loadSidebar()).toEqual({ width: 256, shown: true });
  saveSidebar({ width: 320, shown: false });
  expect(loadSidebar()).toEqual({ width: 320, shown: false });
  window.localStorage.setItem("agent86.sidebar.v1", "not json");
  expect(loadSidebar()).toEqual({ width: 256, shown: true });
  window.localStorage.setItem("agent86.sidebar.v1", JSON.stringify({ width: 9999 }));
  expect(loadSidebar()).toEqual({ width: 560, shown: true });
});

import { describe, expect, it } from "vitest";
import type { OpenedThread } from "../desktop-client/events.ts";
import { ago } from "./Sidebar.tsx";
import { folderName, NO_TABS, tabsReduce, type TabsAction, type TabsState } from "./tabs.ts";

function opened(threadId: string, history: OpenedThread["history"] = []): OpenedThread {
  return {
    threadId,
    workspace: "C:\\w",
    model: "m",
    contextWindow: 1000,
    capabilities: { skills: [], specialists: [], tools: [] },
    ownModel: false,
    sessionId: `s-${threadId}`,
    history,
    memoryNote: null,
    project: null,
    notes: [],
  };
}

function fold(...actions: TabsAction[]): TabsState {
  return actions.reduce(tabsReduce, NO_TABS);
}

describe("tabs", () => {
  it("opens a tab, activates it, and replays a reopened session's history", () => {
    const state = fold(
      { type: "opening", key: "a", workspace: "C:\\w", title: null },
      {
        type: "opened",
        key: "a",
        opened: opened("t1", [
          { kind: "user", text: "hi" },
          { kind: "tool", id: "c", name: "read_file", arguments: {}, output: null, ok: false },
        ]),
      },
    );
    expect(state.active).toBe("a");
    const entries = state.tabs[0]!.session.entries;
    expect(entries.map((e) => e.kind)).toEqual(["user", "tool"]);
    expect(entries[1]).toMatchObject({ status: "failed" });
  });

  it("routes a thread's events to its own tab", () => {
    const state = fold(
      { type: "opening", key: "a", workspace: "C:\\a", title: null },
      { type: "opening", key: "b", workspace: "C:\\b", title: null },
      { type: "thread", key: "a", action: { type: "agentText", text: "for a" } },
    );
    expect(state.tabs[0]!.session.entries).toHaveLength(1);
    expect(state.tabs[1]!.session.entries).toHaveLength(0);
    expect(state.active).toBe("b");
  });

  it("shows the neighbour when the active tab closes, and drops a tab that failed to open", () => {
    const three = fold(
      { type: "opening", key: "a", workspace: "C:\\a", title: null },
      { type: "opening", key: "b", workspace: "C:\\b", title: null },
      { type: "opening", key: "c", workspace: "C:\\c", title: null },
      { type: "activate", key: "b" },
    );
    expect(tabsReduce(three, { type: "close", key: "b" }).active).toBe("c");
    expect(tabsReduce(three, { type: "close", key: "a" }).active).toBe("b");
    const failed = tabsReduce(three, { type: "failed", key: "c" });
    expect(failed.tabs.map((t) => t.key)).toEqual(["a", "b"]);
    expect(tabsReduce(fold(), { type: "close", key: "x" })).toEqual(NO_TABS);
  });

  it("names folders and ages", () => {
    expect(folderName("C:\\code\\demo\\")).toBe("demo");
    expect(folderName("/home/u/x")).toBe("x");
    expect(ago(1000, 1030)).toBe("just now");
    expect(ago(1000, 1000 + 600)).toBe("10 min ago");
    expect(ago(1000, 1000 + 7200)).toBe("2 h ago");
    expect(ago(1000, 1000 + 90_000)).toBe("yesterday");
  });
});

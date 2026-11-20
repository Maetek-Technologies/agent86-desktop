import { describe, expect, it } from "vitest";
import type { DesktopEvent, SubagentUpdate } from "./events.ts";
import { initialState, reduce, type SessionState, type ToolEntry } from "./session-state.ts";

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.002,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function fold(...events: (DesktopEvent | { type: "local/prompt"; text: string })[]): SessionState {
  return events.reduce(reduce, initialState());
}

const sub = (card: string, update: SubagentUpdate, announced = true): DesktopEvent => ({
  type: "subagent",
  card,
  announced,
  update,
});

function tool(state: SessionState, id: string): ToolEntry {
  return state.entries.find((e): e is ToolEntry => e.kind === "tool" && e.toolCallId === id)!;
}

describe("sub-agents", () => {
  it("report on the delegate call's card: start, calls, nested runs, finish", () => {
    const state = fold(
      { type: "local/prompt", text: "go" },
      {
        type: "toolCall",
        id: "d1",
        name: "delegate",
        arguments: { agent: "reviewer", task: "check" },
        title: "delegate(...)",
      },
      sub("d1", { type: "started", run: 1, name: "reviewer", depth: 1, task: "check it" }),
      sub("d1", { type: "toolCall", id: "d1/1", name: "read_file", arguments: { path: "a.rs" } }),
      sub("d1", {
        type: "toolResult",
        id: "d1/1",
        name: "read_file",
        ok: true,
        output: "fn a() {}",
        truncated: false,
        error: null,
      }),
      sub("d1", { type: "started", run: 2, name: "explorer", depth: 2, task: "look" }),
      sub("d1", { type: "finished", run: 2, name: "explorer", depth: 2, ok: true, usage }),
      sub("d1", { type: "notice", text: " [agents] note \n" }),
      sub("d1", { type: "finished", run: 1, name: "reviewer", depth: 1, ok: true, usage }),
    );
    const activity = tool(state, "d1").subagent!;
    expect(activity.name).toBe("reviewer");
    expect(activity.task).toBe("check it");
    expect(activity.nested).toEqual(["explorer"]);
    expect(activity.calls).toEqual([
      {
        id: "d1/1",
        name: "read_file",
        arguments: { path: "a.rs" },
        status: "completed",
        output: "fn a() {}",
        truncated: false,
        error: null,
      },
    ]);
    expect(activity.notices).toEqual(["[agents] note"]);
    expect(activity.running).toBe(0);
    expect(activity.ok).toBe(true);
    expect(activity.usage?.costUsd).toBe(0.002);
    // The delegate call itself still ends with its own result.
    expect(tool(state, "d1").status).toBe("running");
  });

  it("give a /agent turn a card of its own, which its finish settles", () => {
    const state = fold(
      { type: "local/prompt", text: "/agent explorer look" },
      sub("agent-1", { type: "started", run: 1, name: "explorer", depth: 1, task: "look" }, false),
      sub(
        "agent-1",
        { type: "finished", run: 1, name: "explorer", depth: 1, ok: false, usage },
        false,
      ),
    );
    const card = tool(state, "agent-1");
    expect(card.name).toBe("agent");
    expect(card.arguments).toEqual({ agent: "explorer", task: "look" });
    expect(card.status).toBe("failed");
    expect(card.subagent?.ok).toBe(false);
  });

  it("are dropped when their card is unknown, and leave nothing spinning when a turn ends", () => {
    let state = fold(sub("nope", { type: "notice", text: "x" }));
    expect(state.entries).toEqual([]);
    state = fold(
      { type: "local/prompt", text: "go" },
      { type: "toolCall", id: "d1", name: "delegate", arguments: {}, title: "delegate" },
      sub("d1", { type: "started", run: 1, name: "a", depth: 1, task: "t" }),
      sub("d1", { type: "toolCall", id: "d1/1", name: "run_command", arguments: {} }),
      { type: "turnFailed", error: "boom" },
    );
    const card = tool(state, "d1");
    expect(card.status).toBe("failed");
    expect(card.subagent?.calls[0]?.status).toBe("failed");
    expect(card.subagent?.running).toBe(0);
  });
});

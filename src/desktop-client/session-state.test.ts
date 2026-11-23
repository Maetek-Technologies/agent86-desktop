import { describe, expect, it } from "vitest";
import type { DesktopEvent, UsageInfo } from "./events.ts";
import { initialState, reduce, type LocalAction, type SessionState } from "./session-state.ts";

const usage: UsageInfo = {
  inputTokens: 10,
  outputTokens: 5,
  costUsd: 0.001,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function fold(...actions: (DesktopEvent | LocalAction)[]): SessionState {
  return actions.reduce(reduce, initialState());
}

describe("session state", () => {
  it("joins streamed text into one entry and ends the turn", () => {
    const state = fold(
      { type: "local/prompt", text: "hi" },
      { type: "thought", text: "thinking " },
      { type: "thought", text: "more" },
      { type: "agentText", text: "Hel" },
      { type: "agentText", text: "lo" },
      { type: "turnEnded", stopReason: "end_turn", answer: "Hello", turn: null, usage },
    );
    expect(state.entries.map((e) => [e.kind, "text" in e ? e.text : ""])).toEqual([
      ["user", "hi"],
      ["thought", "thinking more"],
      ["agent", "Hello"],
    ]);
    expect(state.running).toBe(false);
    expect(state.usage).toEqual(usage);
  });

  it("starts a new text entry after a tool call", () => {
    const state = fold(
      { type: "agentText", text: "Let me look." },
      {
        type: "toolCall",
        id: "c1",
        name: "list_dir",
        arguments: { path: "." },
        title: "list_dir(.)",
      },
      { type: "agentText", text: "Found it." },
    );
    expect(state.entries.map((e) => e.kind)).toEqual(["agent", "tool", "agent"]);
  });

  it("completes a tool card from its result, matched by id", () => {
    const state = fold(
      { type: "toolCall", id: "c1", name: "read_file", arguments: {}, title: "read_file(a)" },
      { type: "toolCall", id: "c2", name: "write_file", arguments: {}, title: "write_file(b)" },
      {
        type: "toolResult",
        id: "c2",
        name: "write_file",
        ok: false,
        output: "",
        truncated: false,
        error: "declined",
        summary: "write_file -> declined",
      },
      {
        type: "toolResult",
        id: "c1",
        name: "read_file",
        ok: true,
        output: "text",
        truncated: false,
        error: null,
        summary: "read_file -> 1 line",
      },
    );
    const tools = state.entries.filter((e) => e.kind === "tool");
    expect(tools.map((t) => [t.toolCallId, t.status])).toEqual([
      ["c1", "completed"],
      ["c2", "failed"],
    ]);
  });

  it("settles a running tool card when the turn is cancelled", () => {
    const state = fold(
      { type: "local/prompt", text: "go" },
      { type: "toolCall", id: "c1", name: "run_command", arguments: {}, title: "run_command" },
      { type: "local/cancelling" },
      { type: "turnEnded", stopReason: "cancelled", answer: "", turn: null, usage },
    );
    const tool = state.entries.find((e) => e.kind === "tool");
    expect(tool?.status).toBe("failed");
    expect(state.running).toBe(false);
    expect(state.cancelling).toBe(false);
  });

  it("shows a failed turn as an error and frees the input", () => {
    const state = fold(
      { type: "local/prompt", text: "go" },
      { type: "turnFailed", error: "model unreachable" },
    );
    expect(state.entries.at(-1)).toMatchObject({ kind: "error", text: "model unreachable" });
    expect(state.running).toBe(false);
  });

  it("does not start an entry with whitespace alone", () => {
    const state = fold(
      { type: "thought", text: "plan" },
      { type: "agentText", text: "\n\n" },
      { type: "toolCall", id: "c1", name: "list_dir", arguments: {}, title: "list_dir(.)" },
      { type: "agentText", text: "\n\n" },
      { type: "agentText", text: "Done" },
    );
    expect(state.entries.map((e) => e.kind)).toEqual(["thought", "tool", "agent"]);
    expect(state.entries.at(-1)).toMatchObject({ text: "Done" });
  });

  it("adds a summary line for a finished turn and keeps the last step's usage", () => {
    const turn = {
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0,
      steps: 2,
      toolCalls: 1,
      durationS: 1.5,
    };
    const state = fold(
      { type: "local/prompt", text: "go" },
      { type: "usage", step: usage, session: usage },
      { type: "turnEnded", stopReason: "end_turn", answer: "", turn, usage },
    );
    expect(state.entries.at(-1)).toEqual({ kind: "turnSummary", id: 2, turn, cancelled: false });
    expect(state.lastStep).toEqual(usage);
  });

  it("shows a list the app made itself", () => {
    const state = fold({ type: "local/list", title: "/skills (1)", items: ["greet"] });
    expect(state.entries).toEqual([
      { kind: "list", id: 1, title: "/skills (1)", items: ["greet"] },
    ]);
  });

  it("ignores cancelling when no turn runs", () => {
    expect(fold({ type: "local/cancelling" }).cancelling).toBe(false);
  });

  it("runs a surface action as the user's next message, and notes a dropped one", () => {
    const action = {
      name: "submit",
      surfaceId: "form",
      sourceComponentId: "ok",
      timestamp: "2026-11-22T10:00:00Z",
      context: { name: "Ada" },
    };
    const started = fold({ type: "uiActionStarted", action });
    expect(started.running).toBe(true);
    expect(started.entries).toEqual([
      { kind: "user", id: 1, text: '[ui action] submit on form: {"name":"Ada"}' },
    ]);
    const dropped = fold({ type: "uiActionDropped", action });
    expect(dropped.running).toBe(false);
    expect(dropped.entries).toEqual([
      { kind: "notice", id: 1, text: "Not sent, because the turn was stopped: submit on form." },
    ]);
  });
});

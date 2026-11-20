import { describe, expect, it } from "vitest";
import type { ApprovalInfo, DesktopEvent, UsageInfo } from "./events.ts";
import { initialState, reduce, type LocalAction, type SessionState } from "./session-state.ts";

const usage: UsageInfo = {
  inputTokens: 1,
  outputTokens: 1,
  costUsd: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

const preview: ApprovalInfo = {
  summary: '{"path": "a.txt", "content": "hi"}',
  detail: null,
  lexer: null,
  warning: null,
  full: false,
  change: { path: "/w/a.txt", oldText: null, newText: "hi", line: 1 },
  asker: null,
};

function fold(...actions: (DesktopEvent | LocalAction)[]): SessionState {
  return actions.reduce(reduce, initialState());
}

const call: DesktopEvent = {
  type: "toolCall",
  id: "c1",
  name: "write_file",
  arguments: { path: "a.txt" },
  title: "write_file(a.txt)",
};

describe("questions", () => {
  it("opens an approval and marks the waiting tool card", () => {
    const state = fold({ type: "local/prompt", text: "go" }, call, {
      type: "approvalRequest",
      qid: 1,
      tool: "write_file",
      preview,
    });
    expect(state.questions).toEqual([{ kind: "approval", qid: 1, tool: "write_file", preview }]);
    expect(state.entries.find((e) => e.kind === "tool")).toMatchObject({ approvalQid: 1 });
  });

  it("closes the question and unmarks the card", () => {
    const state = fold(
      call,
      { type: "approvalRequest", qid: 1, tool: "write_file", preview },
      { type: "questionClosed", qid: 1, answered: true },
    );
    expect(state.questions).toEqual([]);
    const tool = state.entries.find((e) => e.kind === "tool");
    expect(tool && "approvalQid" in tool ? tool.approvalQid : undefined).toBeUndefined();
  });

  it("keeps limit and secret questions until they close", () => {
    const state = fold(
      {
        type: "limitRequest",
        qid: 2,
        limit: {
          kind: "steps",
          headline: "Step budget reached (40 steps)",
          agent: null,
          current: 40,
          offers: [80, 160],
          runOnly: false,
        },
      },
      {
        type: "secretRequest",
        qid: 3,
        name: "TOKEN",
        reason: "api",
        replacing: false,
        canRemember: true,
      },
      { type: "questionClosed", qid: 2, answered: true },
    );
    expect(state.questions.map((q) => [q.kind, q.qid])).toEqual([["secret", 3]]);
  });

  it("drops every open question when the turn ends", () => {
    const state = fold(
      { type: "local/prompt", text: "go" },
      { type: "approvalRequest", qid: 1, tool: "write_file", preview },
      { type: "turnEnded", stopReason: "cancelled", answer: "", turn: null, usage },
    );
    expect(state.questions).toEqual([]);
  });

  it("shows a refused answer without ending the turn", () => {
    const state = fold(
      { type: "local/prompt", text: "go" },
      { type: "local/warning", text: "Question 9 is not open" },
    );
    expect(state.running).toBe(true);
    expect(state.entries.at(-1)).toMatchObject({ kind: "error" });
  });
});

import { expect, test } from "vitest";
import type { DesktopEvent } from "../desktop-client/events.ts";
import { duration, notificationFor } from "./notify.ts";

const approval: DesktopEvent = {
  type: "approvalRequest",
  qid: 1,
  tool: "write_file",
  preview: {
    summary: "{}",
    detail: null,
    lexer: null,
    warning: null,
    full: false,
    change: null,
    asker: null,
  },
};

const ended = (stopReason: "end_turn" | "cancelled"): DesktopEvent => ({
  type: "turnEnded",
  stopReason,
  answer: "Done.\n\nThe parser   now handles empty files.",
  turn: null,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
});

test("nothing is said about the tab in front of a focused window", () => {
  expect(notificationFor(approval, { tab: "web", background: false, turnSeconds: 99 })).toBeNull();
});

test("a waiting question is always worth a notification in the background", () => {
  expect(notificationFor(approval, { tab: "web", background: true, turnSeconds: 1 })).toEqual({
    title: "Approval needed",
    body: "web: The agent wants to run write_file.",
  });
  const secret: DesktopEvent = {
    type: "secretRequest",
    qid: 2,
    name: "GITHUB_TOKEN",
    reason: "push",
    replacing: false,
    canRemember: true,
  };
  expect(notificationFor(secret, { tab: "web", background: true, turnSeconds: null })?.body).toBe(
    "web: the agent asks for GITHUB_TOKEN.",
  );
});

test("the agent's questions, or a surface it waits on, notify too", () => {
  const context = { tab: "web", background: true, turnSeconds: null };
  const asks: DesktopEvent = { type: "uiWaitRequest", qid: 3, surfaceIds: ["agent86_ask_1"] };
  expect(notificationFor(asks, context)).toEqual({
    title: "Questions from the agent",
    body: "web: the agent has questions for you.",
  });
  const waits: DesktopEvent = { type: "uiWaitRequest", qid: 4, surfaceIds: ["form"] };
  expect(notificationFor(waits, context)?.title).toBe("Answer needed");
});

test("only a long turn's end is announced, and not a cancelled one", () => {
  const context = { tab: "web", background: true };
  expect(notificationFor(ended("end_turn"), { ...context, turnSeconds: 5 })).toBeNull();
  expect(notificationFor(ended("end_turn"), { ...context, turnSeconds: null })).toBeNull();
  expect(notificationFor(ended("cancelled"), { ...context, turnSeconds: 300 })).toBeNull();
  expect(notificationFor(ended("end_turn"), { ...context, turnSeconds: 95 })).toEqual({
    title: "Turn finished",
    body: "web, after 1m 35s.\nDone. The parser now handles empty files.",
  });
  const failed: DesktopEvent = { type: "turnFailed", error: "model unreachable" };
  expect(notificationFor(failed, { ...context, turnSeconds: 40 })?.title).toBe("Turn failed");
  // Streamed text never notifies.
  expect(
    notificationFor({ type: "agentText", text: "hi" }, { ...context, turnSeconds: 999 }),
  ).toBeNull();
});

test("durations read short", () => {
  expect(duration(12.4)).toBe("12s");
  expect(duration(95)).toBe("1m 35s");
  expect(duration(3725)).toBe("1h 2m");
});

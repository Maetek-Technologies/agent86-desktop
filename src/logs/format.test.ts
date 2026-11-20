import { expect, test } from "vitest";
import type { ActivityEvent } from "../desktop-client/events.ts";
import {
  clock,
  eventMatches,
  isProblem,
  lineMatches,
  matchesFilter,
  money,
  summarize,
  totals,
} from "./format.ts";

const event = (kind: string, fields: Record<string, unknown>): ActivityEvent => ({
  ts: 1_763_625_121,
  session: "s1",
  kind,
  fields,
});

const model = event("model_call", {
  model: "qwen",
  input_tokens: 12000,
  output_tokens: 340,
  cost_usd: 0.0123,
  stop_reason: "tool_use",
  tool_calls: ["read_file", "edit_file"],
});
const failedTool = event("tool_call", {
  tool: "run_command",
  ok: false,
  arguments: { command: "make" },
  error: "exit 2",
});

test("each kind of event reads as one line", () => {
  expect(summarize(event("turn_start", { task: "fix the parser" }))).toBe("fix the parser");
  expect(summarize(event("turn_end", { status: "done", steps: 3, continuations: 0 }))).toBe(
    "done · 3 steps",
  );
  expect(summarize(event("turn_end", { status: "error", reason: "limit" }))).toBe("error · limit");
  expect(summarize(model)).toBe(
    `qwen · ${(12000).toLocaleString()} in / 340 out · $0.0123 · tool_use · → read_file, edit_file`,
  );
  expect(summarize(failedTool)).toBe('run_command ✗ {"command":"make"} — exit 2');
  expect(summarize(event("guardrail", { stage: "ingress_input", findings: "secret" }))).toBe(
    "ingress_input: secret",
  );
  expect(summarize(event("compaction", {}))).toBe("");
});

test("problems are failed calls, guardrails, empty answers, and unfinished turns", () => {
  expect(isProblem(failedTool)).toBe(true);
  expect(isProblem(event("tool_call", { tool: "x", ok: true }))).toBe(false);
  expect(isProblem(event("guardrail", {}))).toBe(true);
  expect(isProblem(event("turn_end", { status: "done" }))).toBe(false);
  expect(isProblem(event("turn_end", { status: "error" }))).toBe(true);
  expect(isProblem(model)).toBe(false);
});

test("filters pick their kinds", () => {
  expect(matchesFilter(model, "models")).toBe(true);
  expect(matchesFilter(model, "tools")).toBe(false);
  expect(matchesFilter(failedTool, "tools")).toBe(true);
  expect(matchesFilter(failedTool, "problems")).toBe(true);
  expect(matchesFilter(event("turn_start", {}), "turns")).toBe(true);
  expect(matchesFilter(event("route", {}), "all")).toBe(true);
});

test("totals add up the model calls", () => {
  expect(totals([model, model, failedTool])).toEqual({
    calls: 2,
    input: 24000,
    output: 680,
    cost: 0.0246,
  });
  expect(money(0)).toBe("$0");
  expect(money(0.00042)).toBe("$0.00042");
});

test("search looks at the kind, session, and fields", () => {
  expect(eventMatches(failedTool, "MAKE")).toBe(true);
  expect(eventMatches(failedTool, "s1")).toBe(true);
  expect(eventMatches(failedTool, "nothing")).toBe(false);
  const line = {
    time: "t",
    level: "INFO",
    target: "agent86_desktop_lib",
    message: "Thread t1 opened",
  };
  expect(lineMatches(line, "opened", false)).toBe(true);
  expect(lineMatches(line, "", true)).toBe(false);
  expect(lineMatches({ ...line, level: "WARN" }, "", true)).toBe(true);
});

test("times show the date only when not today", () => {
  const ts = new Date(2026, 10, 20, 7, 52, 1).getTime() / 1000;
  expect(clock(ts, new Date(2026, 10, 20, 12))).not.toContain("2026");
  expect(clock(ts, new Date(2026, 10, 21, 12))).toMatch(/2026|11|20/);
});

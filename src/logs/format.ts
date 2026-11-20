// Reading agent86's activity log (its flight recorder) for people: a one-line summary per event,
// which events count as problems, and the filters the Logs view offers.
import type { ActivityEvent, LogLine } from "../desktop-client/events.ts";

export type ActivityFilter = "all" | "turns" | "models" | "tools" | "problems";

export const ACTIVITY_FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "turns", label: "Turns" },
  { value: "models", label: "Model calls" },
  { value: "tools", label: "Tool calls" },
  { value: "problems", label: "Problems" },
];

const str = (value: unknown): string =>
  typeof value === "string"
    ? value
    : value === undefined || value === null
      ? ""
      : JSON.stringify(value);
const num = (value: unknown): number => (typeof value === "number" ? value : 0);

/** Something went wrong or was stopped: a failed call, a guardrail, an error, an empty answer. */
export function isProblem(event: ActivityEvent): boolean {
  const f = event.fields;
  switch (event.kind) {
    case "guardrail":
    case "empty_answer":
      return true;
    case "tool_call":
      return f.ok === false;
    case "turn_end":
      return f.status !== "done";
    default:
      return false;
  }
}

export function matchesFilter(event: ActivityEvent, filter: ActivityFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "turns":
      return event.kind === "turn_start" || event.kind === "turn_end";
    case "models":
      return event.kind === "model_call" || event.kind === "route";
    case "tools":
      return event.kind === "tool_call" || event.kind === "tool_args_repaired";
    case "problems":
      return isProblem(event);
  }
}

/** `$0.0123`, with more digits for tiny amounts. */
export function money(usd: number): string {
  if (usd === 0) return "$0";
  return usd < 0.01 ? `$${usd.toFixed(5)}` : `$${usd.toFixed(4)}`;
}

/** One line saying what the event was. */
export function summarize(event: ActivityEvent): string {
  const f = event.fields;
  switch (event.kind) {
    case "turn_start":
      return str(f.task);
    case "turn_end": {
      const parts = [str(f.status)];
      if (f.steps !== undefined) parts.push(`${num(f.steps)} steps`);
      if (num(f.continuations) > 0) parts.push(`${num(f.continuations)} continuations`);
      if (f.reason) parts.push(str(f.reason));
      return parts.join(" · ");
    }
    case "model_call": {
      const parts = [
        str(f.model),
        `${num(f.input_tokens).toLocaleString()} in / ${num(f.output_tokens).toLocaleString()} out`,
        money(num(f.cost_usd)),
      ];
      if (f.stop_reason) parts.push(str(f.stop_reason));
      const tools = Array.isArray(f.tool_calls) ? (f.tool_calls as unknown[]).map(str) : [];
      if (tools.length) parts.push(`→ ${tools.join(", ")}`);
      return parts.join(" · ");
    }
    case "tool_call": {
      const args =
        f.arguments && typeof f.arguments === "object" ? JSON.stringify(f.arguments) : "";
      const shown = args.length > 120 ? `${args.slice(0, 119)}…` : args;
      const error = f.error ? ` — ${str(f.error)}` : "";
      return `${str(f.tool)} ${f.ok === false ? "✗" : "✓"} ${shown}${error}`;
    }
    case "guardrail":
      return `${str(f.stage)}: ${str(f.findings)}`;
    case "route":
      return `routed to ${str(f.model)}`;
    default: {
      const rest = JSON.stringify(f);
      return rest === "{}" ? "" : rest.length > 160 ? `${rest.slice(0, 159)}…` : rest;
    }
  }
}

/** What the shown events cost and used, from their model calls. */
export function totals(events: ActivityEvent[]): {
  calls: number;
  input: number;
  output: number;
  cost: number;
} {
  let calls = 0;
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const event of events) {
    if (event.kind !== "model_call") continue;
    calls += 1;
    input += num(event.fields.input_tokens);
    output += num(event.fields.output_tokens);
    cost += num(event.fields.cost_usd);
  }
  return { calls, input, output, cost };
}

/** `ts` (seconds since 1970) as local `HH:MM:SS`, with the date when it is not today. */
export function clock(ts: number, now = new Date()): string {
  const date = new Date(ts * 1000);
  const time = date.toLocaleTimeString([], { hour12: false });
  return date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString()} ${time}`;
}

/** Whether `text` appears in the event (its kind, session, summary, or fields), ignoring case. */
export function eventMatches(event: ActivityEvent, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  return `${event.kind} ${event.session} ${JSON.stringify(event.fields)}`
    .toLowerCase()
    .includes(needle);
}

export function lineMatches(line: LogLine, text: string, problemsOnly: boolean): boolean {
  if (problemsOnly && line.level !== "WARN" && line.level !== "ERROR") return false;
  const needle = text.trim().toLowerCase();
  return !needle || `${line.target} ${line.message}`.toLowerCase().includes(needle);
}

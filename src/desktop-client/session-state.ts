// A thread's transcript as plain state, and the pure function that folds Rust's events into it.
// React renders this; tests assert on it without a DOM. The entry shapes follow agent86-web's
// acp-client session state so its components can be ported in M3.
import type { DesktopEvent, TurnInfo, UsageInfo } from "./events.ts";

export interface UserEntry {
  kind: "user";
  id: number;
  text: string;
}

export interface AgentEntry {
  kind: "agent";
  id: number;
  text: string;
}

export interface ThoughtEntry {
  kind: "thought";
  id: number;
  text: string;
}

export interface NoticeEntry {
  kind: "notice";
  id: number;
  text: string;
}

export interface ErrorEntry {
  kind: "error";
  id: number;
  text: string;
}

export type ToolStatus = "running" | "completed" | "failed";

export interface ToolEntry {
  kind: "tool";
  id: number;
  toolCallId: string;
  name: string;
  title: string;
  arguments: Record<string, unknown>;
  status: ToolStatus;
  summary?: string;
  output?: string;
  truncated?: boolean;
  error?: string | null;
}

export type Entry = UserEntry | AgentEntry | ThoughtEntry | NoticeEntry | ErrorEntry | ToolEntry;

export interface SessionState {
  entries: Entry[];
  /** A turn is running: the input waits and Stop is offered. */
  running: boolean;
  /** Stop was pressed and the turn has not ended yet. */
  cancelling: boolean;
  /** The session's usage so far. */
  usage: UsageInfo | null;
  lastTurn: TurnInfo | null;
  nextId: number;
}

export function initialState(): SessionState {
  return {
    entries: [],
    running: false,
    cancelling: false,
    usage: null,
    lastTurn: null,
    nextId: 1,
  };
}

/** What the UI itself does to the state, beside the events Rust sends. */
export type LocalAction =
  | { type: "local/prompt"; text: string }
  | { type: "local/cancelling" }
  | { type: "local/error"; text: string }
  | { type: "local/reset" };

export function reduce(state: SessionState, action: DesktopEvent | LocalAction): SessionState {
  switch (action.type) {
    case "local/reset":
      return initialState();
    case "local/prompt":
      return push({ ...state, running: true, cancelling: false }, (id) => ({
        kind: "user",
        id,
        text: action.text,
      }));
    case "local/cancelling":
      return state.running ? { ...state, cancelling: true } : state;
    case "local/error":
      return push({ ...state, running: false, cancelling: false }, (id) => ({
        kind: "error",
        id,
        text: action.text,
      }));
    case "agentText":
      return appendText(state, "agent", action.text);
    case "thought":
      return appendText(state, "thought", action.text);
    case "notice":
      return push(state, (id) => ({ kind: "notice", id, text: action.text.trim() }));
    case "compacted":
      return push(state, (id) => ({ kind: "notice", id, text: action.notice.trim() }));
    case "toolCall":
      return push(state, (id) => ({
        kind: "tool",
        id,
        toolCallId: action.id,
        name: action.name,
        title: action.title,
        arguments: action.arguments,
        status: "running",
      }));
    case "toolResult":
      return {
        ...state,
        entries: state.entries.map((entry) =>
          entry.kind === "tool" && entry.toolCallId === action.id
            ? {
                ...entry,
                status: action.ok ? "completed" : "failed",
                summary: action.summary,
                output: action.output,
                truncated: action.truncated,
                error: action.error,
              }
            : entry,
        ),
      };
    case "usage":
      return { ...state, usage: action.session };
    case "turnEnded":
      return {
        ...settleTools(state),
        running: false,
        cancelling: false,
        usage: action.usage,
        lastTurn: action.turn,
      };
    case "turnFailed":
      return push({ ...settleTools(state), running: false, cancelling: false }, (id) => ({
        kind: "error",
        id,
        text: action.error,
      }));
  }
}

function push(state: SessionState, make: (id: number) => Entry): SessionState {
  return {
    ...state,
    entries: [...state.entries, make(state.nextId)],
    nextId: state.nextId + 1,
  };
}

/** Streamed text joins the last entry when it is of the same kind, else starts a new one. */
function appendText(state: SessionState, kind: "agent" | "thought", text: string): SessionState {
  const last = state.entries.at(-1);
  if (last && last.kind === kind) {
    const entries = state.entries.slice(0, -1);
    entries.push({ ...last, text: last.text + text });
    return { ...state, entries };
  }
  // Models often stream a bare "\n\n" before a tool call; it would only make an empty bubble.
  if (!text.trim()) return state;
  return push(state, (id) => ({ kind, id, text }));
}

/** A turn that ended (or was cancelled) leaves no tool card spinning. */
function settleTools(state: SessionState): SessionState {
  if (!state.entries.some((e) => e.kind === "tool" && e.status === "running")) return state;
  return {
    ...state,
    entries: state.entries.map((entry) =>
      entry.kind === "tool" && entry.status === "running"
        ? { ...entry, status: "failed", error: entry.error ?? "did not finish" }
        : entry,
    ),
  };
}

// A thread's transcript as plain state, and the pure function that folds Rust's events into it.
// React renders this; tests assert on it without a DOM. The entry shapes follow agent86-web's
// acp-client session state so its components can be ported in M3.
import type {
  ApprovalInfo,
  DesktopEvent,
  HistoryItem,
  LimitInfo,
  SubagentUpdate,
  TurnInfo,
  UsageInfo,
} from "./events.ts";

/** A file change shown as a diff: the whole file before (`null` when new) and after. */
export interface FileDiff {
  path: string;
  oldText: string | null;
  newText: string;
}

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
  /** The approval question this call waits on, while it waits. */
  approvalQid?: number;
  /** What the sub-agent this call started is doing (a `delegate` call, or a `/agent` turn). */
  subagent?: SubagentActivity;
}

/** One call a sub-agent made. */
export interface SubCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: ToolStatus;
  output?: string;
  truncated?: boolean;
  error?: string | null;
}

/** A delegation as its sub-agents report it: the top-level run, and everything nested in it. */
export interface SubagentActivity {
  /** The specialist or role of the top-level run. */
  name: string;
  task: string;
  depth: number;
  /** Runs started on this card and not finished yet (nested ones included). */
  running: number;
  /** How the top-level run ended; `null` while it runs. */
  ok: boolean | null;
  /** Specialists it delegated to in turn. */
  nested: string[];
  calls: SubCall[];
  notices: string[];
  /** What the top-level run (and everything under it) used, once it finished. */
  usage: UsageInfo | null;
}

/** A list the app shows itself (`/tools`, `/skills`, `/agents`). */
export interface ListEntry {
  kind: "list";
  id: number;
  title: string;
  items: string[];
}

/** What a finished turn used: steps, tool calls, tokens, cost, time. */
export interface TurnSummaryEntry {
  kind: "turnSummary";
  id: number;
  turn: TurnInfo;
  cancelled: boolean;
}

export type Entry =
  | UserEntry
  | AgentEntry
  | ThoughtEntry
  | NoticeEntry
  | ErrorEntry
  | ToolEntry
  | ListEntry
  | TurnSummaryEntry;

/** A question the running turn waits on. Rust closes it with `questionClosed`. */
export type Question =
  | { kind: "approval"; qid: number; tool: string; preview: ApprovalInfo }
  | { kind: "limit"; qid: number; limit: LimitInfo }
  | {
      kind: "secret";
      qid: number;
      name: string;
      reason: string;
      replacing: boolean;
      canRemember: boolean;
    };

export interface SessionState {
  entries: Entry[];
  /** A turn is running: the input waits and Stop is offered. */
  running: boolean;
  /** Stop was pressed and the turn has not ended yet. */
  cancelling: boolean;
  /** The session's usage so far. */
  usage: UsageInfo | null;
  /** The last model call's usage: its input tokens are how full the context is. */
  lastStep: UsageInfo | null;
  lastTurn: TurnInfo | null;
  /** Open questions, oldest first. agent86 asks one at a time, but the list keeps that honest. */
  questions: Question[];
  nextId: number;
}

export function initialState(): SessionState {
  return {
    entries: [],
    running: false,
    cancelling: false,
    usage: null,
    lastStep: null,
    lastTurn: null,
    questions: [],
    nextId: 1,
  };
}

/** What the UI itself does to the state, beside the events Rust sends. */
export type LocalAction =
  | { type: "local/prompt"; text: string }
  | { type: "local/cancelling" }
  | { type: "local/error"; text: string }
  /** A problem that does not end the turn, such as an answer Rust refused. */
  | { type: "local/warning"; text: string }
  /** Something the app did to the thread, such as a reload. */
  | { type: "local/notice"; text: string }
  | { type: "local/reset" }
  | { type: "local/list"; title: string; items: string[] }
  /** A reopened session's conversation, shown before anything new. */
  | { type: "local/history"; items: HistoryItem[] };

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
    case "local/history":
      return action.items.reduce(pushHistory, state);
    case "local/list":
      return push(state, (id) => ({ kind: "list", id, title: action.title, items: action.items }));
    case "local/warning":
      return push(state, (id) => ({ kind: "error", id, text: action.text }));
    case "local/notice":
      return push(state, (id) => ({ kind: "notice", id, text: action.text }));
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
    case "approvalRequest":
      return {
        ...markAwaiting(state, action.tool, action.qid),
        questions: [
          ...state.questions,
          { kind: "approval", qid: action.qid, tool: action.tool, preview: action.preview },
        ],
      };
    case "limitRequest":
      return {
        ...state,
        questions: [...state.questions, { kind: "limit", qid: action.qid, limit: action.limit }],
      };
    case "secretRequest":
      return {
        ...state,
        questions: [
          ...state.questions,
          {
            kind: "secret",
            qid: action.qid,
            name: action.name,
            reason: action.reason,
            replacing: action.replacing,
            canRemember: action.canRemember,
          },
        ],
      };
    case "questionClosed":
      return closeQuestion(state, action.qid);
    case "subagent":
      return subagent(state, action.card, action.announced, action.update);
    case "usage":
      return { ...state, usage: action.session, lastStep: action.step };
    case "turnEnded": {
      const turn = action.turn;
      const ended = turn
        ? push(state, (id) => ({
            kind: "turnSummary",
            id,
            turn,
            cancelled: action.stopReason === "cancelled",
          }))
        : state;
      return {
        ...settleTools(ended),
        running: false,
        cancelling: false,
        usage: action.usage,
        lastTurn: action.turn,
        questions: [],
      };
    }
    case "turnFailed":
      return push(
        { ...settleTools(state), running: false, cancelling: false, questions: [] },
        (id) => ({
          kind: "error",
          id,
          text: action.error,
        }),
      );
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

/** A turn that ended (or was cancelled) leaves no tool card, or sub-agent call, spinning. */
function settleTools(state: SessionState): SessionState {
  const spinning = (e: Entry) =>
    e.kind === "tool" &&
    (e.status === "running" || e.subagent?.calls.some((c) => c.status === "running"));
  if (!state.entries.some(spinning)) return state;
  return {
    ...state,
    entries: state.entries.map((entry) => {
      if (entry.kind !== "tool" || !spinning(entry)) return entry;
      const settled: ToolEntry =
        entry.status === "running"
          ? { ...entry, status: "failed", error: entry.error ?? "did not finish" }
          : entry;
      if (!settled.subagent) return settled;
      return {
        ...settled,
        subagent: {
          ...settled.subagent,
          running: 0,
          calls: settled.subagent.calls.map((c) =>
            c.status === "running" ? { ...c, status: "failed", error: "did not finish" } : c,
          ),
        },
      };
    }),
  };
}

/**
 * Fold a sub-agent's update into the card it reports on: the `delegate` call that started it, or,
 * for a `/agent` turn (`announced` false), a card of its own made when it starts.
 */
function subagent(
  state: SessionState,
  card: string,
  announced: boolean,
  update: SubagentUpdate,
): SessionState {
  let current = state;
  if (!current.entries.some((e) => e.kind === "tool" && e.toolCallId === card)) {
    if (announced || update.type !== "started") return state;
    current = push(current, (id) => ({
      kind: "tool",
      id,
      toolCallId: card,
      name: "agent",
      title: `agent ${update.name}`,
      arguments: { agent: update.name, task: update.task },
      status: "running",
    }));
  }
  return {
    ...current,
    entries: current.entries.map((entry) => {
      if (entry.kind !== "tool" || entry.toolCallId !== card) return entry;
      const activity = applySubagent(entry.subagent, update);
      const ended = !announced && update.type === "finished" && activity.ok !== null;
      return ended
        ? { ...entry, subagent: activity, status: activity.ok ? "completed" : "failed" }
        : { ...entry, subagent: activity };
    }),
  };
}

function applySubagent(
  activity: SubagentActivity | undefined,
  update: SubagentUpdate,
): SubagentActivity {
  if (update.type === "started") {
    if (!activity) {
      return {
        name: update.name,
        task: update.task,
        depth: update.depth,
        running: 1,
        ok: null,
        nested: [],
        calls: [],
        notices: [],
        usage: null,
      };
    }
    const nested =
      update.depth > activity.depth ? [...activity.nested, update.name] : activity.nested;
    return { ...activity, running: activity.running + 1, nested };
  }
  // An update for a run whose start was missed starts the record anyway.
  const base: SubagentActivity = activity ?? {
    name: update.type === "finished" ? update.name : "sub-agent",
    task: "",
    depth: update.type === "finished" ? update.depth : 1,
    running: 1,
    ok: null,
    nested: [],
    calls: [],
    notices: [],
    usage: null,
  };
  switch (update.type) {
    case "toolCall":
      return {
        ...base,
        calls: [
          ...base.calls,
          { id: update.id, name: update.name, arguments: update.arguments, status: "running" },
        ],
      };
    case "toolResult":
      return {
        ...base,
        calls: base.calls.map((c) =>
          c.id === update.id
            ? {
                ...c,
                status: update.ok ? "completed" : "failed",
                output: update.output,
                truncated: update.truncated,
                error: update.error,
              }
            : c,
        ),
      };
    case "notice":
      return { ...base, notices: [...base.notices, update.text.trim()] };
    case "finished": {
      const running = Math.max(0, base.running - 1);
      return update.depth <= base.depth
        ? { ...base, running, ok: update.ok, usage: update.usage }
        : { ...base, running };
    }
  }
}

/** The newest running call of `tool` now waits on approval `qid`. */
function markAwaiting(state: SessionState, tool: string, qid: number): SessionState {
  const index = state.entries.findLastIndex(
    (e) =>
      e.kind === "tool" && e.name === tool && e.status === "running" && e.approvalQid === undefined,
  );
  if (index < 0) return state;
  const entries = state.entries.slice();
  entries[index] = { ...(entries[index] as ToolEntry), approvalQid: qid };
  return { ...state, entries };
}

function closeQuestion(state: SessionState, qid: number): SessionState {
  return {
    ...state,
    questions: state.questions.filter((q) => q.qid !== qid),
    entries: state.entries.map((entry) =>
      entry.kind === "tool" && entry.approvalQid === qid
        ? { ...entry, approvalQid: undefined }
        : entry,
    ),
  };
}

function pushHistory(state: SessionState, item: HistoryItem): SessionState {
  switch (item.kind) {
    case "user":
      return push(state, (id) => ({ kind: "user", id, text: item.text }));
    case "agent":
      return push(state, (id) => ({ kind: "agent", id, text: item.text }));
    case "tool":
      return push(state, (id) => ({
        kind: "tool",
        id,
        toolCallId: item.id,
        name: item.name,
        title: item.name,
        arguments: item.arguments,
        status: item.ok ? "completed" : "failed",
        ...(item.output === null ? {} : { output: item.output }),
        ...(item.ok ? {} : { error: null }),
      }));
  }
}

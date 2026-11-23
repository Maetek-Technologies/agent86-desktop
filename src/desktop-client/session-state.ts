// A thread's transcript as plain state, and the pure function that folds Rust's events into it.
// React renders this; tests assert on it without a DOM. The entry shapes follow agent86-web's
// acp-client session state so its components can be ported in M3.
import { ASK_USER, askOutcome, isAskSurface, type AskOutcome } from "./ask.ts";
import type {
  ApprovalInfo,
  DesktopEvent,
  HistoryItem,
  LimitInfo,
  SubagentUpdate,
  TurnInfo,
  UiAction,
  UsageInfo,
} from "./events.ts";

/** The user message agent86 makes of a surface action: `[ui action] <name> on <surface>: <context>`
 * (its JSON spacing differs; the transcript shows this text as it is). */
export function uiActionText(action: UiAction): string {
  const text = `[ui action] ${action.name} on ${action.surfaceId}: ${JSON.stringify(action.context)}`;
  return action.userMessage ? `${text}\n${action.userMessage}` : text;
}

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

/** Where an agent86UI surface shows in the transcript: right after the call that created it (a
 * `render_ui` call, or an `ask_user` call whose form agent86 built). Later messages redraw it in
 * place. */
export interface SurfaceEntry {
  kind: "surface";
  id: number;
  surfaceId: string;
  /** The call that created it; `null` for one rebuilt when the thread reopened. */
  toolCallId: string | null;
  /** The agent deleted it (`deleteSurface`). */
  deleted: boolean;
  /** An `ask_user` form agent86 took down once it was answered or dismissed, kept locked as the
   * record of what was asked and answered. Its `surfaceId` is then one of its own
   * (`agent86_ask_<n>~<entry id>`), since a rebuilt agent numbers its forms from 1 again. */
  kept?: boolean;
  /** How an `ask_user` form's questions ended, once its call's result came. */
  outcome?: AskOutcome;
}

/** One A2UI message, as JSON. */
export type UiMessage = Record<string, unknown>;

export type Entry =
  | UserEntry
  | AgentEntry
  | ThoughtEntry
  | NoticeEntry
  | ErrorEntry
  | ToolEntry
  | ListEntry
  | TurnSummaryEntry
  | SurfaceEntry;

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
    }
  /** A `render_ui` call waits for the user's first action on one of these surfaces, or an
   * `ask_user` call for the Send of its form (an `agent86_ask_` surface). */
  | { kind: "ui"; qid: number; surfaceIds: string[] };

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
  /**
   * agent86UI: the A2UI messages the thread's surfaces are built from, in order: the agent's
   * (`ui` events) and what the user entered, as `updateDataModel` messages. The renderer's
   * runtime replays it, so this state stays plain data.
   */
  uiLog: UiMessage[];
  /** Surfaces with a pressed button held for the running turn to end (one per press). */
  uiHeld: string[];
  /** Surfaces locked because the user sent from them, until the agent changes them or the user
   * unlocks them to send again. */
  uiSent: string[];
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
    uiLog: [],
    uiHeld: [],
    uiSent: [],
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
  | { type: "local/history"; items: HistoryItem[] }
  /** The user entered `value` at `path` on a surface (two-way binding, or a local function's
   * writes as the whole data model at `/`). */
  | { type: "local/uiInput"; surfaceId: string; path: string; value: unknown }
  /** A button pressed on a surface is held until the running turn ends. */
  | { type: "local/uiHeld"; surfaceId: string }
  /** The user sent an action from a surface: lock it. */
  | { type: "local/uiSent"; surfaceId: string }
  /** The user unlocked a surface to change it and send again. */
  | { type: "local/uiUnlock"; surfaceId: string }
  /** A reopened session's surfaces, as agent86 rebuilt them (one `createSurface` each), placed
   * after the history's last `render_ui` call that drew each one. */
  | { type: "local/surfaces"; messages: UiMessage[] };

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
    case "ui":
      return surfaceMessage(state, action.message, action.toolCallId);
    case "local/uiInput": {
      const write = {
        version: "1.0",
        updateDataModel: { surfaceId: action.surfaceId, path: action.path, value: action.value },
      };
      // Typing writes on every key: a write to the same place as the one just before replaces
      // it, which leaves the surface the same and the log short.
      const last = state.uiLog.at(-1)?.updateDataModel as
        { surfaceId?: unknown; path?: unknown } | undefined;
      const same = last?.surfaceId === action.surfaceId && last?.path === action.path;
      return {
        ...state,
        uiLog: same ? [...state.uiLog.slice(0, -1), write] : [...state.uiLog, write],
      };
    }
    case "local/surfaces":
      return action.messages.reduce(placeSurface, state);
    case "local/uiSent":
      return state.uiSent.includes(action.surfaceId)
        ? state
        : { ...state, uiSent: [...state.uiSent, action.surfaceId] };
    case "local/uiUnlock":
      return { ...state, uiSent: state.uiSent.filter((id) => id !== action.surfaceId) };
    case "local/uiHeld":
      return { ...state, uiHeld: [...state.uiHeld, action.surfaceId] };
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
    case "toolResult": {
      // Some providers (Ollama) reuse call ids from step to step, so only one card takes this
      // result: the oldest still running with the id.
      const target = resultTarget(
        state.entries,
        (e) => e.kind === "tool" && e.toolCallId === action.id,
        (e) => e.kind === "tool" && e.status === "running",
      );
      const done: SessionState = {
        ...state,
        entries: state.entries.map((entry, at) =>
          at === target && entry.kind === "tool"
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
      return action.name === ASK_USER
        ? askEnded(done, action.id, askOutcome(action.ok, action.output))
        : done;
    }
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
    case "uiWaitRequest":
      return {
        ...state,
        questions: [
          ...state.questions,
          { kind: "ui", qid: action.qid, surfaceIds: action.surfaceIds },
        ],
      };
    case "questionClosed":
      return closeQuestion(state, action.qid);
    case "uiActionStarted":
      // A button pressed on a surface is the user's next message, as agent86 words it.
      return push(
        { ...state, running: true, cancelling: false, uiHeld: unhold(state.uiHeld, action.action) },
        (id) => ({
          kind: "user",
          id,
          text: uiActionText(action.action),
        }),
      );
    case "uiActionDropped":
      // Stop dropped it, so nothing was sent: the surface unlocks.
      return push(
        {
          ...state,
          uiHeld: unhold(state.uiHeld, action.action),
          uiSent: state.uiSent.filter((id) => id !== action.action.surfaceId),
        },
        (id) => ({
          kind: "notice",
          id,
          text: `Not sent, because the turn was stopped: ${action.action.name} on ${action.action.surfaceId}.`,
        }),
      );
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
    case "toolResult": {
      const target = resultTarget(
        base.calls,
        (c) => c.id === update.id,
        (c) => c.status === "running",
      );
      return {
        ...base,
        calls: base.calls.map((c, at) =>
          at === target
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
    }
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

/** Which of `items` a tool result belongs to: the oldest match still running, else the latest
 * match (a replayed or repeated result), else none (-1). */
function resultTarget<T>(
  items: T[],
  matches: (item: T) => boolean,
  running: (item: T) => boolean,
): number {
  const open = items.findIndex((item) => matches(item) && running(item));
  return open >= 0 ? open : items.findLastIndex(matches);
}

/** The surface an A2UI message is about, or `null`. */
function namedSurface(message: UiMessage): string | null {
  for (const body of Object.values(message)) {
    if (body && typeof body === "object" && "surfaceId" in body) {
      const id = (body as { surfaceId: unknown }).surfaceId;
      if (typeof id === "string") return id;
    }
  }
  return null;
}

/** One fewer held press on the action's surface. */
function unhold(held: string[], action: UiAction): string[] {
  const at = held.indexOf(action.surfaceId);
  return at < 0 ? held : [...held.slice(0, at), ...held.slice(at + 1)];
}

/** An A2UI message the agent drew: logged for the runtime, and placed in the transcript when it
 * creates a surface (at its call) or deletes one. */
function surfaceMessage(
  state: SessionState,
  message: UiMessage,
  toolCallId: string | null,
): SessionState {
  const remove = message.deleteSurface as { surfaceId?: unknown } | undefined;
  if (remove && typeof remove.surfaceId === "string" && isAskSurface(remove.surfaceId)) {
    return keepAskForm(state, remove.surfaceId);
  }
  // The agent changed the surface: whatever the user sent has been seen, so it unlocks.
  const named = namedSurface(message);
  const logged = {
    ...state,
    uiLog: [...state.uiLog, message],
    uiSent: named === null ? state.uiSent : state.uiSent.filter((id) => id !== named),
  };
  const create = message.createSurface as { surfaceId?: unknown } | undefined;
  if (create && typeof create.surfaceId === "string") {
    const surfaceId = create.surfaceId;
    const shown = logged.entries.some(
      (e) => e.kind === "surface" && e.surfaceId === surfaceId && !e.deleted,
    );
    return shown
      ? logged
      : insertAtCall(logged, toolCallId, (id) => ({
          kind: "surface",
          id,
          surfaceId,
          toolCallId,
          deleted: false,
        }));
  }
  if (remove && typeof remove.surfaceId === "string") {
    const surfaceId = remove.surfaceId;
    return {
      ...logged,
      entries: logged.entries.map((e) =>
        e.kind === "surface" && e.surfaceId === surfaceId && !e.deleted
          ? { ...e, deleted: true }
          : e,
      ),
    };
  }
  return logged;
}

/**
 * Put a new entry right after the card of call `toolCallId` (after any surfaces that call already
 * placed there), or at the end when no card has that id. agent86 announces a step's whole batch of
 * calls before it runs them, so the end may be several cards past the call.
 */
function insertAtCall(
  state: SessionState,
  toolCallId: string | null,
  make: (id: number) => Entry,
): SessionState {
  const call =
    toolCallId === null
      ? -1
      : resultTarget(
          state.entries,
          (e) => e.kind === "tool" && e.toolCallId === toolCallId,
          (e) => e.kind === "tool" && e.status === "running",
        );
  if (call < 0) return push(state, make);
  let at = call + 1;
  for (; at < state.entries.length; at += 1) {
    const next = state.entries[at]!;
    if (next.kind !== "surface" || next.toolCallId !== toolCallId) break;
  }
  const entries = [...state.entries.slice(0, at), make(state.nextId), ...state.entries.slice(at)];
  return { ...state, entries, nextId: state.nextId + 1 };
}

/**
 * agent86 took an `ask_user` form down (`deleteSurface`), answered or dismissed. Rather than
 * removing it, keep it in the transcript, locked, as the record of what was asked and answered, as
 * the terminal keeps a copy in its scrollback. Its messages move to an id of its own, so a later
 * form agent86 numbers the same (a reload rebuilds the agent, which counts from 1 again) gets a
 * place of its own.
 */
function keepAskForm(state: SessionState, surfaceId: string): SessionState {
  const at = state.entries.findIndex(
    (e) => e.kind === "surface" && e.surfaceId === surfaceId && !e.deleted,
  );
  const entry = state.entries[at];
  const unlocked = {
    ...state,
    uiSent: state.uiSent.filter((id) => id !== surfaceId),
    uiHeld: state.uiHeld.filter((id) => id !== surfaceId),
  };
  if (entry?.kind !== "surface") {
    // Never placed, so there is nothing to keep: it simply goes.
    return {
      ...unlocked,
      uiLog: [...state.uiLog, { version: "1.0", deleteSurface: { surfaceId } }],
    };
  }
  const keptId = `${surfaceId}~${entry.id}`;
  const entries = state.entries.slice();
  entries[at] = { ...entry, surfaceId: keptId, kept: true };
  return {
    ...unlocked,
    entries,
    uiLog: state.uiLog.map((message) => renameSurface(message, surfaceId, keptId)),
  };
}

/** `message`, with surface `from` renamed `to` if it names it. */
function renameSurface(message: UiMessage, from: string, to: string): UiMessage {
  if (namedSurface(message) !== from) return message;
  return Object.fromEntries(
    Object.entries(message).map(([key, body]) =>
      body && typeof body === "object" && (body as { surfaceId?: unknown }).surfaceId === from
        ? [key, { ...body, surfaceId: to }]
        : [key, body],
    ),
  );
}

/** An `ask_user` call's result came: its form says how the questions ended. */
function askEnded(state: SessionState, toolCallId: string, outcome: AskOutcome): SessionState {
  const at = state.entries.findLastIndex(
    (e) =>
      e.kind === "surface" &&
      e.toolCallId === toolCallId &&
      isAskSurface(e.surfaceId) &&
      e.outcome === undefined,
  );
  if (at < 0) return state;
  const entries = state.entries.slice();
  entries[at] = { ...(entries[at] as SurfaceEntry), outcome };
  return { ...state, entries };
}

/** The surface ids a `render_ui` call's arguments name (`messages` may be a JSON string, as
 * agent86 repairs it). */
function surfacesDrawnBy(entry: ToolEntry): string[] {
  let messages: unknown = entry.arguments.messages;
  if (typeof messages === "string") {
    try {
      messages = JSON.parse(messages);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message: unknown) =>
    message && typeof message === "object"
      ? Object.values(message).flatMap((body: unknown) =>
          body &&
          typeof body === "object" &&
          "surfaceId" in body &&
          typeof body.surfaceId === "string"
            ? [body.surfaceId]
            : [],
        )
      : [],
  );
}

/** A rebuilt surface: logged, and placed after the last call in the transcript that drew it, or
 * at the end when compaction left none. */
function placeSurface(state: SessionState, message: UiMessage): SessionState {
  const create = message.createSurface as { surfaceId?: unknown } | undefined;
  const logged = { ...state, uiLog: [...state.uiLog, message] };
  if (!create || typeof create.surfaceId !== "string") return logged;
  const surfaceId = create.surfaceId;
  const at = logged.entries.findLastIndex(
    (e) => e.kind === "tool" && e.name === "render_ui" && surfacesDrawnBy(e).includes(surfaceId),
  );
  const call = logged.entries[at];
  const entry: SurfaceEntry = {
    kind: "surface",
    id: logged.nextId,
    surfaceId,
    toolCallId: call?.kind === "tool" ? call.toolCallId : null,
    deleted: false,
  };
  const entries =
    at < 0
      ? [...logged.entries, entry]
      : [...logged.entries.slice(0, at + 1), entry, ...logged.entries.slice(at + 1)];
  return { ...logged, entries, nextId: logged.nextId + 1 };
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

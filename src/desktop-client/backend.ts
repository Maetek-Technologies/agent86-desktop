// The UI's only door to the Rust side. Components call these functions, never `invoke` directly,
// so the IPC contract lives in one place: here, src-tauri/src/commands.rs, and the types ts-rs
// generates from it.
import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  Answer,
  AppInfo,
  DesktopEvent,
  ModelInfo,
  OpenedThread,
  TurnRequest,
} from "./events.ts";

export type { AppInfo, ModelInfo, OpenedThread } from "./events.ts";

export function appInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}

/** The model new threads use (until M5: the agent86 CLI's default model and keys). */
export function modelInfo(): Promise<ModelInfo> {
  return invoke<ModelInfo>("model_info");
}

/** The native folder picker. `null` when the user cancels. */
export function pickWorkspace(): Promise<string | null> {
  return invoke<string | null>("pick_workspace");
}

/** Start a thread in `workspace`; `onEvent` hears everything it streams, for its whole life. */
export function openThread(
  workspace: string,
  onEvent: (event: DesktopEvent) => void,
): Promise<OpenedThread> {
  const channel = new Channel<DesktopEvent>();
  channel.onmessage = onEvent;
  return invoke<OpenedThread>("open_thread", { workspace, onEvent: channel });
}

/** Start a turn: a message (its `@` mentions inlined by Rust), a skill, or a specialist. */
export function prompt(threadId: string, turn: TurnRequest): Promise<void> {
  return invoke("prompt", { threadId, turn });
}

/** Workspace files matching `query`, best first, for the `@` menu. */
export function findFiles(threadId: string, query: string): Promise<string[]> {
  return invoke<string[]>("find_files", { threadId, query });
}

export function cancelTurn(threadId: string): Promise<void> {
  return invoke("cancel_turn", { threadId });
}

/** Answer question `qid` (an approval, a limit raise, a secret) of the thread's running turn. */
export function answer(threadId: string, qid: number, answer: Answer): Promise<void> {
  return invoke("answer", { threadId, qid, answer });
}

export function closeThread(threadId: string): Promise<void> {
  return invoke("close_thread", { threadId });
}

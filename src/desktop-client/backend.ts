// The UI's only door to the Rust side. Components call these functions, never `invoke` directly,
// so the IPC contract lives in one place: here and in src-tauri/src/commands.rs.
import { Channel, invoke } from "@tauri-apps/api/core";
import type { DesktopEvent } from "./events.ts";

/** What `app_info` returns: the app, the embedded agent86-core, and the platform it runs on. */
export interface AppInfo {
  appVersion: string;
  coreVersion: string;
  os: string;
  arch: string;
  /** Whether agent86-core could open an in-memory session store (SQLite and the SDK linked). */
  memoryOk: boolean;
}

export function appInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}

/** The model new threads use (M1: the agent86 CLI's default model and keys). */
export interface ModelInfo {
  /** `provider:model`. */
  reference: string;
  contextWindow: number;
  /** The config files it came from. */
  source: string;
  /** Why a thread cannot start with it (no key, unknown provider), if it cannot. */
  problem: string | null;
}

export function modelInfo(): Promise<ModelInfo> {
  return invoke<ModelInfo>("model_info");
}

/** The native folder picker. `null` when the user cancels. */
export function pickWorkspace(): Promise<string | null> {
  return invoke<string | null>("pick_workspace");
}

export interface OpenedThread {
  threadId: string;
  /** The workspace as resolved: absolute, symlinks followed. */
  workspace: string;
  model: string;
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

export function prompt(threadId: string, text: string): Promise<void> {
  return invoke("prompt", { threadId, text });
}

export function cancelTurn(threadId: string): Promise<void> {
  return invoke("cancel_turn", { threadId });
}

export function closeThread(threadId: string): Promise<void> {
  return invoke("close_thread", { threadId });
}

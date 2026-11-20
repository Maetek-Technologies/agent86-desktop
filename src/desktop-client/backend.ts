// The UI's only door to the Rust side. Components call these functions, never `invoke` directly,
// so the IPC contract lives in one place: here, src-tauri/src/commands.rs, and the types ts-rs
// generates from it.
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Answer,
  Approval,
  AppInfo,
  DesktopEvent,
  ImportPreview,
  KeyStatus,
  MemoryEntry,
  MemoryKind,
  MemoryPage,
  ModelInfo,
  ModelMenu,
  OpenedThread,
  ProjectContent,
  ProviderSettings,
  ReloadedThread,
  SecretList,
  TrustedProject,
  SessionList,
  Settings,
  SettingsState,
  TurnRequest,
  UpdateInfo,
  UpdateProgress,
} from "./events.ts";

export type {
  AppInfo,
  ImportPreview,
  KeyStatus,
  ModelInfo,
  OpenedThread,
  MemoryEntry,
  MemoryPage,
  ProjectContent,
  ReloadedThread,
  SecretList,
  SessionList,
  Settings,
  SettingsState,
  TrustedProject,
} from "./events.ts";

export function appInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}

/** The model new threads use, from the app's settings, and why it cannot start, if it cannot. */
export function modelInfo(): Promise<ModelInfo> {
  return invoke<ModelInfo>("model_info");
}

/** The settings (`null` before setup), where they live, and the CLI config that could be imported. */
export function getSettings(): Promise<SettingsState> {
  return invoke<SettingsState>("get_settings");
}

/** Check and keep `settings`. Rejects with every problem found, one per line. */
export function saveSettings(settings: Settings): Promise<Settings> {
  return invoke<Settings>("save_settings", { settings });
}

/** What importing the agent86 CLI's `~/.agent86/config.toml` would give; nothing is kept yet. */
export function previewCliImport(): Promise<ImportPreview> {
  return invoke<ImportPreview>("preview_cli_import");
}

/** Where each provider's API key comes from (never the key itself). */
export function keyStatuses(providers: Record<string, ProviderSettings>): Promise<KeyStatus[]> {
  return invoke<KeyStatus[]>("key_statuses", { providers });
}

/** Store `provider`'s API key in the OS keyring, where `agent86 keys set` keeps it. */
export function setKey(provider: string, key: string): Promise<void> {
  return invoke("set_key", { provider, key });
}

/** Remove `provider`'s key from the OS keyring. Resolves to whether there was one. */
export function deleteKey(provider: string): Promise<boolean> {
  return invoke<boolean>("delete_key", { provider });
}

/** Send `reference` a one-line request with `settings` (saved or not). Resolves to what it said. */
export function testModel(settings: Settings, reference: string): Promise<string> {
  return invoke<string>("test_model", { settings, reference });
}

/** The native folder picker. `null` when the user cancels. */
export function pickWorkspace(): Promise<string | null> {
  return invoke<string | null>("pick_workspace");
}

/**
 * Start a thread in `workspace`, continuing saved session `sessionId` if given; `onEvent` hears
 * everything it streams, for its whole life.
 */
export function openThread(
  workspace: string,
  sessionId: string | null,
  onEvent: (event: DesktopEvent) => void,
): Promise<OpenedThread> {
  const channel = new Channel<DesktopEvent>();
  channel.onmessage = onEvent;
  return invoke<OpenedThread>("open_thread", { workspace, sessionId, onEvent: channel });
}

/** Recent saved sessions, newest first, from the memory database shared with the agent86 CLI. */
export function listSessions(limit = 100): Promise<SessionList> {
  return invoke<SessionList>("list_sessions", { limit });
}

/** Give a saved session a title (as agent86's `/rename`). Resolves to the title kept. */
export function renameSession(sessionId: string, title: string): Promise<string> {
  return invoke<string>("rename_session", { sessionId, title });
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

/**
 * Show a desktop notification (unless they are off in Settings). Clicking it brings the app
 * forward on tab `tab`; see `onActivateTab`.
 */
export function notify(title: string, body: string, tab: string | null): Promise<void> {
  return invoke("notify", { title, body, tab });
}

/** Call `handler` with a tab's key when a notification about that tab is clicked. */
export function onActivateTab(handler: (tab: string) => void): Promise<() => void> {
  return listen<string>("activate-tab", (event) => handler(event.payload));
}

/**
 * Open a file of the thread's with its default app, or with `reveal`, show it in Explorer or
 * Finder. Rust allows only paths inside the thread's workspace or a worktree its sub-agents kept,
 * and only reveals programs and scripts.
 */
export function openPath(threadId: string, path: string, reveal: boolean): Promise<void> {
  return invoke("open_path", { threadId, path, reveal });
}

/** Ask GitHub Releases for a newer version; `null` when this is the latest. */
export function checkUpdate(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>("check_update");
}

/**
 * Download, verify, and install the update the last check found. On Windows the installer then
 * closes the app; elsewhere call `restartApp`.
 */
export function installUpdate(onProgress: (progress: UpdateProgress) => void): Promise<void> {
  const channel = new Channel<UpdateProgress>();
  channel.onmessage = onProgress;
  return invoke("install_update", { onProgress: channel });
}

/** Restart the app; running turns stop. */
export function restartApp(): Promise<void> {
  return invoke("restart_app");
}

/** The models a thread's menu offers: those the settings name, and each provider's own list. */
export function listModels(): Promise<ModelMenu> {
  return invoke<ModelMenu>("list_models");
}

/**
 * Run a thread on `model` (`provider:model`) from now on, keeping its conversation; `""` goes back
 * to the settings' model. Only between turns.
 */
export function setThreadModel(threadId: string, model: string): Promise<ReloadedThread> {
  return invoke<ReloadedThread>("set_thread_model", { threadId, model });
}

/**
 * Set what happens to a thread's side-effecting tool calls from now on (ask, run without asking,
 * refuse), keeping its conversation; `null` goes back to the settings' mode. Only between turns.
 */
export function setThreadApproval(
  threadId: string,
  approval: Approval | null,
): Promise<ReloadedThread> {
  return invoke<ReloadedThread>("set_thread_approval", { threadId, approval });
}

/** Rebuild a thread with the current settings and project trust, keeping its conversation. */
export function reloadThread(threadId: string): Promise<ReloadedThread> {
  return invoke<ReloadedThread>("reload_thread", { threadId });
}

/** A page of facts or episodes from the memory database shared with the CLI, newest first. */
export function listMemory(
  kind: MemoryKind,
  pinnedOnly: boolean,
  offset: number,
  limit: number,
): Promise<MemoryPage> {
  return invoke<MemoryPage>("list_memory", { kind, pinnedOnly, offset, limit });
}

/** Pin an entry (never pruned) or unpin it. Resolves to the entry as it now stands. */
export function pinMemory(kind: MemoryKind, id: number, pinned: boolean): Promise<MemoryEntry> {
  return invoke<MemoryEntry>("pin_memory", { kind, id, pinned });
}

/** Delete a fact or episode for good. */
export function forgetMemory(kind: MemoryKind, id: number): Promise<void> {
  return invoke("forget_memory", { kind, id });
}

/** The secrets a thread holds or its project remembers: names only. */
export function listSecrets(threadId: string): Promise<SecretList> {
  return invoke<SecretList>("list_secrets", { threadId });
}

/** Hold a secret for the thread, and in the keyring for the project if `remember`. */
export function setSecret(
  threadId: string,
  name: string,
  value: string,
  remember: boolean,
): Promise<SecretList> {
  return invoke<SecretList>("set_secret", { threadId, name, value, remember });
}

/** Drop a secret from the thread and the project's keyring entries. */
export function forgetSecret(threadId: string, name: string): Promise<SecretList> {
  return invoke<SecretList>("forget_secret", { threadId, name });
}

/** What the thread's workspace would load once trusted (`null` when it brings nothing). */
export function reviewProject(threadId: string): Promise<ProjectContent | null> {
  return invoke<ProjectContent | null>("review_project", { threadId });
}

/** Trust the thread's workspace as reviewed. Rejected if it changed since. */
export function trustProject(threadId: string, sha256: string): Promise<void> {
  return invoke("trust_project", { threadId, sha256 });
}

export function trustedProjects(): Promise<TrustedProject[]> {
  return invoke<TrustedProject[]>("trusted_projects");
}

/** Stop trusting a workspace. Resolves to whether it was trusted. */
export function forgetTrust(workspace: string): Promise<boolean> {
  return invoke<boolean>("forget_trust", { workspace });
}

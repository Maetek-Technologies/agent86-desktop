// The UI's only door to the Rust side. Components call these functions, never `invoke` directly,
// so the IPC contract lives in one place (and, from M1, in types generated from Rust).
import { invoke } from "@tauri-apps/api/core";

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

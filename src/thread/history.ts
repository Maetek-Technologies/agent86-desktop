// Prompt history per workspace, in the WebView's localStorage (agent86-web's scheme). Storage can
// be missing or throw, so every access is guarded and the app works without it.

const LIMIT = 200;
const key = (workspace: string) => `agent86desktop.history.v1:${workspace}`;

export function loadHistory(workspace: string): string[] {
  try {
    const raw = window.localStorage.getItem(key(workspace));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

/** Add `entry` (moving a repeat to the end) and return the new history. */
export function pushHistory(workspace: string, entry: string): string[] {
  const entries = [...loadHistory(workspace).filter((e) => e !== entry), entry].slice(-LIMIT);
  try {
    window.localStorage.setItem(key(workspace), JSON.stringify(entries));
  } catch {
    // Not remembered; nothing else depends on it.
  }
  return entries;
}

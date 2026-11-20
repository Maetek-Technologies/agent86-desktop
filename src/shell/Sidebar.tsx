import { useState } from "react";
import type { SessionList, SessionSummary, UpdateInfo } from "../desktop-client/events.ts";
import { modLabel } from "./shortcuts.ts";
import { folderName } from "./tabs.ts";
import { RenameInput } from "./Tabs.tsx";

/** "just now", "5 min ago", "3 h ago", "yesterday", or a date. */
export function ago(seconds: number, now = Date.now() / 1000): string {
  const delta = Math.max(0, now - seconds);
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)} min ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} h ago`;
  if (delta < 172800) return "yesterday";
  return new Date(seconds * 1000).toLocaleDateString();
}

/**
 * The sessions saved in the memory database the agent86 CLI shares, newest first: click one to
 * reopen it (in its own folder when the app knows it, else after asking), or its ✎ to rename it.
 * Sessions open in a tab are marked.
 */
export function Sidebar({
  list,
  openSessions,
  busy,
  onNew,
  onOpen,
  onRename,
  onRefresh,
  onSettings,
  settingsOpen,
  onMemory,
  memoryOpen,
  update = null,
  onUpdate,
  onLogs,
  logsOpen = false,
}: {
  list: SessionList | null;
  /** Session ids open in tabs. */
  openSessions: ReadonlySet<string>;
  /** A thread is being opened; the buttons wait. */
  busy: boolean;
  onNew: () => void;
  onOpen: (session: SessionSummary) => void;
  /** Give a saved session a new title. */
  onRename?: (session: SessionSummary, title: string) => void;
  onRefresh: () => void;
  onSettings: () => void;
  /** The settings view is showing. */
  settingsOpen: boolean;
  onMemory: () => void;
  memoryOpen: boolean;
  /** A newer version the startup check found. */
  update?: UpdateInfo | null;
  onUpdate?: () => void;
  onLogs?: () => void;
  logsOpen?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-panel text-sm">
      <div className="flex items-center gap-2 border-b border-border p-2">
        <img src="/agent86-logo.png" alt="" width={24} height={24} />
        <button
          type="button"
          onClick={onNew}
          disabled={busy}
          title={`New thread (${modLabel()}T)`}
          className="flex-1 rounded bg-accent px-2 py-1 text-sm font-medium text-bg disabled:opacity-50"
        >
          New thread…
        </button>
      </div>
      <div className="flex items-center justify-between px-3 pt-2 pb-1 text-xs text-muted">
        <span>Sessions</span>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded px-1 hover:bg-panel-2 hover:text-text"
          title="Refresh"
          aria-label="Refresh sessions"
        >
          ↻
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto pb-2" aria-label="Sessions">
        {list?.problem && <p className="px-3 py-1 text-xs text-muted">{list.problem}</p>}
        {list && !list.problem && list.sessions.length === 0 && (
          <p className="px-3 py-1 text-xs text-muted">No saved sessions yet.</p>
        )}
        <ul>
          {list?.sessions.map((session) => {
            const open = openSessions.has(session.id);
            const title = session.title ?? "(untitled)";
            if (editing === session.id) {
              return (
                <li key={session.id} className="flex px-3 py-1.5">
                  <RenameInput
                    initial={session.title ?? ""}
                    onDone={(value) => {
                      setEditing(null);
                      if (value && value !== session.title) onRename?.(session, value);
                    }}
                  />
                </li>
              );
            }
            return (
              <li key={session.id} className="group relative">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onOpen(session)}
                  className="block w-full px-3 py-1.5 text-left hover:bg-panel-2 disabled:opacity-60"
                  title={session.workspace ?? "Folder not known: you will be asked for it"}
                >
                  <span className="flex items-center gap-1.5 pr-5">
                    {open && (
                      <span className="text-accent" aria-label="open">
                        ●
                      </span>
                    )}
                    <span className="truncate">{title}</span>
                  </span>
                  <span className="flex gap-2 text-xs text-muted">
                    <span className="truncate">
                      {session.workspace ? folderName(session.workspace) : "folder unknown"}
                    </span>
                    <span className="ml-auto shrink-0">{ago(session.updatedAt)}</span>
                  </span>
                </button>
                {onRename && (
                  <button
                    type="button"
                    onClick={() => setEditing(session.id)}
                    title="Rename"
                    aria-label={`Rename ${title}`}
                    className="absolute top-1 right-1 rounded px-1 text-xs text-muted opacity-0 group-hover:opacity-100 hover:bg-panel hover:text-text focus:opacity-100"
                  >
                    ✎
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
      {list?.note && (
        <p className="border-t border-border px-3 py-2 text-xs text-warn" role="note">
          {list.note}
        </p>
      )}
      <div className="space-y-0.5 border-t border-border p-2">
        {update && (
          <button
            type="button"
            onClick={onUpdate}
            className="w-full rounded border border-accent px-2 py-1 text-left text-xs text-accent hover:bg-panel-2"
          >
            Version {update.version} is available…
          </button>
        )}
        <button
          type="button"
          onClick={onMemory}
          aria-pressed={memoryOpen}
          className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-panel-2 ${
            memoryOpen ? "bg-panel-2 text-text" : "text-muted"
          }`}
        >
          🧠 Memory
        </button>
        <button
          type="button"
          onClick={onLogs}
          aria-pressed={logsOpen}
          className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-panel-2 ${
            logsOpen ? "bg-panel-2 text-text" : "text-muted"
          }`}
        >
          📜 Logs
        </button>
        <button
          type="button"
          onClick={onSettings}
          aria-pressed={settingsOpen}
          title={`Settings (${modLabel()},)`}
          className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-panel-2 ${
            settingsOpen ? "bg-panel-2 text-text" : "text-muted"
          }`}
        >
          ⚙ Settings
        </button>
      </div>
    </aside>
  );
}

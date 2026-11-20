import { useState, type KeyboardEvent } from "react";
import type { Tab } from "./tabs.ts";

/**
 * The open threads. A dot marks a running turn (amber when it waits on you); double-click a
 * title (or press F2 on a tab) to rename the session.
 */
export function Tabs({
  tabs,
  active,
  titleOf,
  onActivate,
  onClose,
  onRename,
}: {
  tabs: Tab[];
  active: string | null;
  titleOf: (tab: Tab) => string;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onRename: (key: string, title: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div role="tablist" className="flex shrink-0 overflow-x-auto border-b border-border bg-panel">
      {tabs.map((tab) => {
        const selected = tab.key === active;
        const waiting = tab.session.questions.length > 0;
        const title = titleOf(tab);
        return (
          <div
            key={tab.key}
            role="tab"
            aria-selected={selected}
            tabIndex={0}
            onClick={() => onActivate(tab.key)}
            onKeyDown={(e) => {
              if (editing === tab.key) return;
              if (e.key === "Enter") onActivate(tab.key);
              if (e.key === "F2" && tab.opened) setEditing(tab.key);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) onClose(tab.key);
            }}
            className={`group flex max-w-60 min-w-32 cursor-pointer items-center gap-2 border-r border-border px-3 py-1.5 text-sm ${selected ? "bg-bg text-text" : "text-muted hover:bg-panel-2"}`}
          >
            {(tab.session.running || !tab.opened) && (
              <span
                className={waiting ? "text-warn" : "animate-pulse text-accent"}
                aria-label={waiting ? "waiting for you" : "working"}
              >
                ●
              </span>
            )}
            {editing === tab.key ? (
              <RenameInput
                initial={title}
                onDone={(value) => {
                  setEditing(null);
                  if (value && value !== title) onRename(tab.key, value);
                }}
              />
            ) : (
              <span
                className="min-w-0 flex-1 truncate"
                title={`${title}\n${tab.workspace}${tab.opened ? "\nDouble-click to rename" : ""}`}
                onDoubleClick={() => tab.opened && setEditing(tab.key)}
              >
                {title}
              </span>
            )}
            <button
              type="button"
              aria-label={`Close ${title}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.key);
              }}
              className="rounded px-1 text-muted opacity-60 group-hover:opacity-100 hover:bg-panel-2 hover:text-text"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** An inline title editor: Enter or leaving it keeps the text, Escape keeps the old title. */
export function RenameInput({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") onDone(value.trim());
    if (e.key === "Escape") onDone(initial);
  };
  return (
    <input
      autoFocus
      aria-label="Session title"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => onDone(value.trim())}
      onClick={(e) => e.stopPropagation()}
      className="min-w-0 flex-1 rounded border border-accent bg-bg px-1 text-sm text-text outline-none"
    />
  );
}

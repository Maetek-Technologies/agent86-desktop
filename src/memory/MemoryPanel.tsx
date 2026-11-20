import { useEffect, useState } from "react";
import { forgetMemory, listMemory, pinMemory } from "../desktop-client/backend.ts";
import type { MemoryEntry, MemoryKind } from "../desktop-client/events.ts";

/** Entries per page. */
export const MEMORY_PAGE = 20;

function when(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

/**
 * What Agent 86 has learned (forked from agent86-web), in the memory database it shares with the
 * agent86 CLI: facts (what `remember` keeps) and episodes (one per finished turn, recalled into
 * similar later tasks), newest first, a page at a time. Pinning keeps an entry from ever being
 * pruned; forgetting deletes it, after a confirmation.
 */
export function MemoryPanel({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<MemoryKind>("fact");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);

  // The first page, whenever what to list changes.
  useEffect(() => {
    let live = true;
    listMemory(kind, pinnedOnly, 0, MEMORY_PAGE).then(
      (page) => {
        if (!live) return;
        setEntries(page.entries);
        setMore(page.more);
        setError(null);
      },
      (e: unknown) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [kind, pinnedOnly]);

  async function act(action: () => Promise<void>) {
    setWorking(true);
    try {
      await action();
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  }

  const loadMore = () =>
    act(async () => {
      const page = await listMemory(kind, pinnedOnly, entries?.length ?? 0, MEMORY_PAGE);
      setEntries((current) => [...(current ?? []), ...page.entries]);
      setMore(page.more);
    });

  const pin = (entry: MemoryEntry) =>
    act(async () => {
      const updated = await pinMemory(entry.kind, entry.id, !entry.pinned);
      setEntries((current) => {
        const next = (current ?? []).map((e) => (e.id === entry.id ? updated : e));
        // Unpinned under the pinned filter: it no longer belongs in the list.
        return pinnedOnly ? next.filter((e) => e.pinned) : next;
      });
    });

  const forget = (entry: MemoryEntry) =>
    act(async () => {
      setConfirming(null);
      await forgetMemory(entry.kind, entry.id);
      setEntries((current) => (current ?? []).filter((e) => e.id !== entry.id));
    });

  const noun = kind === "fact" ? "fact" : "episode";

  return (
    <aside aria-label="Memory" className="flex min-h-0 flex-col bg-panel text-sm">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 font-semibold">
        <span aria-hidden>🧠</span>
        <span>Memory</span>
        <button
          type="button"
          aria-label="Close memory"
          onClick={onClose}
          className="ml-auto rounded px-1 text-muted hover:text-text"
        >
          ✕
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <div role="tablist" aria-label="What to list" className="flex gap-1">
          {(["fact", "episode"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              onClick={() => {
                setConfirming(null);
                setKind(k);
              }}
              className={`rounded px-2 py-0.5 ${kind === k ? "bg-panel-2 font-semibold text-text" : "text-muted hover:text-text"}`}
            >
              {k === "fact" ? "Facts" : "Episodes"}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-1">
          <input
            type="checkbox"
            checked={pinnedOnly}
            onChange={(event) => {
              setConfirming(null);
              setPinnedOnly(event.target.checked);
            }}
          />
          pinned only
        </label>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
        <p className="text-xs text-muted">
          {kind === "fact"
            ? "Facts are what the agent keeps with remember."
            : "Episodes are one per finished turn; Agent 86 recalls them into similar later tasks."}{" "}
          Pinned entries are never pruned. The agent86 CLI shares this memory.
        </p>
        {entries && entries.length === 0 && (
          <p className="text-xs text-muted">
            No {pinnedOnly ? "pinned " : ""}
            {noun}s.
          </p>
        )}
        {entries && entries.length > 0 && (
          <ul className="space-y-1.5" aria-label={`${noun}s`}>
            {entries.map((entry) => (
              <li
                key={`${entry.kind}-${entry.id}`}
                className="space-y-1 rounded border border-border bg-panel-2 p-2"
              >
                <div className="break-words whitespace-pre-wrap">{entry.text}</div>
                {entry.outcome !== null && (
                  <div className="text-xs break-words text-muted">→ {entry.outcome}</div>
                )}
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span className="font-mono">#{entry.id}</span>
                  <span>{when(entry.storedAt)}</span>
                  {entry.category && entry.category !== "fact" && (
                    <span className="rounded bg-panel px-1">{entry.category}</span>
                  )}
                  {entry.pinned && (
                    <span className="rounded bg-accent/20 px-1 text-accent">pinned</span>
                  )}
                  {confirming === entry.id ? (
                    <span
                      role="alertdialog"
                      aria-label={`Forget ${noun} ${entry.id}?`}
                      className="ml-auto flex items-center gap-1"
                    >
                      Forget for good?
                      <button
                        type="button"
                        onClick={() => setConfirming(null)}
                        className="rounded border border-border px-1.5 text-text hover:border-accent"
                      >
                        Keep
                      </button>
                      <button
                        type="button"
                        onClick={() => void forget(entry)}
                        className="rounded border border-error px-1.5 text-error hover:bg-error/10"
                      >
                        Forget
                      </button>
                    </span>
                  ) : (
                    <span className="ml-auto flex gap-1">
                      <button
                        type="button"
                        disabled={working}
                        onClick={() => void pin(entry)}
                        className="rounded px-1.5 hover:text-text disabled:opacity-50"
                      >
                        {entry.pinned ? "unpin" : "pin"}
                      </button>
                      <button
                        type="button"
                        disabled={working}
                        onClick={() => setConfirming(entry.id)}
                        className="rounded px-1.5 hover:text-error disabled:opacity-50"
                      >
                        forget
                      </button>
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {more && (
          <button
            type="button"
            disabled={working}
            onClick={() => void loadMore()}
            className="w-full rounded border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50"
          >
            Load more
          </button>
        )}
        {error && (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        )}
      </div>
    </aside>
  );
}

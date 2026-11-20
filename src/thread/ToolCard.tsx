import { useState } from "react";
import type { ToolEntry } from "../desktop-client/session-state.ts";

const STATUS: Record<ToolEntry["status"], { label: string; className: string }> = {
  running: { label: "running", className: "text-accent" },
  completed: { label: "done", className: "text-ok" },
  failed: { label: "failed", className: "text-error" },
};

// The tool card: the call, its status, and its output on demand. agent86-web's richer card
// (result diffs, sub-agents) replaces it in M3; approvals show in the panel above the input.
export function ToolCard({ entry }: { entry: ToolEntry }) {
  const [open, setOpen] = useState(false);
  const status =
    entry.approvalQid !== undefined
      ? { label: "awaiting approval", className: "text-warn" }
      : STATUS[entry.status];
  const hasDetail = entry.output || entry.error;
  return (
    <div className="my-2 rounded-md border border-border bg-panel text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left disabled:cursor-default"
        onClick={() => setOpen((o) => !o)}
        disabled={!hasDetail}
        aria-expanded={open}
      >
        <span className="font-mono text-muted">{hasDetail ? (open ? "▾" : "▸") : "•"}</span>
        <span className="min-w-0 flex-1 truncate font-mono">{entry.title || entry.name}</span>
        <span className={`text-xs ${status.className}`}>{status.label}</span>
      </button>
      {entry.summary && !open && (
        <div className="truncate border-t border-border px-3 py-1 font-mono text-xs text-muted">
          {entry.summary}
        </div>
      )}
      {open && hasDetail && (
        <div className="border-t border-border">
          {entry.error && (
            <div className="px-3 py-1.5 font-mono text-xs text-error">{entry.error}</div>
          )}
          {entry.output && (
            <pre className="max-h-80 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {entry.output}
              {entry.truncated && <span className="text-muted">{"\n"}… (output truncated)</span>}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

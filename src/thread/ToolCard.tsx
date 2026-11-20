import { useState } from "react";
import type { ToolEntry } from "../desktop-client/session-state.ts";
import { Highlight } from "../highlight/Highlight.tsx";
import { languageForPath } from "../highlight/languages.ts";
import { argumentSummary, splitResult } from "../tools/approval.ts";
import { DiffView } from "../tools/DiffView.tsx";
import { relativePath } from "../tools/paths.ts";
import { useThread } from "./ThreadContext.ts";

type Display = "awaiting" | "running" | "done" | "failed" | "declined" | "interrupted";

/** How a call stands, in agent86-web's terms. */
export function display(entry: ToolEntry): Display {
  if (entry.approvalQid !== undefined) return "awaiting";
  if (entry.status === "running") return "running";
  if (entry.status === "completed") return "done";
  const said = `${entry.error ?? ""} ${entry.output ?? ""}`;
  // agent86's words for a call it did not run: "Not executed: declined by user", "blocked by …".
  if (/Not executed:|declined by user|blocked by approval policy/.test(said)) return "declined";
  if (entry.error === "did not finish") return "interrupted";
  return "failed";
}

const BADGE: Record<Display, { icon: string; label: string; className: string }> = {
  awaiting: { icon: "⚠", label: "awaiting approval", className: "text-warn" },
  running: { icon: "◐", label: "running", className: "text-accent animate-pulse" },
  done: { icon: "✓", label: "done", className: "text-ok" },
  failed: { icon: "✗", label: "failed", className: "text-error" },
  declined: { icon: "⊘", label: "declined", className: "text-muted" },
  interrupted: { icon: "↯", label: "interrupted", className: "text-warn" },
};

/** An icon per kind of tool (agent86-web's ACP kinds, by agent86's tool names). */
const KIND: Record<string, { icon: string; label: string }> = {
  read_file: { icon: "▤", label: "read" },
  list_dir: { icon: "▤", label: "read" },
  write_file: { icon: "✎", label: "edit" },
  edit_file: { icon: "✎", label: "edit" },
  search_files: { icon: "⌕", label: "search" },
  find_files: { icon: "⌕", label: "search" },
  run_command: { icon: "❯", label: "run" },
  python_exec: { icon: "❯", label: "run" },
  web_fetch: { icon: "⇣", label: "fetch" },
  delegate: { icon: "⇉", label: "delegate" },
  use_skill: { icon: "✦", label: "skill" },
  request_secret: { icon: "🔑", label: "secret" },
  remember: { icon: "∴", label: "memory" },
  recall: { icon: "∴", label: "memory" },
};

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={`Copy ${label}`}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="rounded px-1 text-muted hover:bg-panel-2 hover:text-text"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

/** What a call returned, shown the way its tool's output reads best. */
function Result({ entry }: { entry: ToolEntry }) {
  const output = entry.output ?? "";
  const path = typeof entry.arguments.path === "string" ? entry.arguments.path : undefined;
  if (!output) return null;
  if (entry.name === "edit_file" || entry.name === "write_file") {
    const { message, diff } = splitResult(output);
    return (
      <div className="space-y-2 px-3 py-2">
        {message && <div className="font-mono text-xs">{message}</div>}
        {diff && <DiffView diff={diff} />}
      </div>
    );
  }
  const language = entry.name === "read_file" && path ? languageForPath(path) : undefined;
  return (
    <pre className="max-h-96 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
      {language ? <Highlight code={output} language={language} /> : output}
    </pre>
  );
}

/**
 * One tool call: its kind, the call in one line, the file it works on, how it stands, and on demand
 * what it returned (a diff for an edit, highlighted text for a read, the output of a command).
 */
export function ToolCard({ entry }: { entry: ToolEntry }) {
  const { cwd } = useThread();
  const [open, setOpen] = useState(false);
  const state = display(entry);
  const badge = BADGE[state];
  const kind = KIND[entry.name];
  const summary = argumentSummary(entry.name, entry.arguments);
  const path = typeof entry.arguments.path === "string" ? entry.arguments.path : undefined;
  const hasDetail = Boolean(entry.output || entry.error);

  return (
    <div className="my-2 rounded-md border border-border bg-panel text-sm" data-testid="tool-card">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left disabled:cursor-default"
        onClick={() => setOpen((o) => !o)}
        disabled={!hasDetail}
        aria-expanded={open}
        title={entry.title}
      >
        <span className="w-4 shrink-0 text-center text-muted" title={kind?.label} aria-hidden>
          {kind?.icon ?? "•"}
        </span>
        <span className="shrink-0 font-mono">{entry.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted">{summary}</span>
        <span className={`shrink-0 text-xs ${badge.className}`}>
          <span aria-hidden>{badge.icon}</span> {badge.label}
        </span>
        {hasDetail && (
          <span className="font-mono text-xs text-muted" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
        )}
      </button>
      {path && (
        <div className="flex items-center gap-1 px-3 pb-1 pl-9 font-mono text-xs text-muted">
          <span aria-hidden>↳</span>
          <span className="truncate" title={path}>
            {relativePath(path, cwd)}
          </span>
          <CopyButton text={path} label="path" />
        </div>
      )}
      {!open && entry.summary && (
        <div className="truncate border-t border-border px-3 py-1 pl-9 font-mono text-xs text-muted">
          {entry.summary}
        </div>
      )}
      {open && hasDetail && (
        <div className="border-t border-border">
          {entry.error && (
            <div className="px-3 py-1.5 font-mono text-xs text-error">{entry.error}</div>
          )}
          <Result entry={entry} />
          {entry.truncated && (
            <div className="px-3 pb-2 text-xs text-muted">
              Output shortened here; the model saw all of it.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

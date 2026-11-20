import { useState } from "react";
import { FileActions, joinPath } from "../tools/FileActions.tsx";
import type { SubagentActivity, SubCall } from "../desktop-client/session-state.ts";
import { Highlight } from "../highlight/Highlight.tsx";
import { argumentSummary } from "../tools/approval.ts";
import type { WorktreeNote } from "../tools/worktree.ts";

const CALL_ICON: Record<SubCall["status"], { icon: string; className: string }> = {
  running: { icon: "◐", className: "text-accent animate-pulse" },
  completed: { icon: "✓", className: "text-ok" },
  failed: { icon: "✗", className: "text-error" },
};

function SubCallRow({ call }: { call: SubCall }) {
  const [open, setOpen] = useState(false);
  const icon = CALL_ICON[call.status];
  const detail = call.error || call.output;
  return (
    <li>
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left disabled:cursor-default"
        disabled={!detail}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`w-3 shrink-0 text-center ${icon.className}`} aria-hidden>
          {icon.icon}
        </span>
        <span className="shrink-0">{call.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted">
          {argumentSummary(call.name, call.arguments)}
        </span>
      </button>
      {open && detail && (
        <pre className="mt-1 mb-2 ml-5 max-h-60 overflow-auto rounded bg-panel-2 p-2 whitespace-pre-wrap">
          {call.error && <span className="text-error">{call.error}\n</span>}
          {call.output}
        </pre>
      )}
    </li>
  );
}

/** What the sub-agent a call started is doing: who, how far, and each call it makes. */
export function SubagentActivityView({ activity }: { activity: SubagentActivity }) {
  const [open, setOpen] = useState(false);
  const state =
    activity.ok === null
      ? { label: "working", className: "text-accent" }
      : activity.ok
        ? { label: "finished", className: "text-ok" }
        : { label: "failed", className: "text-error" };
  const calls = activity.calls.length;
  return (
    <div className="border-t border-border px-3 py-1.5 pl-9 text-xs" aria-label="Sub-agent">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="font-mono">{activity.name}</span>
        <span className={state.className}>{state.label}</span>
        <span className="text-muted">
          {calls} call{calls === 1 ? "" : "s"}
          {activity.nested.length > 0 && ` · delegated to ${activity.nested.join(", ")}`}
          {activity.usage &&
            activity.usage.costUsd > 0 &&
            ` · $${activity.usage.costUsd.toFixed(4)}`}
        </span>
        <span className="ml-auto font-mono text-muted" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {activity.task && <div className="whitespace-pre-wrap text-muted">{activity.task}</div>}
          {calls > 0 && (
            <ul className="space-y-0.5 font-mono">
              {activity.calls.map((call) => (
                <SubCallRow key={call.id} call={call} />
              ))}
            </ul>
          )}
          {activity.notices.map((notice, i) => (
            <div key={i} className="font-mono text-muted">
              {notice}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Where an isolated sub-agent worked, and what it changed there (nothing was applied). */
export function WorktreeView({ worktree }: { worktree: WorktreeNote }) {
  return (
    <div
      className="space-y-2 rounded border border-border bg-panel-2 p-2 text-xs"
      aria-label="Worktree"
    >
      <div className="flex flex-wrap items-center gap-x-2">
        <span className="font-semibold">Worktree</span>
        <span className="text-muted">of HEAD {worktree.base}</span>
        {worktree.path ? (
          <span>
            kept at <span className="font-mono">{worktree.path}</span> on branch{" "}
            <span className="font-mono">{worktree.branch}</span>; nothing was applied to your
            workspace <FileActions path={worktree.path} open={false} />
          </span>
        ) : (
          <span className="text-muted">changed nothing and was removed</span>
        )}
      </div>
      {worktree.dirty && (
        <div className="text-warn">
          Your workspace had uncommitted changes the worktree did not have.
        </div>
      )}
      {worktree.error && (
        <div className="text-error">Its diff could not be made: {worktree.error}</div>
      )}
      {worktree.files.length > 0 && (
        <ul className="font-mono">
          {worktree.files.map((f) => (
            <li key={f.path} className="flex gap-2">
              <span className="truncate">{f.path}</span>
              {worktree.path && <FileActions path={joinPath(worktree.path, f.path)} />}
              <span className="ml-auto text-ok">+{f.added}</span>
              <span className="text-error">−{f.removed}</span>
            </li>
          ))}
        </ul>
      )}
      {worktree.diff && (
        <pre className="max-h-96 overflow-auto font-mono leading-relaxed">
          <Highlight code={worktree.diff} language="diff" />
        </pre>
      )}
      {worktree.cut && (
        <div className="text-muted">The diff was cut short; the rest is in the worktree.</div>
      )}
    </div>
  );
}

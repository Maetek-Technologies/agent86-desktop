import { useEffect, useRef, type KeyboardEvent } from "react";
import type { Answer, ApprovalInfo, AskerInfo } from "../desktop-client/events.ts";
import { formatUsd } from "../thread/format.ts";
import { argumentSummary, isUnifiedDiff, parseApprovalText, type Detail } from "./approval.ts";
import { DetailView } from "./DetailView.tsx";
import { FileDiffs } from "./DiffView.tsx";

type Choice = Extract<Answer, { type: "approval" }>["choice"];

/** Which sub-agent asks, where it works, and what it has spent. */
function Asker({ asker }: { asker: AskerInfo }) {
  return (
    <div
      data-testid="asker"
      className="space-y-1 rounded border border-border bg-panel-2 p-2 text-xs"
      aria-label="Who asks"
    >
      <div>
        Asked by the sub-agent <span className="font-mono font-semibold">{asker.agent}</span>
        {asker.depth > 1 && <span className="text-muted"> (nested {asker.depth} deep)</span>}
      </div>
      {asker.worktreePath && (
        <div title={asker.worktreePath}>
          Works in an isolated worktree
          {asker.worktreeBranch && (
            <>
              {" "}
              on <span className="font-mono">{asker.worktreeBranch}</span>
            </>
          )}
        </div>
      )}
      {asker.steps > 0 && (
        <div className="text-muted">
          its spend {formatUsd(asker.costUsd)} ({asker.steps} model call
          {asker.steps === 1 ? "" : "s"})
        </div>
      )}
    </div>
  );
}

/** What the call would do, from agent86's preview text and its language. */
function previewDetail(tool: string, preview: ApprovalInfo): Detail | null {
  const text = preview.detail;
  if (!text) return null;
  if (preview.lexer === "diff" || isUnifiedDiff(text)) return { type: "diff", diff: text };
  if (preview.lexer === "bash" || preview.lexer === "python") {
    return { type: "code", language: preview.lexer, code: text };
  }
  return parseApprovalText(text, tool).detail;
}

/** The call's arguments in one line: the command, the path, or the JSON. */
function oneLine(tool: string, summary: string): string {
  try {
    return argumentSummary(tool, JSON.parse(summary));
  } catch {
    return summary;
  }
}

/**
 * The approval for one tool call (agent86-web's design, docs/UI_DESIGN.md §4 there). It is styled
 * unlike anything the model can write. Number keys pick an option and Esc rejects. Focus moves to
 * the panel, not to a button, so a stray Enter approves nothing.
 */
export function PermissionPanel({
  tool,
  preview,
  onAnswer,
}: {
  tool: string;
  preview: ApprovalInfo;
  onAnswer: (choice: Choice) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const detail = previewDetail(tool, preview);
  const summary = oneLine(tool, preview.summary);
  const options: { choice: Choice; label: string; allow: boolean }[] = [
    { choice: "allowOnce", label: "Allow once", allow: true },
    { choice: "allowAlways", label: `Always allow ${tool} in this thread`, allow: true },
    { choice: "reject", label: "Reject", allow: false },
  ];

  useEffect(() => {
    const active = document.activeElement;
    const typing = active instanceof HTMLTextAreaElement && active.value.length > 0;
    if (!typing) ref.current?.focus({ preventScroll: true });
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onAnswer("reject");
      return;
    }
    const option = options[Number(event.key) - 1];
    if (option) {
      event.preventDefault();
      event.stopPropagation();
      onAnswer(option.choice);
    }
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="group"
      aria-label={`Approval needed: ${tool}`}
      onKeyDown={onKeyDown}
      className="space-y-3 rounded-md border-2 border-warn bg-panel p-3 outline-none focus:ring-2 focus:ring-warn/40"
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-warn">
        <span aria-hidden>⚠</span>
        <span className="min-w-0">
          Agent 86 wants to run <span className="font-mono">{tool}</span>
          {summary && <span className="font-mono font-normal break-all text-text"> {summary}</span>}
        </span>
      </div>
      {preview.asker && <Asker asker={preview.asker} />}
      {preview.warning && (
        <div role="note" className="rounded border border-warn bg-warn/10 p-2 text-sm">
          <strong>Warning:</strong> {preview.warning}
        </div>
      )}
      {preview.change ? (
        <FileDiffs diffs={[preview.change]} />
      ) : (
        detail && <DetailView detail={detail} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {options.map((option, i) => (
          <button
            key={option.choice}
            type="button"
            onClick={() => onAnswer(option.choice)}
            className={
              option.allow
                ? "rounded bg-accent px-3 py-1 text-sm font-medium text-bg hover:opacity-90"
                : "rounded border border-border px-3 py-1 text-sm hover:border-error hover:text-error"
            }
          >
            <span className="mr-1.5 font-mono text-xs opacity-70">{i + 1}</span>
            {option.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted">Esc rejects</span>
      </div>
    </div>
  );
}

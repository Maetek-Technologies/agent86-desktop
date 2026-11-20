import type { TurnInfo, UsageInfo } from "../desktop-client/events.ts";
import { contextPercent, formatCost, formatTokens } from "./format.ts";

/** One line under a finished turn: steps, tool calls, tokens, cost, and time. */
export function TurnSummaryLine({ turn, cancelled }: { turn: TurnInfo; cancelled: boolean }) {
  const parts = [
    `${turn.steps} step${turn.steps === 1 ? "" : "s"}`,
    `${turn.toolCalls} tool call${turn.toolCalls === 1 ? "" : "s"}`,
    `${formatTokens(turn.inputTokens)} in / ${formatTokens(turn.outputTokens)} out`,
  ];
  if (turn.costUsd > 0) parts.push(formatCost(turn.costUsd));
  parts.push(`${turn.durationS.toFixed(1)}s`);
  return (
    <div className="my-2 font-mono text-xs text-muted" data-testid="turn-summary">
      {cancelled ? "⊘ cancelled · " : "✓ "}
      {parts.join(" · ")}
    </div>
  );
}

/** How full the context window is after the last model call, and the session's spend. */
export function ContextMeter({
  lastStep,
  session,
  contextWindow,
}: {
  lastStep: UsageInfo | null;
  session: UsageInfo | null;
  contextWindow: number;
}) {
  if (!session) return null;
  const used = lastStep ? lastStep.inputTokens + lastStep.outputTokens : 0;
  const percent = contextPercent(used, contextWindow);
  const tone = percent >= 90 ? "bg-error" : percent >= 70 ? "bg-warn" : "bg-accent";
  return (
    <div
      className="flex items-center gap-2 text-xs text-muted"
      title={`Context: ${used.toLocaleString()} of ${contextWindow.toLocaleString()} tokens. Session: ${session.inputTokens.toLocaleString()} in, ${session.outputTokens.toLocaleString()} out.`}
    >
      {contextWindow > 0 && (
        <>
          <div
            className="h-1.5 w-16 overflow-hidden rounded bg-panel-2"
            role="meter"
            aria-label="Context used"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className={`h-full ${tone}`} style={{ width: `${percent}%` }} />
          </div>
          <span>{percent}%</span>
        </>
      )}
      <span>
        {formatTokens(session.inputTokens)} / {formatTokens(session.outputTokens)} tok
      </span>
      {session.costUsd > 0 && <span>{formatCost(session.costUsd)}</span>}
    </div>
  );
}

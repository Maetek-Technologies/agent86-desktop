import { useEffect, useRef, type KeyboardEvent } from "react";
import type { LimitInfo } from "../desktop-client/events.ts";

const UNIT: Record<LimitInfo["kind"], string> = {
  steps: "steps",
  agent_steps: "steps",
  output: "tokens",
};

/**
 * The turn reached a limit: raise it to one of agent86's offers, or stop there. Number keys pick
 * an offer; Esc stops.
 */
export function LimitPanel({
  limit,
  onAnswer,
}: {
  limit: LimitInfo;
  onAnswer: (value: number | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const unit = UNIT[limit.kind];

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onAnswer(null);
      return;
    }
    const offer = limit.offers[Number(event.key) - 1];
    if (offer !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      onAnswer(offer);
    }
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="group"
      aria-label="Limit reached"
      onKeyDown={onKeyDown}
      className="space-y-3 rounded-md border-2 border-warn bg-panel p-3 outline-none focus:ring-2 focus:ring-warn/40"
    >
      <div className="text-sm font-semibold text-warn">{limit.headline}</div>
      <p className="text-sm text-muted">
        Raise the limit to go on
        {limit.runOnly ? " (for this sub-agent run only)" : " (for the rest of this thread)"}, or
        stop here.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {limit.offers.map((offer, i) => (
          <button
            key={offer}
            type="button"
            onClick={() => onAnswer(offer)}
            className="rounded bg-accent px-3 py-1 text-sm font-medium text-bg hover:opacity-90"
          >
            <span className="mr-1.5 font-mono text-xs opacity-70">{i + 1}</span>
            Raise to {offer.toLocaleString()} {unit}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onAnswer(null)}
          className="rounded border border-border px-3 py-1 text-sm hover:border-error hover:text-error"
        >
          Stop here
        </button>
        <span className="ml-auto text-xs text-muted">Esc stops</span>
      </div>
    </div>
  );
}

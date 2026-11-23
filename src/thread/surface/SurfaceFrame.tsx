// The frame every agent86UI surface is drawn in (docs/agent86ui.md: "inside a frame that names
// the agent, and never in the style of an approval prompt"). A dashed border and header strip in
// the `agent` hue, which nothing of the app's own uses: agent86's approval and secret panels are
// solid and warn-coloured. Whatever the model draws stays inside this frame.

import type { ReactNode } from "react";

interface Props {
  surfaceId: string;
  /** The model that drew it, as the thread header names it. */
  model: string;
  /** The running turn waits for the user's action on this surface. */
  waiting: boolean;
  /** Presses held for the running turn to end. */
  held: number;
  /** Answer the waiting turn with "dismissed". */
  onDismiss?: () => void;
  children: ReactNode;
}

export function SurfaceFrame({ surfaceId, model, waiting, held, onDismiss, children }: Props) {
  return (
    <section
      aria-label={`Drawn by the agent: ${surfaceId}`}
      data-surface={surfaceId}
      className={`my-3 rounded-md border border-dashed bg-agent-tint ${waiting ? "border-agent" : "border-agent/50"}`}
    >
      <header className="flex items-center gap-2 border-b border-dashed border-agent/40 px-3 py-1 text-xs text-agent">
        <span aria-hidden>⧉</span>
        <span className="min-w-0 truncate">Drawn by the agent · {model}</span>
        {waiting && (
          <span className="rounded bg-agent/15 px-1.5 py-0.5 text-text" role="status">
            The agent is waiting for your answer here
          </span>
        )}
        {held > 0 && (
          <span className="text-muted" role="status">
            Sends when the turn ends
          </span>
        )}
        <span className="flex-1" />
        {waiting && onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2 hover:text-text"
            title="Let the agent carry on without an answer; the surface stays up"
          >
            Dismiss
          </button>
        )}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

/** Where a surface the agent deleted used to be. */
export function RemovedSurface({ surfaceId }: { surfaceId: string }) {
  return (
    <div className="my-2 text-xs text-muted">
      <span aria-hidden className="text-agent">
        ⧉
      </span>{" "}
      The agent removed the surface <span className="font-mono">{surfaceId}</span>.
    </div>
  );
}

/**
 * The app asking before it opens a link a surface's `openUrl` asked for. The URL is shown whole,
 * since it is known only now (a binding or a function may have built it); only http and https
 * can be opened, and Rust checks again.
 */
export function LinkConfirm({
  url,
  onOpen,
  onCancel,
}: {
  url: string;
  onOpen: () => void;
  onCancel: () => void;
}) {
  const parsed = parse(url);
  const web = parsed !== null && (parsed.protocol === "http:" || parsed.protocol === "https:");
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-bg/70 p-4">
      <div
        role="alertdialog"
        aria-label="Open a link from the agent's surface"
        className="w-full max-w-lg space-y-3 rounded-md border border-border bg-panel p-4 shadow-xl"
      >
        <div className="text-sm font-semibold">
          {web ? "Open this link in your browser?" : "This link can't be opened"}
        </div>
        <p className="text-xs text-muted">
          A surface the agent drew asked to open it.
          {!web && " Only http and https links open from a surface."}
        </p>
        <div className="rounded border border-border bg-panel-2 px-2 py-1 font-mono text-xs break-all">
          {url}
        </div>
        {web && parsed && (
          <p className="text-xs">
            It goes to <span className="font-mono font-semibold">{parsed.host}</span>.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1 text-sm text-muted hover:bg-panel-2 hover:text-text"
          >
            {web ? "Cancel" : "Close"}
          </button>
          {web && (
            <button
              type="button"
              onClick={onOpen}
              className="rounded border border-border px-3 py-1 text-sm hover:bg-panel-2"
            >
              Open link
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

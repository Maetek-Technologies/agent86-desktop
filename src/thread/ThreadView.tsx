import { useEffect, useRef } from "react";
import type { OpenedThread } from "../desktop-client/backend.ts";
import type { Entry, SessionState } from "../desktop-client/session-state.ts";
import { Markdown } from "../markdown/Markdown.tsx";
import { PromptBox } from "./PromptBox.tsx";
import { ToolCard } from "./ToolCard.tsx";

interface Props {
  thread: OpenedThread;
  state: SessionState;
  onSend: (text: string) => void;
  onStop: () => void;
  onClose: () => void;
}

export function ThreadView({ thread, state, onSend, onStop, onClose }: Props) {
  const bottom = useRef<HTMLDivElement>(null);
  const last = state.entries.at(-1);
  const lastLength = last && "text" in last ? last.text.length : 0;

  // Follow the stream as it grows.
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [state.entries.length, lastLength]);

  return (
    <div className="flex h-screen flex-col bg-bg text-text">
      <header className="flex items-center gap-3 border-b border-border bg-panel px-4 py-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-mono" title={thread.workspace}>
          {thread.workspace}
        </span>
        <span className="font-mono text-xs text-muted">{thread.model}</span>
        {state.usage && (
          <span className="text-xs text-muted" title="Session tokens in / out">
            {state.usage.inputTokens.toLocaleString()} / {state.usage.outputTokens.toLocaleString()}{" "}
            tok
            {state.usage.costUsd > 0 && ` · $${state.usage.costUsd.toFixed(4)}`}
          </span>
        )}
        <button
          type="button"
          className="rounded px-2 py-0.5 text-xs text-muted hover:bg-panel-2 hover:text-text"
          onClick={onClose}
        >
          Close
        </button>
      </header>
      <div className="border-b border-border bg-panel-2 px-4 py-1 text-xs text-muted">
        M1 preview: the agent can read and search this folder. Writes and commands are declined
        until approvals arrive (M2).
      </div>
      <main className="flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
        <div className="mx-auto max-w-4xl">
          {state.entries.map((entry) => (
            <EntryView key={entry.id} entry={entry} />
          ))}
          {state.running && !state.cancelling && last?.kind !== "agent" && (
            <div className="my-2 text-sm text-muted">Working…</div>
          )}
          <div ref={bottom} />
        </div>
      </main>
      <PromptBox
        running={state.running}
        cancelling={state.cancelling}
        onSend={onSend}
        onStop={onStop}
      />
    </div>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case "user":
      return (
        <div className="my-3 rounded-md bg-panel-2 px-3 py-2 text-sm whitespace-pre-wrap">
          {entry.text}
        </div>
      );
    case "agent":
      return (
        <div className="my-2 text-sm">
          <Markdown text={entry.text} />
        </div>
      );
    case "thought":
      return (
        <details className="my-2 text-sm text-muted">
          <summary className="cursor-pointer select-none">Thinking</summary>
          <div className="mt-1 border-l-2 border-border pl-3 whitespace-pre-wrap">{entry.text}</div>
        </details>
      );
    case "notice":
      return <div className="my-2 font-mono text-xs text-muted">{entry.text}</div>;
    case "error":
      return (
        <div className="my-2 rounded-md border border-error px-3 py-2 text-sm text-error">
          {entry.text}
        </div>
      );
    case "tool":
      return <ToolCard entry={entry} />;
  }
}

import { useEffect, useRef } from "react";
import type { OpenedThread } from "../desktop-client/backend.ts";
import type { Answer } from "../desktop-client/events.ts";
import type { Entry, Question, SessionState } from "../desktop-client/session-state.ts";
import { Markdown } from "../markdown/Markdown.tsx";
import { SecretPrompt } from "../secrets/SecretPrompt.tsx";
import { PermissionPanel } from "../tools/PermissionPanel.tsx";
import { LimitPanel } from "./LimitPanel.tsx";
import { PromptBox } from "./PromptBox.tsx";
import { ThreadContext } from "./ThreadContext.ts";
import { ToolCard } from "./ToolCard.tsx";

interface Props {
  thread: OpenedThread;
  state: SessionState;
  onSend: (text: string) => void;
  onStop: () => void;
  onAnswer: (qid: number, answer: Answer) => void;
  onClose: () => void;
}

export function ThreadView({ thread, state, onSend, onStop, onAnswer, onClose }: Props) {
  const bottom = useRef<HTMLDivElement>(null);
  const last = state.entries.at(-1);
  const lastLength = last && "text" in last ? last.text.length : 0;
  // agent86 asks one question at a time; the oldest open one is the one it waits on.
  const question = state.questions[0];

  // Follow the stream as it grows.
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [state.entries.length, lastLength]);

  return (
    <ThreadContext.Provider value={{ cwd: thread.workspace }}>
      <div className="relative flex h-screen flex-col bg-bg text-text">
        <header className="flex items-center gap-3 border-b border-border bg-panel px-4 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate font-mono" title={thread.workspace}>
            {thread.workspace}
          </span>
          <span className="font-mono text-xs text-muted">{thread.model}</span>
          {state.usage && (
            <span className="text-xs text-muted" title="Session tokens in / out">
              {state.usage.inputTokens.toLocaleString()} /{" "}
              {state.usage.outputTokens.toLocaleString()} tok
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
        <main className="flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
          <div className="mx-auto max-w-4xl">
            {state.entries.map((entry) => (
              <EntryView key={entry.id} entry={entry} />
            ))}
            {state.running && !state.cancelling && !question && last?.kind !== "agent" && (
              <div className="my-2 text-sm text-muted">Working…</div>
            )}
            <div ref={bottom} />
          </div>
        </main>
        {question && question.kind !== "secret" && (
          <div className="max-h-[60vh] overflow-y-auto border-t border-border bg-bg px-4 py-3">
            <div className="mx-auto max-w-4xl">
              <QuestionPanel key={question.qid} question={question} onAnswer={onAnswer} />
            </div>
          </div>
        )}
        <PromptBox
          running={state.running}
          cancelling={state.cancelling}
          onSend={onSend}
          onStop={onStop}
          questionOpen={question !== undefined}
        />
        {question?.kind === "secret" && (
          <SecretPrompt
            key={question.qid}
            name={question.name}
            reason={question.reason}
            replacing={question.replacing}
            onEnter={(value) => onAnswer(question.qid, { type: "secret", value })}
            onDecline={() => onAnswer(question.qid, { type: "secret", value: null })}
          />
        )}
      </div>
    </ThreadContext.Provider>
  );
}

function QuestionPanel({
  question,
  onAnswer,
}: {
  question: Exclude<Question, { kind: "secret" }>;
  onAnswer: (qid: number, answer: Answer) => void;
}) {
  switch (question.kind) {
    case "approval":
      return (
        <PermissionPanel
          tool={question.tool}
          preview={question.preview}
          onAnswer={(choice) => onAnswer(question.qid, { type: "approval", choice })}
        />
      );
    case "limit":
      return (
        <LimitPanel
          limit={question.limit}
          onAnswer={(value) => onAnswer(question.qid, { type: "limit", value })}
        />
      );
  }
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

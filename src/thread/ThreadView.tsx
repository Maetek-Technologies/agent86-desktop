import { useEffect, useMemo, useRef, useState } from "react";
import { commandsFor } from "../desktop-client/commands.ts";
import type { Answer, OpenedThread } from "../desktop-client/events.ts";
import type { Entry, Question, SessionState } from "../desktop-client/session-state.ts";
import { Markdown } from "../markdown/Markdown.tsx";
import { SecretPrompt } from "../secrets/SecretPrompt.tsx";
import { SecretsPanel } from "../secrets/SecretsPanel.tsx";
import { TrustBanner, TrustDialog } from "../trust/TrustDialog.tsx";
import { PermissionPanel } from "../tools/PermissionPanel.tsx";
import { LimitPanel } from "./LimitPanel.tsx";
import { PromptInput } from "./PromptInput.tsx";
import { ContextMeter, TurnSummaryLine } from "./Spend.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { ThreadContext } from "./ThreadContext.ts";
import { ToolCard } from "./ToolCard.tsx";

interface Props {
  thread: OpenedThread;
  state: SessionState;
  onSend: (text: string, mentions: string[]) => void;
  onStop: () => void;
  onAnswer: (qid: number, answer: Answer) => void;
  findFiles: (query: string) => Promise<string[]>;
  /** The secrets panel is open beside the transcript. */
  secretsOpen: boolean;
  onSecrets: (open: boolean) => void;
  /** Rebuild the thread with the current settings and trust, keeping its conversation. */
  onReload: () => void;
  /** A reload is under way. */
  reloading: boolean;
  /** Switch this thread's model (`""`: back to the settings' model). */
  onModel: (reference: string) => void;
}

export function ThreadView({
  thread,
  state,
  onSend,
  onStop,
  onAnswer,
  findFiles,
  secretsOpen,
  onSecrets,
  onReload,
  reloading,
  onModel,
}: Props) {
  const [reviewing, setReviewing] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const last = state.entries.at(-1);
  const lastLength = last && "text" in last ? last.text.length : 0;
  // agent86 asks one question at a time; the oldest open one is the one it waits on.
  const question = state.questions[0];
  const commands = useMemo(() => commandsFor(thread.capabilities), [thread.capabilities]);

  // Follow the stream as it grows.
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [state.entries.length, lastLength, question]);

  return (
    <ThreadContext.Provider value={{ cwd: thread.workspace, threadId: thread.threadId }}>
      <div className="relative flex h-full flex-col bg-bg text-text">
        <header className="flex items-center gap-3 border-b border-border bg-panel px-4 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate font-mono" title={thread.workspace}>
            {thread.workspace}
          </span>
          <ModelPicker
            model={thread.model}
            ownModel={thread.ownModel}
            disabled={state.running}
            switching={reloading}
            onChoose={onModel}
          />
          <ContextMeter
            lastStep={state.lastStep}
            session={state.usage}
            contextWindow={thread.contextWindow}
          />
          <button
            type="button"
            onClick={() => onSecrets(!secretsOpen)}
            aria-pressed={secretsOpen}
            title="This thread's secrets"
            className={`rounded px-1.5 text-xs hover:bg-panel-2 ${secretsOpen ? "bg-panel-2 text-text" : "text-muted"}`}
          >
            🔑 Secrets
          </button>
          <button
            type="button"
            onClick={onReload}
            disabled={state.running || reloading}
            title="Reload this thread with the current settings and project trust, keeping the conversation"
            className="rounded px-1.5 text-xs text-muted hover:bg-panel-2 hover:text-text disabled:opacity-40"
          >
            {reloading ? "Reloading…" : "↻ Reload"}
          </button>
        </header>
        {thread.project && (
          <TrustBanner
            key={`${thread.project.state}-${thread.project.skills.length}`}
            project={thread.project}
            onReview={() => setReviewing(true)}
          />
        )}
        {thread.memoryNote && (
          <div
            className="border-b border-border bg-panel-2 px-4 py-1 text-xs text-warn"
            role="note"
          >
            {thread.memoryNote}
          </div>
        )}
        {thread.notes.map((note) => (
          <div
            key={note}
            className="border-b border-border bg-panel-2 px-4 py-1 text-xs text-muted"
            role="note"
          >
            {note}
          </div>
        ))}
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-y-auto px-4 py-3" aria-live="polite">
            <div className="mx-auto max-w-4xl">
              {state.entries.length === 0 && <Welcome thread={thread} />}
              {state.entries.map((entry) => (
                <EntryView key={entry.id} entry={entry} />
              ))}
              {state.running && !state.cancelling && !question && last?.kind !== "agent" && (
                <div className="my-2 text-sm text-muted">Working…</div>
              )}
              <div ref={bottom} />
            </div>
          </main>
          {secretsOpen && (
            <div className="w-80 shrink-0 border-l border-border">
              <SecretsPanel threadId={thread.threadId} onClose={() => onSecrets(false)} />
            </div>
          )}
        </div>
        {question && question.kind !== "secret" && (
          <div className="max-h-[60vh] overflow-y-auto border-t border-border bg-bg px-4 py-3">
            <div className="mx-auto max-w-4xl">
              <QuestionPanel key={question.qid} question={question} onAnswer={onAnswer} />
            </div>
          </div>
        )}
        <PromptInput
          workspace={thread.workspace}
          running={state.running}
          cancelling={state.cancelling}
          commands={commands}
          findFiles={findFiles}
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
            canRemember={question.canRemember}
            onEnter={(value, remember) =>
              onAnswer(question.qid, { type: "secret", value, remember })
            }
            onDecline={() =>
              onAnswer(question.qid, { type: "secret", value: null, remember: false })
            }
          />
        )}
        {reviewing && (
          <TrustDialog
            threadId={thread.threadId}
            onCancel={() => setReviewing(false)}
            onTrusted={() => {
              setReviewing(false);
              onReload();
            }}
          />
        )}
      </div>
    </ThreadContext.Provider>
  );
}

function Welcome({ thread }: { thread: OpenedThread }) {
  const { skills, specialists } = thread.capabilities;
  return (
    <div className="my-6 text-sm text-muted">
      <p>
        Ask about this folder, or type <span className="font-mono text-text">/</span> for commands
        and <span className="font-mono text-text">@</span> to mention a file.
      </p>
      {(skills.length > 0 || specialists.length > 0) && (
        <p className="mt-1">
          {skills.length} skill{skills.length === 1 ? "" : "s"} and {specialists.length} specialist
          {specialists.length === 1 ? "" : "s"} available.
        </p>
      )}
    </div>
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
    case "list":
      return (
        <div className="my-3 rounded-md border border-border bg-panel p-3 text-sm">
          <div className="mb-2 font-semibold">{entry.title}</div>
          {entry.items.length === 0 ? (
            <div className="text-muted">None.</div>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {entry.items.map((item) => (
                <li key={item} className="rounded bg-panel-2 px-2 py-0.5 font-mono text-xs">
                  {item}
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    case "turnSummary":
      return <TurnSummaryLine turn={entry.turn} cancelled={entry.cancelled} />;
  }
}

// The card of an `ask_user` call (agent86-core 1.2.2): the agent's questions and your answers.

import {
  answerText,
  askOutcome,
  parseAskAnswers,
  parseAskCall,
  type AskOutcome,
} from "../desktop-client/ask.ts";
import type { ToolEntry } from "../desktop-client/session-state.ts";

const ASK_STATUS: Record<AskOutcome | "running", string> = {
  running: "waiting for your answers",
  answered: "answered",
  dismissed: "dismissed",
  unanswered: "not answered",
};

/**
 * An `ask_user` call: the questions the agent asked and, once sent, your answers, readable rather
 * than as JSON. agent86 draws the form itself, right below; the card opens by itself only when no
 * form is shown (a reopened session, where agent86 does not draw it again), so it is the record,
 * or when agent86 refused the questions without drawing a form, to say why.
 */
export function AskUserCard({ entry, formShown }: { entry: ToolEntry; formShown: boolean }) {
  const call = parseAskCall(entry.arguments);
  const outcome =
    entry.status === "running" ? "running" : askOutcome(entry.status === "completed", entry.output);
  const answers = parseAskAnswers(entry.output);
  const count = call.questions.length;
  const open = !formShown && (answers !== null || entry.status === "failed");
  return (
    <details className="my-1 text-xs text-muted" open={open ? true : undefined}>
      <summary className="cursor-pointer select-none">
        <span className="text-agent">?</span> Questions · {ASK_STATUS[outcome]}
        {call.title
          ? ` · ${call.title}`
          : count
            ? ` · ${count} question${count === 1 ? "" : "s"}`
            : ""}
      </summary>
      {count > 0 && (
        <dl className="mt-1 space-y-1 rounded border border-border bg-panel-2 p-2 text-text">
          {call.questions.map((question) => {
            const value = answers?.answers[question.id];
            return (
              <div key={question.id || question.question}>
                <dt className="text-muted">
                  {question.question}
                  {question.optional ? " (optional)" : ""}
                </dt>
                {answers && (
                  <dd className="pl-3">
                    {answerText(value)}
                    {answers.typed.includes(question.id) ? (
                      <span className="text-muted"> (in your own words)</span>
                    ) : null}
                  </dd>
                )}
              </div>
            );
          })}
        </dl>
      )}
      {!answers && entry.status !== "running" && entry.output && (
        <pre className="mt-1 overflow-x-auto rounded border border-border bg-panel-2 p-2 whitespace-pre-wrap">
          {entry.output}
        </pre>
      )}
    </details>
  );
}

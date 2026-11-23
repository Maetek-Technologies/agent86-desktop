// `ask_user` (agent86-core 1.2.2, ADR 0006 upstream): the model sends a short list of questions,
// agent86 builds the form itself and draws it as an agent86UI surface named `agent86_ask_<n>`,
// waits for its Send, and takes it down again. This reads the call and its result for the card,
// and names how the questions ended for the form's frame.

/** `ask::FORM_SURFACE_PREFIX`: the surfaces of the forms agent86 builds for `ask_user`. The model
 * cannot draw one (`render_ui` refuses the prefix). */
export const ASK_SURFACE_PREFIX = "agent86_ask_";

export const ASK_USER = "ask_user";

export function isAskSurface(surfaceId: string): boolean {
  return surfaceId.startsWith(ASK_SURFACE_PREFIX);
}

/** How a call's questions ended: answered, closed without answering, or neither (the turn was
 * stopped, or the answers were refused). */
export type AskOutcome = "answered" | "dismissed" | "unanswered";

/** The first line of the result when the user answered (`ask::Accepted::text`). */
const ANSWERED = "The user answered:";

export function askOutcome(ok: boolean, output: string | undefined): AskOutcome {
  if (!ok) return "unanswered";
  return output?.startsWith(ANSWERED) ? "answered" : "dismissed";
}

export interface AskQuestion {
  id: string;
  question: string;
  kind: string;
  options: string[];
  optional: boolean;
}

export interface AskCall {
  title: string | null;
  questions: AskQuestion[];
}

/** The questions an `ask_user` call asked, read as agent86 reads them (`ask::Form::parse`): it
 * takes a few other names models use, and `questions` may arrive as a JSON string. */
export function parseAskCall(args: Record<string, unknown>): AskCall {
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : null;
  let items: unknown = args.questions;
  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch {
      items = [];
    }
  }
  const questions = (Array.isArray(items) ? items : []).flatMap((item: unknown): AskQuestion[] => {
    if (!item || typeof item !== "object") return [];
    const fields = item as Record<string, unknown>;
    const pick = (...names: string[]) =>
      names.map((name) => fields[name]).find((value) => value !== undefined && value !== null);
    const text = pick("question", "label", "text", "prompt");
    const options = pick("options", "choices");
    const optional = pick("optional");
    const required = pick("required");
    return [
      {
        id: typeof fields.id === "string" ? fields.id : "",
        question: typeof text === "string" ? text.trim() : "",
        kind: String(pick("kind", "type") ?? ""),
        options: Array.isArray(options) ? options.filter((o) => typeof o === "string") : [],
        optional: typeof optional === "boolean" ? optional : required === false,
      },
    ];
  });
  return { title, questions };
}

export interface AskAnswers {
  /** By question id, as agent86 normalized them: text, a number, `true`/`false`, a list for a
   * `multi` question, or `null` when not answered. */
  answers: Record<string, unknown>;
  /** Questions answered in the user's own words ("Other"). */
  typed: string[];
  /** Required questions left unanswered. */
  unanswered: string[];
}

/** The answers in an `ask_user` result: `The user answered:` then one line of JSON, then optional
 * lines naming typed and unanswered ones. `null` for any other result. */
export function parseAskAnswers(output: string | undefined): AskAnswers | null {
  if (!output?.startsWith(ANSWERED)) return null;
  const [, json = "", ...notes] = output.split("\n");
  let answers: unknown;
  try {
    answers = JSON.parse(json);
  } catch {
    return null;
  }
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const listed = (prefix: string) => {
    const line = notes.find((note) => note.startsWith(prefix));
    return line
      ? line
          .slice(prefix.length)
          .replace(/\.$/, "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
      : [];
  };
  return {
    answers: answers as Record<string, unknown>,
    typed: listed("In their own words, not one of the options: "),
    unanswered: listed("Left unanswered: "),
  };
}

/** One answer as the user would say it. */
export function answerText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "No answer";
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (Array.isArray(value)) return value.length ? value.map(answerText).join(", ") : "No answer";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolEntry } from "../desktop-client/session-state.ts";
import { AskUserCard } from "./AskUserCard.tsx";

afterEach(cleanup);

const QUESTIONS = {
  title: "Your weekend trip",
  questions: [
    { id: "from", question: "Where are you leaving from?", kind: "text" },
    { id: "style", question: "What kind of trip?", kind: "choice", options: ["City", "Outdoors"] },
    { id: "nights", question: "How many nights?", kind: "number", optional: true },
  ],
};

function call(overrides: Partial<ToolEntry>): ToolEntry {
  return {
    kind: "tool",
    id: 1,
    toolCallId: "c1",
    name: "ask_user",
    title: "ask_user(...)",
    arguments: QUESTIONS,
    status: "running",
    ...overrides,
  };
}

const ANSWERED =
  'The user answered:\n{"from": "Boston", "style": "A food tour", "nights": null}\n' +
  "In their own words, not one of the options: style.";

describe("AskUserCard", () => {
  it("says the agent is waiting, with the questions, while the form is up", () => {
    const { container } = render(<AskUserCard entry={call({})} formShown />);
    expect(
      screen.getByText(/Questions · waiting for your answers · Your weekend trip/),
    ).toBeTruthy();
    expect(screen.getByText("Where are you leaving from?")).toBeTruthy();
    expect(container.querySelector("details")?.open).toBe(false);
  });

  it("shows the answers readably, not as JSON", () => {
    const { container } = render(
      <AskUserCard entry={call({ status: "completed", output: ANSWERED })} formShown />,
    );
    expect(screen.getByText(/Questions · answered · Your weekend trip/)).toBeTruthy();
    const text = container.textContent ?? "";
    expect(text).toContain("Where are you leaving from?Boston");
    expect(text).toContain("What kind of trip?A food tour (in your own words)");
    expect(text).toContain("How many nights? (optional)No answer");
    expect(text).not.toContain("{");
    // The kept form shows them right below, so the card stays folded.
    expect(container.querySelector("details")?.open).toBe(false);
  });

  it("opens by itself when no form is shown, as in a reopened session", () => {
    const { container } = render(
      <AskUserCard entry={call({ status: "completed", output: ANSWERED })} formShown={false} />,
    );
    expect(container.querySelector("details")?.open).toBe(true);
  });

  it("says the questions were dismissed, or not answered", () => {
    const dismissed = render(
      <AskUserCard
        entry={call({
          status: "completed",
          output: "The user closed the form without answering. Do not ask these questions again.",
        })}
        formShown
      />,
    );
    expect(screen.getByText(/Questions · dismissed/)).toBeTruthy();
    expect(dismissed.container.textContent).not.toContain("No answer");
    dismissed.unmount();

    render(
      <AskUserCard
        entry={call({
          status: "failed",
          output: 'questions/1 (style): kind "pick" is not one of choice, multi, text',
          error: "invalid",
        })}
        formShown={false}
      />,
    );
    expect(screen.getByText(/Questions · not answered/)).toBeTruthy();
    expect(screen.getByText(/kind "pick" is not one of/)).toBeTruthy();
  });

  it("counts the questions when there is no title", () => {
    render(
      <AskUserCard entry={call({ arguments: { questions: QUESTIONS.questions } })} formShown />,
    );
    expect(screen.getByText(/Questions · waiting for your answers · 3 questions/)).toBeTruthy();
  });
});

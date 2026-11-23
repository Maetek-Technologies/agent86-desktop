import { describe, expect, it } from "vitest";
import { answerText, askOutcome, isAskSurface, parseAskAnswers, parseAskCall } from "./ask.ts";

describe("ask_user calls and results", () => {
  it("knows agent86's form surfaces by their prefix", () => {
    expect(isAskSurface("agent86_ask_3")).toBe(true);
    expect(isAskSurface("agent86_ask_3~12")).toBe(true);
    expect(isAskSurface("form")).toBe(false);
  });

  it("reads the questions as agent86 does, a JSON string and other names included", () => {
    const questions = [
      { id: "from", question: "Where from?", kind: "text" },
      { id: "style", label: "What kind?", type: "choice", choices: ["City", "Outdoors"] },
      { id: "nights", text: "How many nights?", kind: "number", required: false },
    ];
    const read = parseAskCall({ title: " Your trip ", questions: JSON.stringify(questions) });
    expect(read).toEqual({
      title: "Your trip",
      questions: [
        { id: "from", question: "Where from?", kind: "text", options: [], optional: false },
        {
          id: "style",
          question: "What kind?",
          kind: "choice",
          options: ["City", "Outdoors"],
          optional: false,
        },
        { id: "nights", question: "How many nights?", kind: "number", options: [], optional: true },
      ],
    });
    expect(parseAskCall({ questions: "{not json" })).toEqual({ title: null, questions: [] });
  });

  it("reads the answers, and which were typed or left empty", () => {
    const output =
      'The user answered:\n{"from": "Boston", "style": "A food tour", "nights": null, "go": true}\n' +
      "In their own words, not one of the options: style.\nLeft unanswered: nights, when.";
    expect(parseAskAnswers(output)).toEqual({
      answers: { from: "Boston", style: "A food tour", nights: null, go: true },
      typed: ["style"],
      unanswered: ["nights", "when"],
    });
    expect(parseAskAnswers("The user closed the form without answering.")).toBeNull();
    expect(parseAskAnswers(undefined)).toBeNull();
  });

  it("names how the questions ended", () => {
    expect(askOutcome(true, 'The user answered:\n{"a": 1}')).toBe("answered");
    expect(askOutcome(true, "The user closed the form without answering.")).toBe("dismissed");
    expect(askOutcome(false, "The turn was cancelled before the user answered.")).toBe(
      "unanswered",
    );
  });

  it("says each answer as a person would", () => {
    expect(answerText("Boston")).toBe("Boston");
    expect(answerText(["Reduce clutter", "Find files faster"])).toBe(
      "Reduce clutter, Find files faster",
    );
    expect(answerText(true)).toBe("Yes");
    expect(answerText(false)).toBe("No");
    expect(answerText(3)).toBe("3");
    expect(answerText(null)).toBe("No answer");
    expect(answerText([])).toBe("No answer");
  });
});

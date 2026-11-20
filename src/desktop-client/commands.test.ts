import { describe, expect, it } from "vitest";
import { commandsFor, listItems, parseCommand } from "./commands.ts";
import type { Capabilities } from "./events.ts";

const caps: Capabilities = {
  skills: ["code-reviewer", "outline-wiki"],
  specialists: ["explorer", "reviewer"],
  tools: ["read_file", "write_file", "delegate"],
};

describe("parseCommand", () => {
  it("sends plain text as a goal with its mentions", () => {
    expect(parseCommand("  fix @src/a.rs  ", caps, ["src/a.rs"])).toEqual({
      type: "turn",
      turn: { kind: "goal", text: "fix @src/a.rs", mentions: ["src/a.rs"] },
      display: "fix @src/a.rs",
    });
  });

  it("reads the list commands", () => {
    expect(parseCommand("/tools", caps)).toEqual({ type: "list", list: "tools" });
    expect(parseCommand("/agents ", caps)).toEqual({ type: "list", list: "agents" });
  });

  it("runs a skill, with or without a task", () => {
    expect(parseCommand("/code-reviewer check the diff", caps)).toMatchObject({
      type: "turn",
      turn: { kind: "skill", name: "code-reviewer", task: "check the diff" },
    });
    expect(parseCommand("/outline-wiki", caps)).toMatchObject({
      turn: { kind: "skill", name: "outline-wiki", task: "" },
    });
  });

  it("runs a specialist and checks its name and task", () => {
    expect(parseCommand("/agent reviewer look at\nthis", caps)).toMatchObject({
      type: "turn",
      turn: { kind: "specialist", name: "reviewer", task: "look at\nthis", withContext: false },
    });
    expect(parseCommand("/agent reviewer", caps)).toEqual({
      type: "error",
      message: "Usage: /agent <name> <task>",
    });
    expect(parseCommand("/agent ghost do it", caps)).toMatchObject({
      type: "error",
      message: "No specialist named 'ghost'.",
    });
  });

  it("refuses an unknown command rather than sending it to the model", () => {
    expect(parseCommand("/nope", caps)).toMatchObject({ type: "error" });
  });
});

describe("commandsFor", () => {
  it("offers the lists, the panels, /agent, and each skill", () => {
    expect(commandsFor(caps).map((c) => c.name)).toEqual([
      "tools",
      "skills",
      "agents",
      "secrets",
      "memory",
      "agent",
      "code-reviewer",
      "outline-wiki",
    ]);
    expect(
      commandsFor({ skills: [], specialists: [], tools: [] }).map((c) => c.name),
    ).not.toContain("agent");
  });

  it("opens the secrets and memory panels", () => {
    expect(parseCommand("/secrets", caps)).toEqual({ type: "panel", panel: "secrets" });
    expect(parseCommand("/memory", caps)).toEqual({ type: "panel", panel: "memory" });
  });

  it("lists what a thread offers", () => {
    expect(listItems("agents", caps)).toEqual(["explorer", "reviewer"]);
  });
});

// What a line typed into the prompt box asks for: a turn for the agent, or a list the app shows
// itself. agent86's terminal reads the same commands.
import type { Capabilities, TurnRequest } from "./events.ts";

export type ListKind = "tools" | "skills" | "agents";

export type Command =
  | { type: "turn"; turn: TurnRequest; display: string }
  | { type: "list"; list: ListKind }
  | { type: "error"; message: string };

/** One entry of the `/` menu. */
export interface CommandInfo {
  name: string;
  description: string;
  hint?: string;
}

const LISTS: Record<ListKind, string> = {
  tools: "List the tools the model is offered",
  skills: "List the skills you can run",
  agents: "List the specialist sub-agents",
};

/** The `/` menu for a thread: the lists, `/agent` when there are specialists, then each skill. */
export function commandsFor(capabilities: Capabilities): CommandInfo[] {
  const commands: CommandInfo[] = Object.entries(LISTS).map(([name, description]) => ({
    name,
    description,
  }));
  if (capabilities.specialists.length > 0) {
    commands.push({
      name: "agent",
      description: `Run a specialist: ${capabilities.specialists.join(", ")}`,
      hint: "name task",
    });
  }
  for (const skill of capabilities.skills) {
    commands.push({ name: skill, description: "Run this skill", hint: "task" });
  }
  return commands;
}

/** Read a line: `/tools`, `/skills`, `/agents`, `/agent <name> <task>`, `/<skill> [task]`, or a
 * message (with the `@` paths the user picked from the menu). */
export function parseCommand(
  text: string,
  capabilities: Capabilities,
  mentions: string[] = [],
): Command {
  const line = text.trim();
  const slash = /^\/(\S+)\s*([\s\S]*)$/.exec(line);
  if (!slash) return { type: "turn", turn: { kind: "goal", text: line, mentions }, display: line };
  const name = slash[1]!;
  const rest = slash[2]!.trim();
  if (name in LISTS) return { type: "list", list: name as ListKind };
  if (name === "agent") {
    const agent = /^(\S+)\s+([\s\S]+)$/.exec(rest);
    if (!agent) return { type: "error", message: "Usage: /agent <name> <task>" };
    const [, specialist, task] = agent;
    if (!capabilities.specialists.includes(specialist!)) {
      return { type: "error", message: `No specialist named '${specialist}'.` };
    }
    return {
      type: "turn",
      turn: { kind: "specialist", name: specialist!, task: task!.trim(), withContext: false },
      display: line,
    };
  }
  if (capabilities.skills.includes(name)) {
    return { type: "turn", turn: { kind: "skill", name, task: rest }, display: line };
  }
  return {
    type: "error",
    message: `Unknown command /${name}. Type / to see the commands.`,
  };
}

/** What a list shows. */
export function listItems(list: ListKind, capabilities: Capabilities): string[] {
  switch (list) {
    case "tools":
      return capabilities.tools;
    case "skills":
      return capabilities.skills;
    case "agents":
      return capabilities.specialists;
  }
}

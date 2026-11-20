import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandInfo } from "../desktop-client/commands.ts";
import { pickedMentions, PromptInput, tokenAt } from "./PromptInput.tsx";

const commands: CommandInfo[] = [
  { name: "tools", description: "List the tools" },
  { name: "skills", description: "List the skills" },
  { name: "code-reviewer", description: "Run this skill", hint: "task" },
];

function setup(overrides: Partial<Parameters<typeof PromptInput>[0]> = {}) {
  const onSend = vi.fn();
  const onStop = vi.fn();
  const findFiles = vi.fn(async () => ["src/main.rs", "src/mainframe.txt"]);
  const props = {
    workspace: "C:\\w",
    running: false,
    cancelling: false,
    commands,
    findFiles,
    onSend,
    onStop,
    ...overrides,
  };
  const view = render(<PromptInput {...props} />);
  const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
  const type = (text: string) =>
    fireEvent.change(box, { target: { value: text, selectionStart: text.length } });
  return { ...view, box, type, onSend, onStop, findFiles, props };
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("tokens and mentions", () => {
  it("finds the command or mention at the caret", () => {
    expect(tokenAt("/sk", 3)).toEqual({ kind: "command", query: "sk", start: 0 });
    expect(tokenAt("look at @src/ma", 15)).toEqual({ kind: "mention", query: "src/ma", start: 8 });
    expect(tokenAt("a /b", 4)).toBeUndefined();
    expect(tokenAt("email@x.y", 9)).toBeUndefined();
  });

  it("keeps only picked mentions, once each", () => {
    expect(pickedMentions("@a.rs @b.rs @a.rs", new Set(["a.rs"]))).toEqual(["a.rs"]);
  });
});

describe("PromptInput", () => {
  it("offers commands after / and completes one with Enter", () => {
    const { box, type } = setup();
    type("/");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "/toolsList the tools",
      "/skillsList the skills",
      "/code-reviewerRun this skill (task)",
    ]);
    type("/co");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("/code-reviewer ");
  });

  it("offers files after @ and sends the picked ones as mentions", async () => {
    vi.useFakeTimers();
    try {
      const { box, type, onSend, findFiles } = setup();
      type("explain @ma");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(findFiles).toHaveBeenCalledWith("ma");
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
        "src/main.rs",
        "src/mainframe.txt",
      ]);
      fireEvent.keyDown(box, { key: "Enter" });
      expect(box.value).toBe("explain @src/main.rs ");
      fireEvent.keyDown(box, { key: "Enter" });
      expect(onSend).toHaveBeenCalledWith("explain @src/main.rs", ["src/main.rs"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not count a typed @path the user did not pick", () => {
    const { box, type, onSend } = setup();
    type("see @notes.txt");
    fireEvent.keyDown(box, { key: "Escape" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("see @notes.txt", []);
  });

  it("walks this workspace's history with Up and Down", () => {
    const { box, type } = setup();
    type("first");
    fireEvent.keyDown(box, { key: "Enter" });
    type("second");
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.value).toBe("second");
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box.value).toBe("first");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(box.value).toBe("");
  });

  it("lets the next prompt be typed but not sent while a turn runs, and Esc stops", () => {
    const { box, type, onSend, onStop } = setup({ running: true });
    type("next thing");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(box.value).toBe("next thing");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onStop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("takes the focus back when a question closes", () => {
    const { rerender, props, box } = setup({ running: true, questionOpen: true });
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    rerender(<PromptInput {...props} questionOpen={false} />);
    expect(document.activeElement).toBe(box);
    outside.remove();
  });
});

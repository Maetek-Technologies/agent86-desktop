import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolEntry } from "../desktop-client/session-state.ts";
import { ThreadContext } from "./ThreadContext.ts";
import { display, ToolCard } from "./ToolCard.tsx";

afterEach(cleanup);

function entry(overrides: Partial<ToolEntry>): ToolEntry {
  return {
    kind: "tool",
    id: 1,
    toolCallId: "c1",
    name: "read_file",
    title: "read_file(...)",
    arguments: {},
    status: "running",
    ...overrides,
  };
}

describe("display", () => {
  it("names each state as agent86-web does", () => {
    expect(display(entry({ approvalQid: 3 }))).toBe("awaiting");
    expect(display(entry({}))).toBe("running");
    expect(display(entry({ status: "completed" }))).toBe("done");
    expect(display(entry({ status: "failed", error: "Not executed: declined by user." }))).toBe(
      "declined",
    );
    expect(display(entry({ status: "failed", error: "did not finish" }))).toBe("interrupted");
    expect(display(entry({ status: "failed", error: "No such file" }))).toBe("failed");
  });
});

describe("ToolCard", () => {
  it("shows the call, its file relative to the workspace, and its summary", () => {
    render(
      <ThreadContext.Provider value={{ cwd: "C:\\w" }}>
        <ToolCard
          entry={entry({
            name: "read_file",
            arguments: { path: "C:\\w\\src\\main.rs" },
            status: "completed",
            summary: "read_file -> fn main() {",
            output: "fn main() {}\n",
          })}
        />
      </ThreadContext.Provider>,
    );
    expect(screen.getByText("src\\main.rs")).toBeTruthy();
    expect(screen.getByText("read_file -> fn main() {")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
  });

  it("shows an edit's result as a diff", () => {
    const { container } = render(
      <ToolCard
        entry={entry({
          name: "edit_file",
          arguments: { path: "a.txt" },
          status: "completed",
          output:
            "Edited a.txt (1 replacement).\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Edited a.txt (1 replacement).")).toBeTruthy();
    const kinds = [...container.querySelectorAll("[data-kind]")].map((r) =>
      r.getAttribute("data-kind"),
    );
    expect(kinds).toEqual(expect.arrayContaining(["add", "del"]));
  });

  it("shows a command's one-line summary and its error", () => {
    render(
      <ToolCard
        entry={entry({
          name: "run_command",
          arguments: { command: "cargo build\n--release" },
          status: "failed",
          error: "Not executed: declined by user.",
        })}
      />,
    );
    expect(screen.getByText("cargo build")).toBeTruthy();
    expect(screen.getByText("declined")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Not executed: declined by user.")).toBeTruthy();
  });

  it("offers view for a Markdown file when the thread has a document pane", () => {
    const opened: string[] = [];
    const card = (path: string, openFile?: (path: string) => void) => (
      <ThreadContext.Provider value={{ cwd: "/w", threadId: "t1", openFile }}>
        <ToolCard entry={entry({ name: "write_file", arguments: { path }, status: "completed" })} />
      </ThreadContext.Provider>
    );
    const { rerender } = render(card("docs/Plan.MD", (path) => opened.push(path)));
    fireEvent.click(screen.getByRole("button", { name: "view" }));
    expect(opened).toEqual(["docs/Plan.MD"]);
    rerender(card("src/main.rs", (path) => opened.push(path)));
    expect(screen.queryByRole("button", { name: "view" })).toBeNull();
    rerender(card("docs/plan.md"));
    expect(screen.queryByRole("button", { name: "view" })).toBeNull();
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openPath, readTextFile } from "../desktop-client/backend.ts";
import { DocumentPane } from "./DocumentPane.tsx";
import { useDocuments, type Documents } from "./useDocuments.ts";

vi.mock("../desktop-client/backend.ts", () => ({
  openDocumentLink: vi.fn(() => Promise.resolve()),
  openPath: vi.fn(() => Promise.resolve()),
  readTextFile: vi.fn(),
}));

const FILES: Record<string, string> = {
  "/ws/docs/plan.md": "# Plan\n\nSee [the steps](steps.md) and src/app.ts:4.",
  "/ws/docs/steps.md": "# Steps\n\n1. Do it.",
};

const handle: { current: Documents | null } = { current: null };
function Harness() {
  const documents = useDocuments("t1");
  useEffect(() => {
    handle.current = documents;
  });
  return (
    <div>
      <button type="button">outside</button>
      <DocumentPane threadId="t1" documents={documents} />
    </div>
  );
}
/** The pane's controls, as the thread view hands them out. */
const docs = () => handle.current!;

// The viewer loads its renderer on first use; load it up front, so a cold module transform
// (mdglass, DOMPurify, grammars) does not count against the waits below.
beforeAll(() => import("./viewer-engine.ts"), 30_000);

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(readTextFile).mockImplementation((_thread, path) =>
    path in FILES
      ? Promise.resolve({ path, text: FILES[path]! })
      : Promise.reject(`${path}: No such file or directory`),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DocumentPane", () => {
  it("is closed until a document opens", () => {
    render(<Harness />);
    expect(screen.queryByRole("complementary", { name: "Document" })).toBeNull();
  });

  it("loads a file, follows a link to another, and goes back", async () => {
    render(<Harness />);
    act(() => docs().openFile("/ws/docs/plan.md"));
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(readTextFile).toHaveBeenCalledWith("t1", "/ws/docs/plan.md");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();

    fireEvent.click(screen.getByText("the steps"));
    expect(await screen.findByRole("heading", { name: "Steps" })).toBeTruthy();
    expect(readTextFile).toHaveBeenLastCalledWith("t1", "/ws/docs/steps.md");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Plan" })).toBeTruthy();

    // A reference to a source file opens it with its default app, from the workspace.
    fireEvent.click(screen.getByText("src/app.ts:4"));
    expect(openPath).toHaveBeenCalledWith("t1", "src/app.ts", false);
  });

  it("shows a file it cannot read, and a reply as a document", async () => {
    render(<Harness />);
    act(() => docs().openFile("/ws/missing.md"));
    expect((await screen.findByRole("alert")).textContent).toContain("No such file");
    act(() => docs().openDocument("Reply", "## Answer\n\nYes."));
    expect(await screen.findByRole("heading", { name: "Answer" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("takes the focus, closes with Esc or ✕, and gives the focus back", async () => {
    render(<Harness />);
    const outside = screen.getByRole("button", { name: "outside" });
    outside.focus();
    act(() => docs().openDocument("Reply", "# One"));
    const pane = screen.getByRole("complementary", { name: "Document" });
    expect(document.activeElement).toBe(pane);
    await screen.findByRole("heading", { name: "One" });

    fireEvent.keyDown(screen.getByRole("tab", { name: "Raw" }), { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Document" })).toBeNull();
    expect(document.activeElement).toBe(outside);

    act(() => docs().openDocument("Reply", "# Two"));
    fireEvent.click(screen.getByRole("button", { name: "Close document" }));
    expect(screen.queryByRole("complementary", { name: "Document" })).toBeNull();
  });

  it("resizes from its left edge and keeps the width", () => {
    render(<Harness />);
    act(() => docs().openDocument("Reply", "# One"));
    const edge = screen.getByRole("separator", { name: "Resize document pane" });
    expect(edge.getAttribute("aria-valuenow")).toBe("480");
    // The edge is on the left: moving it left makes the pane wider.
    fireEvent.keyDown(edge, { key: "ArrowLeft" });
    expect(edge.getAttribute("aria-valuenow")).toBe("496");
    fireEvent.keyDown(edge, { key: "End" });
    expect(screen.getByRole("complementary", { name: "Document" }).style.width).toBe("960px");

    // Reopened, it has the width it was left at.
    fireEvent.click(screen.getByRole("button", { name: "Close document" }));
    act(() => docs().openDocument("Reply", "# Two"));
    expect(
      screen.getByRole("separator", { name: "Resize document pane" }).getAttribute("aria-valuenow"),
    ).toBe("960");
  });
});

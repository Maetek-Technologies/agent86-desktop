import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDocumentLink, openPath, readTextFile } from "../desktop-client/backend.ts";
import { followLink } from "./follow.ts";

vi.mock("../desktop-client/backend.ts", () => ({
  openDocumentLink: vi.fn(() => Promise.resolve()),
  openPath: vi.fn(() => Promise.resolve()),
  readTextFile: vi.fn((_thread: string, path: string) =>
    Promise.resolve({ path, text: "# Steps" }),
  ),
}));

describe("followLink", () => {
  const show = vi.fn();
  const host = { threadId: "t1", documentPath: "/ws/docs/plan.md", show };

  beforeEach(() => vi.clearAllMocks());

  it("opens external links outside the app", async () => {
    await followLink({ kind: "external", url: "https://example.com/" }, host);
    expect(openDocumentLink).toHaveBeenCalledWith("https://example.com/");
  });

  it("shows a linked Markdown file in the viewer", async () => {
    await followLink({ kind: "file", path: "steps.md", from: "document" }, host);
    expect(readTextFile).toHaveBeenCalledWith("t1", "/ws/docs/steps.md");
    expect(show).toHaveBeenCalledWith({ path: "/ws/docs/steps.md", text: "# Steps" });
    expect(openPath).not.toHaveBeenCalled();
  });

  it("opens any other file with its default app, from the workspace for references", async () => {
    await followLink({ kind: "file", path: "src/app.ts", line: 42, from: "workspace" }, host);
    expect(openPath).toHaveBeenCalledWith("t1", "src/app.ts", false);
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it("passes Rust's refusal on", async () => {
    vi.mocked(readTextFile).mockRejectedValueOnce("x.md is outside this thread's workspace");
    await expect(
      followLink({ kind: "file", path: "/etc/x.md", from: "document" }, host),
    ).rejects.toBe("x.md is outside this thread's workspace");
  });

  it("does nothing for anchors and dead links", async () => {
    await followLink({ kind: "anchor", id: "a" }, host);
    await followLink({ kind: "none" }, host);
    expect(openDocumentLink).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
    expect(readTextFile).not.toHaveBeenCalled();
  });
});

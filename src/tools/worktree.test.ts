import { describe, expect, it } from "vitest";
import { diffFiles, parseWorktree } from "./worktree.ts";

const KEPT = `Added the check.

[worktree] This ran in a git worktree of HEAD (3f2a9c1d0b7e), not in your workspace. The workspace had uncommitted changes, which the worktree did not have. Nothing was applied: the worktree is kept at .agent86/worktrees/reviewer-1 on branch agent86/reviewer-1. Its changes:
\`\`\`diff
diff --git a/src/a.rs b/src/a.rs
--- a/src/a.rs
+++ b/src/a.rs
@@ -1,2 +1,3 @@
 fn a() {}
-fn b() {}
+fn b() { check(); }
+fn c() {}
diff --git a/README.md b/README.md
+++ b/README.md
+More.
\`\`\``;

describe("parseWorktree", () => {
  it("reads a kept worktree, its branch, and its diff", () => {
    const parsed = parseWorktree(KEPT)!;
    expect(parsed.answer).toBe("Added the check.");
    const w = parsed.worktree;
    expect(w.base).toBe("3f2a9c1d0b7e");
    expect(w.dirty).toBe(true);
    expect(w.path).toBe(".agent86/worktrees/reviewer-1");
    expect(w.branch).toBe("agent86/reviewer-1");
    expect(w.diff).toContain("+fn c() {}");
    expect(w.cut).toBe(false);
    expect(w.files).toEqual([
      { path: "src/a.rs", added: 2, removed: 1 },
      { path: "README.md", added: 1, removed: 0 },
    ]);
  });

  it("reads a worktree that changed nothing", () => {
    const w = parseWorktree(
      "Looked.\n\n[worktree] This ran in a git worktree of HEAD (abc), not in your workspace. It changed nothing, and the worktree was removed.",
    )!.worktree;
    expect(w.path).toBeNull();
    expect(w.diff).toBeNull();
    expect(w.files).toEqual([]);
  });

  it("reads a diff that could not be made", () => {
    const w = parseWorktree(
      "x\n\n[worktree] This ran in a git worktree of HEAD (abc), not in your workspace. Its diff could not be made (git failed); the worktree is kept at /tmp/w on branch b1.",
    )!.worktree;
    expect(w.error).toBe("git failed");
    expect(w.path).toBe("/tmp/w");
    expect(w.branch).toBe("b1");
  });

  it("ignores output without a note", () => {
    expect(parseWorktree("just an answer")).toBeNull();
    expect(diffFiles("")).toEqual([]);
  });
});

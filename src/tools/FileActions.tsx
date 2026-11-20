import { useState } from "react";
import { openPath } from "../desktop-client/backend.ts";
import { useThread } from "../thread/ThreadContext.ts";

/** What the platform's file manager is called. */
function fileManager(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  if (/Win/.test(platform)) return "Explorer";
  if (/Mac/.test(platform)) return "Finder";
  return "the file manager";
}

/**
 * "open" and "reveal" for a file or folder a tool worked on. Rust decides what is allowed: only
 * paths inside the thread's workspace or a worktree its sub-agents kept, and programs and
 * scripts are only revealed.
 */
export function FileActions({ path, open = true }: { path: string; open?: boolean }) {
  const { threadId } = useThread();
  const [problem, setProblem] = useState<string | null>(null);
  if (!threadId) return null;
  const run = (reveal: boolean) => (event: React.MouseEvent) => {
    event.stopPropagation();
    setProblem(null);
    openPath(threadId, path, reveal).catch((e: unknown) => setProblem(String(e)));
  };
  const button = "rounded px-1 text-muted hover:bg-panel-2 hover:text-text";
  return (
    <>
      {open && (
        <button
          type="button"
          className={button}
          title="Open with its default app"
          onClick={run(false)}
        >
          open
        </button>
      )}
      <button
        type="button"
        className={button}
        title={`Show in ${fileManager()}`}
        onClick={run(true)}
      >
        reveal
      </button>
      {problem && (
        <span role="alert" className="truncate text-error" title={problem}>
          {problem}
        </span>
      )}
    </>
  );
}

/** `file` (a path with `/` as agent86's diffs give it) inside the folder `root`. */
export function joinPath(root: string, file: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + file.split("/").join(sep);
}

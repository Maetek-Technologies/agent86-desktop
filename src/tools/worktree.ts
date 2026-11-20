// A sub-agent that ran isolated (in a git worktree) hands back its answer with agent86's
// `[worktree]` note: where the worktree is kept and the diff of what it changed. Nothing it did
// was applied to the workspace. This reads that note so a tool card can show it properly.

export interface WorktreeFile {
  path: string;
  added: number;
  removed: number;
}

export interface WorktreeNote {
  /** The commit the worktree started from (short). */
  base: string;
  /** The workspace had uncommitted changes the worktree did not have. */
  dirty: boolean;
  /** Where the worktree is kept and its branch; `null` when it changed nothing and was removed. */
  path: string | null;
  branch: string | null;
  /** The unified diff of its changes, as agent86 showed it. */
  diff: string | null;
  /** The diff was cut short; the rest is in the worktree. */
  cut: boolean;
  files: WorktreeFile[];
  /** Why there is no diff, when making it failed. */
  error: string | null;
}

const NOTE = /\[worktree\] This ran in a git worktree of HEAD \(([^)]*)\), not in your workspace\./;
const KEPT = /the worktree is kept at (.+?) on branch (\S+?)\./;
const DIFF = /```diff\n([\s\S]*?)\n```/;
const FAILED = /Its diff could not be made \((.*?)\); the worktree is kept/;

/** `output` split into the sub-agent's answer and its worktree note; `null` when it has none. */
export function parseWorktree(output: string): { answer: string; worktree: WorktreeNote } | null {
  const note = NOTE.exec(output);
  if (!note) return null;
  const rest = output.slice(note.index);
  const kept = KEPT.exec(rest);
  const diff = DIFF.exec(rest)?.[1] ?? null;
  return {
    answer: output.slice(0, note.index).trim(),
    worktree: {
      base: note[1] ?? "",
      dirty: rest.includes("The workspace had uncommitted changes"),
      path: kept?.[1] ?? null,
      branch: kept?.[2] ?? null,
      diff,
      cut: /\[diff cut at /.test(rest),
      files: diff ? diffFiles(diff) : [],
      error: FAILED.exec(rest)?.[1] ?? null,
    },
  };
}

/** The files a unified diff touches, with lines added and removed. */
export function diffFiles(diff: string): WorktreeFile[] {
  const files: WorktreeFile[] = [];
  let current: WorktreeFile | null = null;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[2]!, added: 0, removed: 0 };
      files.push(current);
    } else if (current && line.startsWith("+") && !line.startsWith("+++")) {
      current.added += 1;
    } else if (current && line.startsWith("-") && !line.startsWith("---")) {
      current.removed += 1;
    }
  }
  return files;
}

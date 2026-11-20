// What a thread streams from Rust: mirrors `DesktopEvent` in src-tauri/src/threads/events.rs.
// Kept by hand for M1; generated from the Rust types from M3 (docs/PROJECT_PLAN.md §3.2).

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface TurnInfo {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  steps: number;
  toolCalls: number;
  durationS: number;
}

export type StopReason = "end_turn" | "cancelled";

/** The file a call would change, before and after (redacted by agent86). */
export interface FileChangeInfo {
  path: string;
  /** `null` for a new file. */
  oldText: string | null;
  newText: string;
  line: number | null;
}

/** The sub-agent asking, when it is not the main agent. */
export interface AskerInfo {
  agent: string;
  depth: number;
  worktreePath: string | null;
  worktreeBranch: string | null;
  steps: number;
  costUsd: number;
}

/** What an approval shows: agent86-core's `ApprovalPreview`. */
export interface ApprovalInfo {
  /** The arguments, as JSON, capped by agent86. */
  summary: string;
  /** What the call would do: a unified diff, a command, code. */
  detail: string | null;
  /** The language of `detail`: `diff`, `bash`, `python`. */
  lexer: string | null;
  warning: string | null;
  full: boolean;
  change: FileChangeInfo | null;
  asker: AskerInfo | null;
}

/** A limit the turn reached, and the raises on offer. */
export interface LimitInfo {
  kind: "steps" | "agent_steps" | "output";
  headline: string;
  agent: string | null;
  current: number;
  offers: number[];
  runOnly: boolean;
}

/** The user's answer to a question, as Rust's `Answer` reads it. */
export type Answer =
  | { type: "approval"; choice: "allowOnce" | "allowAlways" | "reject" }
  | { type: "limit"; value: number | null }
  | { type: "secret"; value: string | null };

export type DesktopEvent =
  | { type: "agentText"; text: string }
  | { type: "thought"; text: string }
  | { type: "notice"; text: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      title: string;
    }
  | {
      type: "toolResult";
      id: string;
      name: string;
      ok: boolean;
      output: string;
      truncated: boolean;
      error: string | null;
      summary: string;
    }
  | { type: "usage"; step: UsageInfo; session: UsageInfo }
  | { type: "compacted"; notice: string; summary: string | null }
  | { type: "approvalRequest"; qid: number; tool: string; preview: ApprovalInfo }
  | { type: "limitRequest"; qid: number; limit: LimitInfo }
  | { type: "secretRequest"; qid: number; name: string; reason: string; replacing: boolean }
  | { type: "questionClosed"; qid: number; answered: boolean }
  | {
      type: "turnEnded";
      stopReason: StopReason;
      answer: string;
      turn: TurnInfo | null;
      usage: UsageInfo;
    }
  | { type: "turnFailed"; error: string };

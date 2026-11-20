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
  | {
      type: "turnEnded";
      stopReason: StopReason;
      answer: string;
      turn: TurnInfo | null;
      usage: UsageInfo;
    }
  | { type: "turnFailed"; error: string };

// When a thread's event deserves a desktop notification: a question waits (approval, limit,
// secret), or a long turn ended, while the app or that tab is not in front.
import type { DesktopEvent } from "../desktop-client/events.ts";

/** A turn at least this long is worth a notification when it ends unseen. */
export const LONG_TURN_SECONDS = 30;

export interface NotifyContext {
  /** The tab's title. */
  tab: string;
  /** The tab is not the one shown, or the window is not focused. */
  background: boolean;
  /** How long the turn has run, when known. */
  turnSeconds: number | null;
}

export interface Notice {
  title: string;
  body: string;
}

/** The notification `event` calls for in `context`, or `null`. */
export function notificationFor(event: DesktopEvent, context: NotifyContext): Notice | null {
  if (!context.background) return null;
  const long = (context.turnSeconds ?? 0) >= LONG_TURN_SECONDS;
  switch (event.type) {
    case "approvalRequest": {
      const who = event.preview.asker ? `${event.preview.asker.agent} (sub-agent)` : "The agent";
      return {
        title: "Approval needed",
        body: `${context.tab}: ${who} wants to run ${event.tool}.`,
      };
    }
    case "limitRequest":
      return {
        title: "Limit reached",
        body: `${context.tab}: ${event.limit.headline}`,
      };
    case "secretRequest":
      return {
        title: "Secret requested",
        body: `${context.tab}: the agent asks for ${event.name}.`,
      };
    case "turnEnded":
      if (!long || event.stopReason === "cancelled") return null;
      return {
        title: "Turn finished",
        body: joinLines(
          `${context.tab}, after ${duration(context.turnSeconds ?? 0)}.`,
          snippet(event.answer),
        ),
      };
    case "turnFailed":
      if (!long) return null;
      return {
        title: "Turn failed",
        body: joinLines(
          `${context.tab}, after ${duration(context.turnSeconds ?? 0)}.`,
          snippet(event.error),
        ),
      };
    default:
      return null;
  }
}

/** `95` → "1m 35s", `12` → "12s". */
export function duration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The start of `text` on one line, at most 140 characters. */
function snippet(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

function joinLines(first: string, second: string): string {
  return second ? `${first}\n${second}` : first;
}

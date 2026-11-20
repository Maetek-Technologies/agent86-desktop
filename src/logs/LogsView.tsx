import { useCallback, useEffect, useMemo, useState } from "react";
import { readActivity, readAppLog, revealLog } from "../desktop-client/backend.ts";
import type { ActivityEvent, ActivityView, AppLogView } from "../desktop-client/events.ts";
import {
  ACTIVITY_FILTERS,
  clock,
  eventMatches,
  isProblem,
  lineMatches,
  matchesFilter,
  money,
  summarize,
  totals,
  type ActivityFilter,
} from "./format.ts";

type Tab = "activity" | "app";

/** How often the view refreshes while Live is on. */
const LIVE_MS = 2000;

const KIND_CLASS: Record<string, string> = {
  turn_start: "text-accent",
  turn_end: "text-accent",
  model_call: "text-text",
  tool_call: "text-text",
  guardrail: "text-warn",
  empty_answer: "text-warn",
};

const LEVEL_CLASS: Record<string, string> = {
  ERROR: "text-error",
  WARN: "text-warn",
  INFO: "text-muted",
  DEBUG: "text-muted",
  TRACE: "text-muted",
};

/**
 * The Logs view: agent86's activity log (turns, model calls with tokens and cost, tool calls,
 * guardrail hits, errors) and the app's own log, newest first, with filters and a live mode.
 * `titles` names sessions by their tab or saved title; `session` is the active tab's session.
 */
export function LogsView({
  titles,
  session,
  onClose,
}: {
  titles: ReadonlyMap<string, string>;
  session: string | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("activity");
  const [activity, setActivity] = useState<ActivityView | null>(null);
  const [appLog, setAppLog] = useState<AppLogView | null>(null);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [thisThread, setThisThread] = useState(false);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [live, setLive] = useState(true);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (tab === "activity")
      readActivity(2000).then(setActivity, (e: unknown) => setProblem(String(e)));
    else readAppLog(2000).then(setAppLog, (e: unknown) => setProblem(String(e)));
  }, [tab]);

  useEffect(() => {
    refresh();
    if (!live) return;
    const timer = setInterval(refresh, LIVE_MS);
    return () => clearInterval(timer);
  }, [refresh, live]);

  const events = useMemo(() => {
    const all = activity?.events ?? [];
    return all
      .map((event, index) => ({ event, index }))
      .filter(
        ({ event }) =>
          matchesFilter(event, filter) &&
          (!thisThread || !session || event.session === session) &&
          eventMatches(event, search),
      )
      .reverse();
  }, [activity, filter, thisThread, session, search]);

  const lines = useMemo(
    () => (appLog?.lines ?? []).filter((line) => lineMatches(line, search, problemsOnly)).reverse(),
    [appLog, search, problemsOnly],
  );

  const sum = useMemo(() => totals(events.map((e) => e.event)), [events]);
  const label = (event: ActivityEvent) =>
    titles.get(event.session) ?? (event.session ? event.session.slice(0, 8) : "—");
  const toggle = (index: number) =>
    setOpen((shown) => {
      const next = new Set(shown);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const view = tab === "activity" ? activity : appLog;
  const tabClass = (name: Tab) =>
    `rounded px-2 py-1 ${tab === name ? "bg-panel-2 text-text" : "text-muted hover:text-text"}`;
  const control =
    "rounded border border-border bg-bg px-2 py-1 text-xs text-text outline-none focus:border-accent";

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-sm">
        <h1 className="mr-2 text-lg font-semibold">Logs</h1>
        <div role="tablist" className="flex gap-1">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "activity"}
            className={tabClass("activity")}
            onClick={() => setTab("activity")}
          >
            Activity
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "app"}
            className={tabClass("app")}
            onClick={() => setTab("app")}
          >
            App log
          </button>
        </div>
        <span className="flex-1" />
        <label className="flex items-center gap-1 text-xs text-muted">
          <input
            type="checkbox"
            className="accent-[var(--accent)]"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
          />
          Live
        </label>
        <button type="button" className={control} onClick={refresh}>
          Refresh
        </button>
        <button
          type="button"
          className={control}
          onClick={() => revealLog(tab).catch((e: unknown) => setProblem(String(e)))}
        >
          Reveal file
        </button>
        <button
          type="button"
          className="rounded border border-border px-3 py-1 text-sm hover:bg-panel-2"
          onClick={onClose}
        >
          Close
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search"
          aria-label="Search the log"
          className={`${control} w-56`}
        />
        {tab === "activity" ? (
          <>
            <select
              aria-label="Show"
              className={control}
              value={filter}
              onChange={(e) => setFilter(e.target.value as ActivityFilter)}
            >
              {ACTIVITY_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <label
              className={`flex items-center gap-1 ${session ? "text-muted" : "text-muted opacity-50"}`}
              title={session ? undefined : "Open a thread to filter by it"}
            >
              <input
                type="checkbox"
                className="accent-[var(--accent)]"
                checked={thisThread && !!session}
                disabled={!session}
                onChange={(e) => setThisThread(e.target.checked)}
              />
              This thread only
            </label>
            <span className="ml-auto text-muted" aria-label="Totals">
              {events.length} events · {sum.calls} model calls · {sum.input.toLocaleString()} in /{" "}
              {sum.output.toLocaleString()} out · {money(sum.cost)}
            </span>
          </>
        ) : (
          <>
            <label className="flex items-center gap-1 text-muted">
              <input
                type="checkbox"
                className="accent-[var(--accent)]"
                checked={problemsOnly}
                onChange={(e) => setProblemsOnly(e.target.checked)}
              />
              Warnings and errors only
            </label>
            <span className="ml-auto text-muted">{lines.length} entries</span>
          </>
        )}
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto font-mono text-xs">
        {problem && (
          <p role="alert" className="px-4 py-2 text-error">
            {problem}
          </p>
        )}
        {view?.note && <p className="px-4 py-3 font-sans text-sm text-muted">{view.note}</p>}
        {tab === "activity" && (
          <ul aria-label="Activity">
            {events.map(({ event, index }) => (
              <li key={index} className="border-b border-border/50">
                <button
                  type="button"
                  aria-expanded={open.has(index)}
                  onClick={() => toggle(index)}
                  className={`flex w-full gap-3 px-4 py-1 text-left hover:bg-panel ${
                    isProblem(event) ? "bg-panel-2" : ""
                  }`}
                >
                  <span className="shrink-0 text-muted">{clock(event.ts)}</span>
                  <span className={`w-28 shrink-0 ${KIND_CLASS[event.kind] ?? "text-muted"}`}>
                    {event.kind}
                  </span>
                  <span className="w-40 shrink-0 truncate text-muted" title={event.session}>
                    {label(event)}
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate ${isProblem(event) ? "text-warn" : ""}`}
                  >
                    {summarize(event)}
                  </span>
                </button>
                {open.has(index) && (
                  <pre className="overflow-x-auto bg-panel px-4 py-2 whitespace-pre-wrap text-muted">
                    {JSON.stringify({ session: event.session, ...event.fields }, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
        {tab === "app" && (
          <ul aria-label="App log">
            {lines.map((line, i) => (
              <li
                key={`${line.time}-${i}`}
                className="flex gap-3 border-b border-border/50 px-4 py-1"
              >
                <span className="shrink-0 text-muted">{line.time}</span>
                <span className={`w-12 shrink-0 ${LEVEL_CLASS[line.level] ?? "text-muted"}`}>
                  {line.level}
                </span>
                <span className="w-44 shrink-0 truncate text-muted" title={line.target}>
                  {line.target.replace(/^agent86_desktop_lib::?/, "") || "app"}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap">{line.message}</span>
              </li>
            ))}
          </ul>
        )}
      </main>
      {view?.path && (
        <footer className="border-t border-border px-4 py-1 font-mono text-[0.7rem] text-muted">
          {view.path}
        </footer>
      )}
    </div>
  );
}

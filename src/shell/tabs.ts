// The open threads as tabs: one reducer over all of them, so each thread's events (which arrive
// keyed by the tab that opened it) fold into the right transcript.
import type { DesktopEvent, OpenedThread, ReloadedThread } from "../desktop-client/events.ts";
import {
  initialState,
  reduce,
  type LocalAction,
  type SessionState,
} from "../desktop-client/session-state.ts";

export interface Tab {
  /** The app's own key, known before Rust gives the thread an id. */
  key: string;
  workspace: string;
  /** Set once the thread is open. */
  opened: OpenedThread | null;
  /** A name the user gave it, before the session list knows it. */
  title: string | null;
  session: SessionState;
}

export interface TabsState {
  tabs: Tab[];
  active: string | null;
}

export type TabsAction =
  | { type: "opening"; key: string; workspace: string; title: string | null }
  | { type: "opened"; key: string; opened: OpenedThread }
  | { type: "failed"; key: string }
  | { type: "activate"; key: string }
  | { type: "close"; key: string }
  | { type: "title"; key: string; title: string }
  | { type: "reloaded"; key: string; reloaded: ReloadedThread }
  | { type: "thread"; key: string; action: DesktopEvent | LocalAction };

export const NO_TABS: TabsState = { tabs: [], active: null };

export function tabsReduce(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "opening":
      return {
        tabs: [
          ...state.tabs,
          {
            key: action.key,
            workspace: action.workspace,
            opened: null,
            title: action.title,
            session: initialState(),
          },
        ],
        active: action.key,
      };
    case "opened":
      return update(state, action.key, (tab) => ({
        ...tab,
        opened: action.opened,
        workspace: action.opened.workspace,
        session: action.opened.history.length
          ? reduce(tab.session, { type: "local/history", items: action.opened.history })
          : tab.session,
      }));
    case "failed":
    case "close": {
      const index = state.tabs.findIndex((t) => t.key === action.key);
      if (index < 0) return state;
      const tabs = state.tabs.filter((t) => t.key !== action.key);
      // Closing the active tab shows its neighbour, as browsers do.
      const active =
        state.active === action.key
          ? (tabs[Math.min(index, tabs.length - 1)]?.key ?? null)
          : state.active;
      return { tabs, active };
    }
    case "activate":
      return state.tabs.some((t) => t.key === action.key)
        ? { ...state, active: action.key }
        : state;
    case "title":
      return update(state, action.key, (tab) => ({ ...tab, title: action.title }));
    case "reloaded":
      return update(state, action.key, (tab) =>
        tab.opened ? { ...tab, opened: { ...tab.opened, ...action.reloaded } } : tab,
      );
    case "thread":
      return update(state, action.key, (tab) => ({
        ...tab,
        session: reduce(tab.session, action.action),
      }));
  }
}

function update(state: TabsState, key: string, change: (tab: Tab) => Tab): TabsState {
  if (!state.tabs.some((t) => t.key === key)) return state;
  return { ...state, tabs: state.tabs.map((t) => (t.key === key ? change(t) : t)) };
}

/** The last part of a folder path, for a tab with no title yet. */
export function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  );
}

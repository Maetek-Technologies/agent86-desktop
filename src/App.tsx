import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  answer,
  appInfo,
  cancelTurn,
  closeThread,
  findFiles,
  getSettings,
  listSessions,
  modelInfo,
  openThread,
  pickWorkspace,
  prompt,
  reloadThread,
  renameSession,
  type AppInfo,
  type ModelInfo,
  type SessionList,
  type Settings,
  type SettingsState,
} from "./desktop-client/backend.ts";
import { listItems, parseCommand } from "./desktop-client/commands.ts";
import type { Answer, DesktopEvent, SessionSummary } from "./desktop-client/events.ts";
import type { LocalAction } from "./desktop-client/session-state.ts";
import { Sidebar } from "./shell/Sidebar.tsx";
import { Tabs } from "./shell/Tabs.tsx";
import { folderName, NO_TABS, tabsReduce, type Tab, type TabsAction } from "./shell/tabs.ts";
import { MemoryPanel } from "./memory/MemoryPanel.tsx";
import { FirstRun } from "./settings/FirstRun.tsx";
import { SettingsView } from "./settings/SettingsView.tsx";
import { ThreadView } from "./thread/ThreadView.tsx";

let nextKey = 0;

/**
 * The app: saved sessions on the left, open threads as tabs, and each thread's view. Threads run
 * in parallel; each tab's view stays mounted while hidden, so its draft and scroll survive.
 */
export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionList | null>(null);
  const [settingsState, setSettingsState] = useState<SettingsState | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [opening, setOpening] = useState(false);
  const [state, dispatch] = useReducer(tabsReduce, NO_TABS);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const refreshSessions = useCallback(() => {
    listSessions().then(setSessions, (e: unknown) =>
      setSessions({ sessions: [], database: null, problem: String(e), note: null }),
    );
  }, []);

  const refreshModel = useCallback(() => {
    // An unreachable core says more than a settings error, so that error never replaces it.
    modelInfo().then(setModel, (e: unknown) =>
      setError((shown) => shown ?? `Could not load the model settings: ${String(e)}`),
    );
  }, []);

  useEffect(() => {
    appInfo().then(setInfo, (e: unknown) => setError(`Could not reach the app core: ${String(e)}`));
    getSettings().then(setSettingsState, (e: unknown) =>
      setError((shown) => shown ?? `Could not load the settings: ${String(e)}`),
    );
    refreshModel();
    refreshSessions();
  }, [refreshModel, refreshSessions]);

  /** Settings were saved (or set up): new threads use them. */
  const settingsSaved = useCallback(
    (settings: Settings) => {
      setSettingsState((state) => state && { ...state, settings, problem: null });
      refreshModel();
      refreshSessions();
    },
    [refreshModel, refreshSessions],
  );

  const openSettings = useCallback(() => {
    // Fresh: whether the memory database is open, and whether a CLI config appeared.
    getSettings().then(
      (state) => {
        setSettingsState(state);
        setShowSettings(true);
      },
      (e: unknown) => setError(String(e)),
    );
  }, []);

  const titles = useMemo(
    () => new Map(sessions?.sessions.map((s) => [s.id, s.title]) ?? []),
    [sessions],
  );
  const titleOf = useCallback(
    (tab: Tab) =>
      tab.title ??
      (tab.opened ? titles.get(tab.opened.sessionId) : null) ??
      folderName(tab.workspace),
    [titles],
  );
  const openSessions = useMemo(
    () => new Set(state.tabs.flatMap((t) => (t.opened ? [t.opened.sessionId] : []))),
    [state.tabs],
  );

  /** Open a thread in `workspace` (continuing `session` if given) in a new tab. */
  const open = useCallback(
    async (workspace: string, session: SessionSummary | null) => {
      const key = `tab${++nextKey}`;
      dispatch({ type: "opening", key, workspace, title: session?.title ?? null });
      setOpening(true);
      setError(null);
      try {
        const onEvent = (event: DesktopEvent) => {
          dispatch({ type: "thread", key, action: event });
          // A finished turn may have saved a new session or titled one.
          if (event.type === "turnEnded" || event.type === "turnFailed") refreshSessions();
        };
        const opened = await openThread(workspace, session?.id ?? null, onEvent);
        dispatch({ type: "opened", key, opened });
      } catch (e) {
        dispatch({ type: "failed", key });
        setError(String(e));
      } finally {
        setOpening(false);
      }
    },
    [refreshSessions],
  );

  const newThread = useCallback(async () => {
    setError(null);
    try {
      const workspace = await pickWorkspace();
      if (workspace) await open(workspace, null);
    } catch (e) {
      setError(String(e));
    }
  }, [open]);

  const reopen = useCallback(
    async (session: SessionSummary) => {
      const already = stateRef.current.tabs.find((t) => t.opened?.sessionId === session.id);
      if (already) {
        dispatch({ type: "activate", key: already.key });
        return;
      }
      try {
        // agent86 does not record a session's folder; ask when the app does not know it.
        const workspace = session.workspace ?? (await pickWorkspace());
        if (workspace) await open(workspace, session);
      } catch (e) {
        setError(String(e));
      }
    },
    [open],
  );

  const close = useCallback((key: string) => {
    const tab = stateRef.current.tabs.find((t) => t.key === key);
    if (tab?.opened) void closeThread(tab.opened.threadId).catch(() => {});
    dispatch({ type: "close", key });
  }, []);

  const rename = useCallback(
    (key: string, title: string) => {
      const tab = stateRef.current.tabs.find((t) => t.key === key);
      if (!tab?.opened) return;
      renameSession(tab.opened.sessionId, title).then(
        (kept) => {
          dispatch({ type: "title", key, title: kept });
          refreshSessions();
        },
        (e: unknown) =>
          dispatch({ type: "thread", key, action: { type: "local/warning", text: String(e) } }),
      );
    },
    [refreshSessions],
  );

  if (settingsState && !settingsState.settings) {
    return (
      <div className="h-screen bg-bg text-text">
        <FirstRun state={settingsState} onDone={settingsSaved} />
      </div>
    );
  }
  const ready = settingsState?.settings
    ? { ...settingsState, settings: settingsState.settings }
    : null;

  return (
    <div className="flex h-screen bg-bg text-text">
      <Sidebar
        list={sessions}
        openSessions={openSessions}
        busy={opening || !model || !!model.problem}
        onNew={() => void newThread()}
        onOpen={(session) => void reopen(session)}
        onRefresh={refreshSessions}
        onSettings={() => (showSettings ? setShowSettings(false) : openSettings())}
        settingsOpen={showSettings}
        onMemory={() => setShowMemory((open) => !open)}
        memoryOpen={showMemory}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {state.tabs.length > 0 && (
          <Tabs
            tabs={state.tabs}
            active={state.active}
            titleOf={titleOf}
            onActivate={(key) => dispatch({ type: "activate", key })}
            onClose={close}
            onRename={rename}
          />
        )}
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 border-b border-error bg-panel px-4 py-2 text-sm text-error"
          >
            <span className="flex-1">{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          {state.tabs.map((tab) => (
            <div key={tab.key} className="absolute inset-0" hidden={tab.key !== state.active}>
              {tab.opened ? (
                <TabView tab={tab} dispatchTab={dispatch} onMemory={() => setShowMemory(true)} />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted">
                  Opening {folderName(tab.workspace)}…
                </div>
              )}
            </div>
          ))}
          {state.tabs.length === 0 && (
            <Start
              info={info}
              model={model}
              opening={opening}
              onNew={() => void newThread()}
              onSettings={openSettings}
            />
          )}
          {showMemory && (
            <div className="absolute inset-y-0 right-0 z-20 w-96 border-l border-border shadow-xl">
              <MemoryPanel onClose={() => setShowMemory(false)} />
            </div>
          )}
          {showSettings && ready && (
            <div className="absolute inset-0 z-10">
              <SettingsView
                state={ready}
                onSaved={settingsSaved}
                onClose={() => setShowSettings(false)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One open thread, with its commands bound to it. */
function TabView({
  tab,
  dispatchTab,
  onMemory,
}: {
  tab: Tab;
  dispatchTab: (action: TabsAction) => void;
  onMemory: () => void;
}) {
  const opened = tab.opened!;
  const key = tab.key;
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [reloading, setReloading] = useState(false);
  const local = useCallback(
    (action: DesktopEvent | LocalAction) => dispatchTab({ type: "thread", key, action }),
    [dispatchTab, key],
  );

  const send = useCallback(
    (text: string, mentions: string[]) => {
      const command = parseCommand(text, opened.capabilities, mentions);
      switch (command.type) {
        case "list": {
          const items = listItems(command.list, opened.capabilities);
          local({ type: "local/list", title: `/${command.list} (${items.length})`, items });
          return;
        }
        case "panel":
          if (command.panel === "secrets") setSecretsOpen(true);
          else onMemory();
          return;
        case "error":
          local({ type: "local/warning", text: command.message });
          return;
        case "turn":
          local({ type: "local/prompt", text: command.display });
          prompt(opened.threadId, command.turn).catch((e: unknown) =>
            local({ type: "local/error", text: String(e) }),
          );
      }
    },
    [opened, local, onMemory],
  );

  const reload = useCallback(() => {
    setReloading(true);
    reloadThread(opened.threadId).then(
      (reloaded) => {
        dispatchTab({ type: "reloaded", key, reloaded });
        const trusted =
          reloaded.project?.state === "trusted"
            ? " with this project's skills, specialists, and MCP servers"
            : "";
        local({
          type: "local/notice",
          text: `[reloaded] ${reloaded.model}${trusted}; the conversation carries on.`,
        });
        setReloading(false);
      },
      (e: unknown) => {
        local({ type: "local/warning", text: String(e) });
        setReloading(false);
      },
    );
  }, [opened, key, local, dispatchTab]);

  const stop = useCallback(() => {
    local({ type: "local/cancelling" });
    cancelTurn(opened.threadId).catch((e: unknown) =>
      local({ type: "local/error", text: String(e) }),
    );
  }, [opened, local]);

  const reply = useCallback(
    (qid: number, given: Answer) => {
      answer(opened.threadId, qid, given).catch((e: unknown) =>
        local({ type: "local/warning", text: String(e) }),
      );
    },
    [opened, local],
  );

  const searchFiles = useCallback((query: string) => findFiles(opened.threadId, query), [opened]);

  return (
    <ThreadView
      thread={opened}
      state={tab.session}
      onSend={send}
      onStop={stop}
      onAnswer={reply}
      findFiles={searchFiles}
      secretsOpen={secretsOpen}
      onSecrets={setSecretsOpen}
      onReload={reload}
      reloading={reloading}
    />
  );
}

function Start({
  info,
  model,
  opening,
  onNew,
  onSettings,
}: {
  info: AppInfo | null;
  model: ModelInfo | null;
  opening: boolean;
  onNew: () => void;
  onSettings: () => void;
}) {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-5 px-6">
      <img src="/agent86-logo.png" alt="" width={96} height={96} />
      <h1 className="text-2xl font-semibold">Agent 86</h1>
      {model && (
        <div className="max-w-xl text-center text-sm">
          {model.reference && (
            <div>
              {model.triage ? "Triage, frontier model " : "Model "}
              <span className="font-mono">{model.reference}</span>
            </div>
          )}
          <button
            type="button"
            className="text-xs text-muted underline hover:text-text"
            onClick={onSettings}
          >
            Change in Settings
          </button>
          {model.problem && (
            <p className="mt-2 rounded-md border border-error px-3 py-2 text-error">
              {model.problem}
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        className="rounded-md bg-accent px-5 py-2 text-sm font-medium text-bg disabled:opacity-50"
        onClick={onNew}
        disabled={opening || !model || !!model.problem}
      >
        {opening ? "Starting…" : "Choose a workspace folder…"}
      </button>
      <p className="text-xs text-muted">or reopen a saved session from the list.</p>
      {info && (
        <footer className="absolute bottom-3 text-xs text-muted">
          v{info.appVersion} · agent86-core v{info.coreVersion} · {info.os}/{info.arch}
          {!info.memoryOk && <span className="text-error"> · memory store unavailable</span>}
        </footer>
      )}
    </main>
  );
}

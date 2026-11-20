import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  answer,
  appInfo,
  cancelTurn,
  checkUpdate,
  closeThread,
  findFiles,
  getSettings,
  listSessions,
  modelInfo,
  notify,
  onActivateTab,
  openThread,
  pickWorkspace,
  prompt,
  reloadThread,
  renameSession,
  setThreadApproval,
  setThreadModel,
  type AppInfo,
  type ModelInfo,
  type SessionList,
  type Settings,
  type SettingsState,
} from "./desktop-client/backend.ts";
import { listItems, parseCommand } from "./desktop-client/commands.ts";
import type {
  Answer,
  Approval,
  DesktopEvent,
  SessionSummary,
  UpdateInfo,
} from "./desktop-client/events.ts";
import type { LocalAction } from "./desktop-client/session-state.ts";
import { notificationFor } from "./shell/notify.ts";
import { isMac, modLabel, shortcutFor, tabTarget } from "./shell/shortcuts.ts";
import { loadSidebar, saveSidebar, type SidebarLayout } from "./shell/layout.ts";
import { Sidebar } from "./shell/Sidebar.tsx";
import { Tabs } from "./shell/Tabs.tsx";
import { applyTheme } from "./shell/theme.ts";
import { folderName, NO_TABS, tabsReduce, type Tab, type TabsAction } from "./shell/tabs.ts";
import { LogsView } from "./logs/LogsView.tsx";
import { MemoryPanel } from "./memory/MemoryPanel.tsx";
import { FirstRun } from "./settings/FirstRun.tsx";
import { SettingsView, type SectionName } from "./settings/SettingsView.tsx";
import { MODES } from "./thread/PermissionPicker.tsx";
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
  const [settingsSection, setSettingsSection] = useState<SectionName>("Model");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [showMemory, setShowMemory] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  // The sessions panel: shown or hidden (‹ › beside the tabs, or Mod+B) and its width.
  const [sidebar, setSidebar] = useState(loadSidebar);
  const changeSidebar = useCallback((next: Partial<SidebarLayout>) => {
    setSidebar((current) => {
      const updated = { ...current, ...next };
      saveSidebar(updated);
      return updated;
    });
  }, []);
  const toggleSidebar = useCallback(
    () =>
      setSidebar((current) => {
        const updated = { ...current, shown: !current.shown };
        saveSidebar(updated);
        return updated;
      }),
    [],
  );
  const [opening, setOpening] = useState(false);
  const [state, dispatchTabs] = useReducer(tabsReduce, NO_TABS);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  /** When each tab's running turn started, for "a long turn finished" notifications. */
  const turnStarts = useRef(new Map<string, number>());
  const dispatch = useCallback((action: TabsAction) => {
    if (action.type === "thread" && action.action.type === "local/prompt") {
      turnStarts.current.set(action.key, Date.now());
    }
    dispatchTabs(action);
  }, []);

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

  // Once per start, if allowed: is there a newer version? Failures (offline, no release yet) are
  // silent here; Settings, About shows them when the user checks.
  const checkOnStart = settingsState?.settings?.ui.checkUpdates ?? false;
  const checkedForUpdate = useRef(false);
  useEffect(() => {
    if (!checkOnStart || checkedForUpdate.current) return;
    checkedForUpdate.current = true;
    const timer = setTimeout(() => {
      checkUpdate().then(setUpdate, () => {});
    }, 5000);
    return () => clearTimeout(timer);
  }, [checkOnStart]);

  const theme = settingsState?.settings?.ui.theme;
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  // A click on a notification about a tab shows that tab (Rust brings the window forward).
  useEffect(() => {
    let stop: (() => void) | null = null;
    let gone = false;
    onActivateTab((key) => dispatch({ type: "activate", key })).then(
      (unlisten) => (gone ? unlisten() : (stop = unlisten)),
      () => {},
    );
    return () => {
      gone = true;
      stop?.();
    };
  }, [dispatch]);

  /** Settings were saved (or set up): new threads use them. */
  const settingsSaved = useCallback(
    (settings: Settings) => {
      setSettingsState((state) => state && { ...state, settings, problem: null });
      refreshModel();
      refreshSessions();
    },
    [refreshModel, refreshSessions],
  );

  const openSettings = useCallback((section: SectionName = "Model") => {
    // Fresh: whether the memory database is open, and whether a CLI config appeared.
    getSettings().then(
      (state) => {
        setSettingsState(state);
        setSettingsSection(section);
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
  const titleOfRef = useRef(titleOf);
  useEffect(() => {
    titleOfRef.current = titleOf;
  }, [titleOf]);

  /** Tell the user about `event` of tab `key` when they cannot see it (shell/notify.ts). */
  const maybeNotify = useCallback((key: string, event: DesktopEvent) => {
    const tab = stateRef.current.tabs.find((t) => t.key === key);
    if (!tab) return;
    const started = turnStarts.current.get(key);
    const ended = event.type === "turnEnded" || event.type === "turnFailed";
    if (ended) turnStarts.current.delete(key);
    const notice = notificationFor(event, {
      tab: titleOfRef.current(tab),
      background: stateRef.current.active !== key || !document.hasFocus(),
      turnSeconds: started === undefined ? null : (Date.now() - started) / 1000,
    });
    if (notice) void notify(notice.title, notice.body, key).catch(() => {});
  }, []);

  // Sessions named for the Logs view: open tabs by their title, then saved sessions.
  const logTitles = useMemo(() => {
    const names = new Map<string, string>();
    for (const [id, title] of titles) if (title) names.set(id, title);
    for (const tab of state.tabs) if (tab.opened) names.set(tab.opened.sessionId, titleOf(tab));
    return names;
  }, [titles, state.tabs, titleOf]);
  const activeSession = state.tabs.find((t) => t.key === state.active)?.opened?.sessionId ?? null;

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
          maybeNotify(key, event);
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
    [refreshSessions, dispatch, maybeNotify],
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
    [open, dispatch],
  );

  const close = useCallback(
    (key: string) => {
      const tab = stateRef.current.tabs.find((t) => t.key === key);
      if (tab?.opened) void closeThread(tab.opened.threadId).catch(() => {});
      turnStarts.current.delete(key);
      dispatch({ type: "close", key });
    },
    [dispatch],
  );

  const toggleSettings = useCallback(
    () => (showSettings ? setShowSettings(false) : openSettings("Model")),
    [showSettings, openSettings],
  );

  // Keyboard shortcuts (shell/shortcuts.ts), anywhere in the window.
  const hasSettings = Boolean(settingsState?.settings);
  const canOpen = !opening && !!model && !model.problem;
  useEffect(() => {
    if (!hasSettings) return;
    const mac = isMac();
    const onKey = (event: KeyboardEvent) => {
      const shortcut = shortcutFor(event, mac);
      if (!shortcut) return;
      const { tabs, active } = stateRef.current;
      const current = tabs.find((t) => t.key === active);
      switch (shortcut.type) {
        case "newThread":
          if (canOpen) void newThread();
          break;
        case "closeTab":
          if (current) close(current.key);
          break;
        case "focusPrompt":
          setShowSettings(false);
          document
            .querySelector<HTMLTextAreaElement>(
              `[data-tab="${active ?? ""}"] textarea[data-prompt-input]`,
            )
            ?.focus();
          break;
        case "stopTurn":
          if (current?.opened && current.session.running && !current.session.cancelling) {
            dispatch({ type: "thread", key: current.key, action: { type: "local/cancelling" } });
            void cancelTurn(current.opened.threadId).catch(() => {});
          }
          break;
        case "settings":
          toggleSettings();
          break;
        case "toggleSidebar":
          toggleSidebar();
          break;
        default: {
          const key = tabTarget(
            shortcut,
            tabs.map((t) => t.key),
            active,
          );
          if (key) dispatch({ type: "activate", key });
        }
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasSettings, canOpen, newThread, close, toggleSettings, toggleSidebar, dispatch]);

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
    [refreshSessions, dispatch],
  );

  // A saved session renamed from the sidebar; a tab showing it takes the new title too.
  const renameSaved = useCallback(
    (session: SessionSummary, title: string) => {
      renameSession(session.id, title).then(
        (kept) => {
          for (const tab of stateRef.current.tabs) {
            if (tab.opened?.sessionId === session.id) {
              dispatch({ type: "title", key: tab.key, title: kept });
            }
          }
          refreshSessions();
        },
        (e: unknown) => setError(String(e)),
      );
    },
    [refreshSessions, dispatch],
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
      {sidebar.shown && (
        <Sidebar
          list={sessions}
          width={sidebar.width}
          onResize={(width) => changeSidebar({ width })}
          openSessions={openSessions}
          busy={opening || !model || !!model.problem}
          onNew={() => void newThread()}
          onOpen={(session) => void reopen(session)}
          onRename={renameSaved}
          onRefresh={refreshSessions}
          onSettings={toggleSettings}
          settingsOpen={showSettings}
          onMemory={() => setShowMemory((open) => !open)}
          memoryOpen={showMemory}
          update={update}
          onUpdate={() => openSettings("About")}
          onLogs={() => setShowLogs((open) => !open)}
          logsOpen={showLogs}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-stretch">
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={sidebar.shown ? "Hide sessions" : "Show sessions"}
            aria-expanded={sidebar.shown}
            title={`${sidebar.shown ? "Hide" : "Show"} the sessions panel (${modLabel()}B)`}
            className="border-r border-b border-border bg-panel px-2 py-1.5 text-muted hover:text-text"
          >
            {sidebar.shown ? "‹" : "›"}
          </button>
          <div
            className={`min-w-0 flex-1 ${state.tabs.length > 0 ? "" : "border-b border-border bg-panel"}`}
          >
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
          </div>
        </div>
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
            <div
              key={tab.key}
              data-tab={tab.key}
              className="absolute inset-0"
              hidden={tab.key !== state.active}
            >
              {tab.opened ? (
                <TabView
                  tab={tab}
                  dispatchTab={dispatch}
                  onMemory={() => setShowMemory(true)}
                  onLogs={() => setShowLogs(true)}
                />
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
              onSettings={() => openSettings("Model")}
            />
          )}
          {showMemory && (
            <div className="absolute inset-y-0 right-0 z-20 w-96 border-l border-border shadow-xl">
              <MemoryPanel onClose={() => setShowMemory(false)} />
            </div>
          )}
          {showLogs && (
            <div className="absolute inset-0 z-10">
              <LogsView
                titles={logTitles}
                session={activeSession}
                onClose={() => setShowLogs(false)}
              />
            </div>
          )}
          {showSettings && ready && (
            <div className="absolute inset-0 z-10">
              <SettingsView
                key={settingsSection}
                state={ready}
                onSaved={settingsSaved}
                onClose={() => setShowSettings(false)}
                initialSection={settingsSection}
                update={update}
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
  onLogs,
}: {
  tab: Tab;
  dispatchTab: (action: TabsAction) => void;
  onMemory: () => void;
  onLogs: () => void;
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
          else if (command.panel === "logs") onLogs();
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
    [opened, local, onMemory, onLogs],
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

  const chooseModel = useCallback(
    (reference: string) => {
      setReloading(true);
      setThreadModel(opened.threadId, reference).then(
        (reloaded) => {
          dispatchTab({ type: "reloaded", key, reloaded });
          local({
            type: "local/notice",
            text: reference
              ? `[model] ${reloaded.model} from now on in this thread; the conversation carries on.`
              : `[model] back to the settings' model, ${reloaded.model}.`,
          });
          setReloading(false);
        },
        (e: unknown) => {
          local({ type: "local/warning", text: String(e) });
          setReloading(false);
        },
      );
    },
    [opened, key, local, dispatchTab],
  );

  const chooseApproval = useCallback(
    (approval: Approval | null) => {
      setReloading(true);
      setThreadApproval(opened.threadId, approval).then(
        (reloaded) => {
          dispatchTab({ type: "reloaded", key, reloaded });
          const mode = MODES[reloaded.approval];
          local({
            type: "local/notice",
            text: approval
              ? `[permissions] ${mode.label} from now on in this thread: ${mode.detail.toLowerCase()}.`
              : `[permissions] back to the settings' mode, ${mode.label}.`,
          });
          setReloading(false);
        },
        (e: unknown) => {
          local({ type: "local/warning", text: String(e) });
          setReloading(false);
        },
      );
    },
    [opened, key, local, dispatchTab],
  );

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
      onModel={chooseModel}
      onApproval={chooseApproval}
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

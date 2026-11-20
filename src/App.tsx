import { useCallback, useEffect, useReducer, useState } from "react";
import {
  appInfo,
  cancelTurn,
  closeThread,
  modelInfo,
  openThread,
  pickWorkspace,
  prompt,
  type AppInfo,
  type ModelInfo,
  type OpenedThread,
} from "./desktop-client/backend.ts";
import { initialState, reduce } from "./desktop-client/session-state.ts";
import { ThreadView } from "./thread/ThreadView.tsx";

// M1: one thread at a time. Tabs and the session list arrive in M4.
export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [thread, setThread] = useState<OpenedThread | null>(null);
  const [state, dispatch] = useReducer(reduce, undefined, initialState);

  useEffect(() => {
    appInfo().then(setInfo, (e: unknown) => setError(`Could not reach the app core: ${String(e)}`));
    // An unreachable core says more than a config error, so the config error never replaces it.
    modelInfo().then(setModel, (e: unknown) =>
      setError((shown) => shown ?? `Could not load the model settings: ${String(e)}`),
    );
  }, []);

  const start = async () => {
    setError(null);
    try {
      const workspace = await pickWorkspace();
      if (!workspace) return;
      setOpening(true);
      dispatch({ type: "local/reset" });
      setThread(await openThread(workspace, dispatch));
    } catch (e) {
      setError(String(e));
    } finally {
      setOpening(false);
    }
  };

  const send = useCallback(
    (text: string) => {
      if (!thread) return;
      dispatch({ type: "local/prompt", text });
      prompt(thread.threadId, text).catch((e: unknown) =>
        dispatch({ type: "local/error", text: String(e) }),
      );
    },
    [thread],
  );

  const stop = useCallback(() => {
    if (!thread) return;
    dispatch({ type: "local/cancelling" });
    cancelTurn(thread.threadId).catch((e: unknown) =>
      dispatch({ type: "local/error", text: String(e) }),
    );
  }, [thread]);

  const close = useCallback(() => {
    if (thread) void closeThread(thread.threadId).catch(() => {});
    setThread(null);
    dispatch({ type: "local/reset" });
  }, [thread]);

  if (thread) {
    return <ThreadView thread={thread} state={state} onSend={send} onStop={stop} onClose={close} />;
  }

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-5 bg-bg px-6 text-text">
      <img src="/agent86-logo.png" alt="" width={96} height={96} />
      <h1 className="text-2xl font-semibold">Agent 86</h1>

      {model && (
        <div className="max-w-xl text-center text-sm">
          <div>
            Model <span className="font-mono">{model.reference}</span>
          </div>
          <div className="text-xs text-muted">from {model.source}</div>
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
        onClick={() => void start()}
        disabled={opening || !model || !!model.problem}
      >
        {opening ? "Starting…" : "Choose a workspace folder…"}
      </button>

      {error && <p className="max-w-xl text-center text-sm text-error">{error}</p>}

      {info && (
        <footer className="absolute bottom-3 text-xs text-muted">
          v{info.appVersion} · agent86-core v{info.coreVersion} · {info.os}/{info.arch}
          {!info.memoryOk && <span className="text-error"> · memory store unavailable</span>}
        </footer>
      )}
    </main>
  );
}

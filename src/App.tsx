import { useEffect, useState } from "react";
import { appInfo, type AppInfo } from "./desktop-client/backend.ts";

// M0: a placeholder window that proves the WebView, the IPC bridge, and agent86-core are wired.
// The thread UI forked from agent86-web replaces it from M1.
export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    appInfo().then(setInfo, (e: unknown) => setError(String(e)));
  }, []);

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-4 bg-[var(--bg)] text-[var(--text)]">
      <img src="/agent86-logo.png" alt="" width={96} height={96} />
      <h1 className="text-2xl font-semibold">Agent 86</h1>
      {error && <p className="text-[var(--error)]">Could not reach the app core: {error}</p>}
      {info && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-[var(--muted)]">
          <dt>App</dt>
          <dd>v{info.appVersion}</dd>
          <dt>agent86-core</dt>
          <dd>v{info.coreVersion}</dd>
          <dt>Platform</dt>
          <dd>
            {info.os} / {info.arch}
          </dd>
          <dt>Memory store</dt>
          <dd className={info.memoryOk ? "text-[var(--ok)]" : "text-[var(--error)]"}>
            {info.memoryOk ? "ok" : "unavailable"}
          </dd>
        </dl>
      )}
    </main>
  );
}

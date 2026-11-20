import { useEffect, useState } from "react";
import {
  appInfo,
  checkUpdate,
  installUpdate,
  restartApp,
  type AppInfo,
} from "../desktop-client/backend.ts";
import type { UpdateInfo, UpdateProgress } from "../desktop-client/events.ts";
import { buttonClass, primaryClass, Section } from "./fields.tsx";

type Stage =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "found"; update: UpdateInfo }
  | { kind: "installing"; update: UpdateInfo; progress: UpdateProgress | null }
  | { kind: "installed"; update: UpdateInfo }
  | { kind: "failed"; message: string; update: UpdateInfo | null };

/** "12.3 of 48.0 MB", or "12.3 MB" when the total is unknown. */
export function progressText(progress: UpdateProgress | null): string {
  if (!progress) return "Starting the download…";
  if (progress.type === "installing") return "Installing…";
  const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1);
  return progress.total
    ? `Downloading ${mb(progress.downloaded)} of ${mb(progress.total)} MB`
    : `Downloading ${mb(progress.downloaded)} MB`;
}

/**
 * The version this is, and updates from GitHub Releases: check, read the notes, download, install,
 * and restart. `found` is an update the startup check already found.
 */
export function AboutSection({
  found,
  checkOnStart,
  onCheckOnStart,
}: {
  found: UpdateInfo | null;
  checkOnStart: boolean;
  onCheckOnStart: (on: boolean) => void;
}) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [stage, setStage] = useState<Stage>(
    found ? { kind: "found", update: found } : { kind: "idle" },
  );
  useEffect(() => {
    appInfo().then(setInfo, () => {});
  }, []);

  const check = () => {
    setStage({ kind: "checking" });
    checkUpdate().then(
      (update) => setStage(update ? { kind: "found", update } : { kind: "latest" }),
      (e: unknown) => setStage({ kind: "failed", message: String(e), update: null }),
    );
  };

  const install = (update: UpdateInfo) => {
    setStage({ kind: "installing", update, progress: null });
    installUpdate((progress) => setStage({ kind: "installing", update, progress })).then(
      // On Windows the installer has closed the app by now; elsewhere it waits for a restart.
      () => setStage({ kind: "installed", update }),
      (e: unknown) => setStage({ kind: "failed", message: String(e), update }),
    );
  };

  const update = "update" in stage ? stage.update : null;
  return (
    <Section title="About">
      {info && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-muted">Agent 86</dt>
          <dd className="font-mono">{info.appVersion}</dd>
          <dt className="text-muted">agent86-core</dt>
          <dd className="font-mono">{info.coreVersion}</dd>
          <dt className="text-muted">System</dt>
          <dd className="font-mono">
            {info.os}/{info.arch}
          </dd>
        </dl>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1 accent-[var(--accent)]"
          checked={checkOnStart}
          onChange={(e) => onCheckOnStart(e.target.checked)}
        />
        <span>
          Check for updates when the app starts
          <span className="block text-xs text-muted">
            Asks GitHub Releases for the latest published version; nothing is downloaded until you
            choose to install. Saved with the other settings.
          </span>
        </span>
      </label>
      <div className="flex flex-col gap-2 rounded border border-border bg-panel p-3 text-sm">
        {stage.kind === "idle" && <span className="text-muted">Not checked yet.</span>}
        {stage.kind === "checking" && <span className="text-muted">Checking…</span>}
        {stage.kind === "latest" && <span className="text-ok">This is the latest version.</span>}
        {update && stage.kind !== "failed" && (
          <span>
            Version <span className="font-mono">{update.version}</span> is available
            {update.date && <span className="text-muted"> (published {update.date})</span>}; this is{" "}
            <span className="font-mono">{update.currentVersion}</span>.
          </span>
        )}
        {update?.notes && stage.kind === "found" && (
          <pre className="max-h-60 overflow-auto font-sans text-xs whitespace-pre-wrap text-muted">
            {update.notes}
          </pre>
        )}
        {stage.kind === "installing" && (
          <span className="text-muted" role="status">
            {progressText(stage.progress)}
          </span>
        )}
        {stage.kind === "installed" && (
          <span>Installed. Restart to use it; running turns stop.</span>
        )}
        {stage.kind === "failed" && (
          <span role="alert" className="text-error">
            {stage.message}
          </span>
        )}
        <div className="flex gap-2">
          {stage.kind === "found" && (
            <button type="button" className={primaryClass} onClick={() => install(stage.update)}>
              Download and install
            </button>
          )}
          {stage.kind === "installed" && (
            <button type="button" className={primaryClass} onClick={() => void restartApp()}>
              Restart now
            </button>
          )}
          {stage.kind !== "installing" && stage.kind !== "installed" && (
            <button
              type="button"
              className={buttonClass}
              disabled={stage.kind === "checking"}
              onClick={check}
            >
              Check for updates
            </button>
          )}
        </div>
        {stage.kind === "found" && (
          <span className="text-xs text-muted">
            The download is verified against the app&apos;s update key before it is installed. On
            Windows the installer closes the app to install it.
          </span>
        )}
      </div>
    </Section>
  );
}

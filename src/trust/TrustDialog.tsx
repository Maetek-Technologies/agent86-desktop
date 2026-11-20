import { useEffect, useRef, useState } from "react";
import { reviewProject, trustProject } from "../desktop-client/backend.ts";
import type { McpServerSettings, ProjectContent, ProjectStatus } from "../desktop-client/events.ts";
import { showControls } from "./showControls.ts";

function server(s: McpServerSettings): string {
  return s.transport === "stdio" ? [s.command, ...s.args].join(" ") : `${s.transport} ${s.url}`;
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Review what a project brings before trusting it (forked from agent86-web's dialog): its skills,
 * specialists, MCP servers, every file that counts, and its config shown whole with invisible
 * characters made visible. Cancel has the focus: trusting takes a deliberate click.
 */
export function TrustDialog({
  threadId,
  onTrusted,
  onCancel,
}: {
  threadId: string;
  onTrusted: () => void;
  onCancel: () => void;
}) {
  const [content, setContent] = useState<ProjectContent | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    reviewProject(threadId).then(
      (c) => live && setContent(c),
      (e: unknown) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [threadId]);

  useEffect(() => {
    cancel.current?.focus();
  }, [content]);

  async function trust() {
    if (!content) return;
    setBusy(true);
    setError(null);
    try {
      await trustProject(threadId, content.sha256);
      onTrusted();
    } catch (e) {
      setError(String(e));
      // It may have changed: show what it is now.
      reviewProject(threadId).then(setContent, () => undefined);
    } finally {
      setBusy(false);
    }
  }

  const servers = content ? Object.entries(content.mcpServers) : [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Review and trust what this project brings"
      className="absolute inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-10"
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
    >
      <div className="w-full max-w-2xl rounded-lg border-2 border-warn bg-panel shadow-xl">
        <div className="space-y-2 border-b border-border px-4 py-3">
          <h2 className="font-semibold">Trust what this project brings?</h2>
          <p className="text-sm">
            <strong className="text-warn">
              Skills and specialists are instructions the agent follows, and MCP servers are
              programs it starts.
            </strong>{" "}
            Agent 86 loads none of them until you trust them. Only trust what you have read and
            expect.
          </p>
        </div>
        <div className="space-y-3 px-4 py-3 text-sm">
          {content === undefined && !error && <p className="text-muted">Reading the project…</p>}
          {content === null && <p className="text-muted">This project brings nothing to trust.</p>}
          {content && (
            <>
              {content.skills.length > 0 && (
                <div>
                  Skills <span className="font-mono">{content.skills.join(", ")}</span>
                </div>
              )}
              {content.specialists.length > 0 && (
                <div>
                  Specialists <span className="font-mono">{content.specialists.join(", ")}</span>
                </div>
              )}
              {servers.length > 0 && (
                <div>
                  <div>MCP servers</div>
                  <ul className="mt-1 space-y-0.5 font-mono text-xs">
                    {servers.map(([name, s]) => (
                      <li key={name}>
                        <span className="text-text">{name}</span>{" "}
                        <span className="text-muted">{showControls(server(s))}</span>
                        {!s.enabled && <span className="text-muted"> (off)</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {content.notes.length > 0 && (
                <ul className="list-disc pl-5 text-xs text-warn">
                  {content.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              <details>
                <summary className="cursor-pointer text-xs text-muted">
                  {content.files.length} file{content.files.length === 1 ? "" : "s"} count toward
                  trust
                </summary>
                <ul className="mt-1 max-h-40 overflow-auto font-mono text-xs">
                  {content.files.map((f) => (
                    <li key={f.path} className="flex gap-2">
                      <span className="truncate">{showControls(f.path)}</span>
                      <span className="ml-auto shrink-0 text-muted">{size(f.bytes)}</span>
                    </li>
                  ))}
                </ul>
              </details>
              {content.config !== null && (
                <pre
                  aria-label="Project config file"
                  className="max-h-60 overflow-auto rounded border border-border bg-panel-2 p-3 font-mono text-xs whitespace-pre-wrap"
                >
                  {showControls(content.config)}
                </pre>
              )}
              <p className="font-mono text-xs break-all text-muted">sha256 {content.sha256}</p>
              <p className="text-xs text-muted">
                Any change to these files needs trust again.
                {content.config !== null &&
                  " Only the config's MCP servers are used; the app's own settings decide the rest."}{" "}
                The agent86 CLI keeps its own record.
              </p>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <button
            ref={cancel}
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-3 py-1 text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!content || busy}
            onClick={() => void trust()}
            className="ml-auto rounded border-2 border-warn px-3 py-1 text-sm font-medium text-warn hover:bg-warn/10 disabled:opacity-40"
          >
            Trust and reload the thread
          </button>
        </div>
      </div>
    </div>
  );
}

/** What a project brings, in a few words. */
export function describeProject(project: ProjectStatus): string {
  const parts: string[] = [];
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  if (project.skills.length) parts.push(count(project.skills.length, "skill"));
  if (project.specialists.length) parts.push(count(project.specialists.length, "specialist"));
  if (project.mcpServers.length) parts.push(count(project.mcpServers.length, "MCP server"));
  return parts.join(", ");
}

/** Shown while a project's skills, specialists, or MCP servers wait for trust. */
export function TrustBanner({
  project,
  onReview,
}: {
  project: ProjectStatus;
  onReview: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (project.state === "trusted" || dismissed) return null;
  return (
    <div role="region" aria-label="Project trust" className="border-b border-warn bg-warn/10">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
        <span className="min-w-0 flex-1">
          {project.state === "changed"
            ? `This project's ${describeProject(project)} changed since you trusted them, so they are not loaded until you review them again.`
            : `This project brings ${describeProject(project)}, not loaded until you trust them.`}
        </span>
        <button
          type="button"
          onClick={onReview}
          className="rounded border border-warn px-2 py-0.5 font-medium text-warn hover:bg-warn/10"
        >
          Review and trust
        </button>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded px-2 py-0.5 text-muted hover:text-text"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

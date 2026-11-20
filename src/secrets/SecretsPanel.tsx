import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { forgetSecret, listSecrets, setSecret } from "../desktop-client/backend.ts";
import type { SecretList } from "../desktop-client/events.ts";
import { SecretInput, takeValue } from "./SecretInput.tsx";

/** agent86's rules for a secret's name and value (`vault::valid_name`, `MIN_SECRET_CHARS`). */
export function secretProblem(name: string, value: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return "A name uses letters, digits, and _, and does not start with a digit.";
  }
  if (value.length < 6) return "A secret needs at least 6 characters.";
  return null;
}

/**
 * The secrets this thread holds (forked from agent86-web): names only, with a badge for those
 * remembered for the project, a masked entry to add one, and forget. Tools that run commands get
 * each as an environment variable; the model sees only `${secret:NAME}`. Remembered secrets are
 * kept in the OS keyring for the workspace, in the layout the agent86 CLI uses, so threads opened
 * here later (in the app or the CLI) load them.
 */
export function SecretsPanel({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const [list, setList] = useState<SecretList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [name, setName] = useState("");
  const [remember, setRemember] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const value = useRef<HTMLInputElement>(null);

  const run = useCallback(async (action: () => Promise<SecretList>) => {
    setWorking(true);
    try {
      setList(await action());
      setError(null);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setWorking(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    listSecrets(threadId).then(
      (secrets) => live && setList(secrets),
      (e: unknown) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [threadId]);

  async function add(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    // A bad name is reported before the value is touched, so it need not be typed again.
    const nameProblem = secretProblem(trimmed, "______");
    if (nameProblem) {
      setError(nameProblem);
      return;
    }
    // Read and clear the masked entry at once; the value is only ever in this local.
    const typed = takeValue(value.current);
    const problem = secretProblem(trimmed, typed);
    if (problem) {
      setError(problem);
      return;
    }
    const kept = !!list?.canRemember && remember;
    if (await run(() => setSecret(threadId, trimmed, typed, kept))) {
      setName("");
      setRemember(false);
    }
  }

  return (
    <aside aria-label="Secrets" className="flex min-h-0 flex-col bg-panel text-sm">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 font-semibold">
        <span aria-hidden>🔑</span>
        <span>Secrets</span>
        <button
          type="button"
          aria-label="Close secrets"
          onClick={onClose}
          className="ml-auto rounded px-1 text-muted hover:text-text"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2">
        <p className="text-xs text-muted">
          Tools that run commands get each secret as an environment variable; the model only ever
          sees <span className="font-mono">{"${secret:NAME}"}</span>.
        </p>
        {list && list.secrets.length === 0 && (
          <p className="text-xs text-muted">No secrets in this thread.</p>
        )}
        {list && list.secrets.length > 0 && (
          <ul className="space-y-1">
            {list.secrets.map((secret) => (
              <li
                key={secret.name}
                className="flex items-center gap-2 rounded border border-border bg-panel-2 px-2 py-1"
              >
                <span className="font-mono">{secret.name}</span>
                {secret.remembered && (
                  <span className="rounded bg-accent/20 px-1 text-xs text-accent">remembered</span>
                )}
                {confirming === secret.name ? (
                  <span
                    role="alertdialog"
                    aria-label={`Forget ${secret.name}?`}
                    className="ml-auto flex items-center gap-1 text-xs"
                  >
                    Forget{secret.remembered ? " here and in the keyring" : ""}?
                    <button
                      type="button"
                      onClick={() => setConfirming(null)}
                      className="rounded border border-border px-1.5 hover:border-accent"
                    >
                      Keep
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirming(null);
                        void run(() => forgetSecret(threadId, secret.name));
                      }}
                      className="rounded border border-error px-1.5 text-error hover:bg-error/10"
                    >
                      Forget
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={working}
                    onClick={() => setConfirming(secret.name)}
                    className="ml-auto rounded px-1.5 text-xs text-muted hover:text-error disabled:opacity-50"
                  >
                    forget
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={(e) => void add(e)} autoComplete="off" className="space-y-2">
          <div className="text-xs font-medium text-muted">Add a secret</div>
          <input
            aria-label="Secret name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="NAME"
            spellCheck={false}
            className="w-full rounded border border-border bg-panel-2 px-2 py-1 font-mono text-sm"
          />
          <SecretInput ref={value} id="secrets-panel-value" label="Secret value" />
          {list?.canRemember && (
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>Remember for this project (OS keyring)</span>
            </label>
          )}
          <button
            type="submit"
            disabled={working || name.trim() === ""}
            className="rounded bg-accent px-3 py-1 text-sm font-medium text-bg disabled:opacity-50"
          >
            Add
          </button>
        </form>
        {error && (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        )}
      </div>
    </aside>
  );
}

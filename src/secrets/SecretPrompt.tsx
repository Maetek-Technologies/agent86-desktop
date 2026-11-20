import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { SecretInput, takeValue } from "./SecretInput.tsx";

/** agent86 refuses shorter values (`vault::MIN_SECRET_CHARS`). */
const MIN_CHARS = 6;

/**
 * The model asks for a secret through `request_secret`: a masked entry over the conversation
 * (forked from agent86-web). The input is uncontrolled, so the value never enters React state; it
 * is read once when sent, cleared at once, and goes to Rust in that one call. Nothing sends it
 * back: the model and the transcript only ever see `${secret:NAME}`. Enter sends; Decline, Esc,
 * and the close button decline. With a keyring, the value can also be remembered for the project,
 * where every later thread in it (and the agent86 CLI) loads it.
 */
export function SecretPrompt({
  name,
  reason,
  replacing,
  canRemember,
  onEnter,
  onDecline,
}: {
  name: string;
  reason: string;
  replacing: boolean;
  /** An OS keyring is there to remember the value in. */
  canRemember: boolean;
  onEnter: (value: string, remember: boolean) => void;
  onDecline: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    input.current?.focus();
  }, []);

  function decline() {
    if (input.current) input.current.value = "";
    onDecline();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const length = input.current?.value.length ?? 0;
    if (length === 0 || length < MIN_CHARS) {
      setProblem(
        length === 0 ? "Type a value, or decline." : `It needs at least ${MIN_CHARS} characters.`,
      );
      input.current?.focus();
      return;
    }
    onEnter(takeValue(input.current), canRemember && remember);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      decline();
    }
  }

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center overflow-y-auto bg-bg/70 p-4">
      <form
        role="dialog"
        aria-label={`Agent 86 asks for the secret ${name}`}
        onSubmit={submit}
        onKeyDown={onKeyDown}
        autoComplete="off"
        className="w-full max-w-md space-y-3 rounded-md border-2 border-warn bg-panel p-4 shadow-xl"
      >
        <div className="flex items-start gap-2">
          <span aria-hidden className="text-warn">
            🔑
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">
              Agent 86 asks for the secret <span className="font-mono">{name}</span>
            </h2>
            {reason && <p className="mt-1 text-sm break-words">{reason}</p>}
          </div>
          <button
            type="button"
            aria-label="Close and decline"
            onClick={decline}
            className="rounded px-1 text-muted hover:text-text"
          >
            ✕
          </button>
        </div>
        {replacing && (
          <p role="note" className="rounded border border-border bg-panel-2 p-2 text-xs">
            A value is already held as <span className="font-mono">{name}</span>; what you enter
            replaces it.
          </p>
        )}
        <SecretInput
          ref={input}
          id="secret-prompt-input"
          label={`Value for ${name}`}
          onInput={() => setProblem(null)}
        />
        {problem && (
          <p role="alert" className="text-xs text-error">
            {problem}
          </p>
        )}
        {canRemember && (
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>
              Remember for this project (kept in the OS keyring; threads opened here load it)
            </span>
          </label>
        )}
        <p className="text-xs text-muted">
          The model only ever sees the name. The value goes straight to Agent 86, is held for this
          thread{canRemember && remember ? " and the project" : " only"}, and is not kept in the
          transcript.
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={decline}
            className="rounded border border-border px-3 py-1 text-sm hover:border-error hover:text-error"
          >
            Decline
          </button>
          <button
            type="submit"
            className="rounded bg-accent px-3 py-1 text-sm font-medium text-bg hover:opacity-90"
          >
            Enter
          </button>
        </div>
      </form>
    </div>
  );
}

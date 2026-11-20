import { useEffect, useRef, useState, type KeyboardEvent } from "react";

interface Props {
  running: boolean;
  cancelling: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  /** A question panel holds the focus; when it closes, the focus comes back here. */
  questionOpen?: boolean;
}

// Enter sends, Shift+Enter adds a newline, Esc stops a running turn (agent86-web's keys).
export function PromptBox({ running, cancelling, onSend, onStop, questionOpen = false }: Props) {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const hadQuestion = useRef(questionOpen);

  useEffect(() => {
    if (hadQuestion.current && !questionOpen) box.current?.focus();
    hadQuestion.current = questionOpen;
  }, [questionOpen]);

  const send = () => {
    if (running || !text.trim()) return;
    onSend(text);
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape" && running) {
      e.preventDefault();
      onStop();
    }
  };

  return (
    <div className="flex items-end gap-2 border-t border-border bg-panel p-3">
      <textarea
        ref={box}
        className="max-h-48 min-h-[2.5rem] flex-1 resize-y rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
        placeholder={running ? "Working… (Esc to stop)" : "Ask Agent 86…"}
        aria-label="Prompt"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
      />
      {running ? (
        <button
          type="button"
          className="rounded-md border border-border px-4 py-2 text-sm hover:border-error hover:text-error disabled:opacity-50"
          onClick={onStop}
          disabled={cancelling}
        >
          {cancelling ? "Stopping…" : "Stop"}
        </button>
      ) : (
        <button
          type="button"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg disabled:opacity-50"
          onClick={send}
          disabled={!text.trim()}
        >
          Send
        </button>
      )}
    </div>
  );
}

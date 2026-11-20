import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { modLabel } from "../shell/shortcuts.ts";
import type { CommandInfo } from "../desktop-client/commands.ts";
import { loadHistory, pushHistory } from "./history.ts";

interface MenuItem {
  key: string;
  label: string;
  detail?: string;
  /** The text that replaces the token being completed. */
  insert: string;
}

/** The token at the caret: a slash command at the very start, or an @ mention anywhere. */
export function tokenAt(
  text: string,
  caret: number,
): { kind: "command" | "mention"; query: string; start: number } | undefined {
  const before = text.slice(0, caret);
  const command = /^\/(\S*)$/.exec(before);
  if (command) return { kind: "command", query: command[1]!, start: 0 };
  const mention = /(^|\s)@(\S*)$/.exec(before);
  if (mention)
    return { kind: "mention", query: mention[2]!, start: caret - mention[2]!.length - 1 };
  return undefined;
}

/** The `@` paths in `text` that the user picked from the menu, once each, in order. */
export function pickedMentions(text: string, picked: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)@(\S+)/g)) {
    const path = match[1]!;
    if (picked.has(path) && !found.includes(path)) found.push(path);
  }
  return found;
}

interface Props {
  workspace: string;
  running: boolean;
  cancelling: boolean;
  commands: CommandInfo[];
  /** Workspace files for the `@` menu. */
  findFiles: (query: string) => Promise<string[]>;
  onSend: (text: string, mentions: string[]) => void;
  onStop: () => void;
  /** A question panel holds the focus; when it closes, the focus comes back here. */
  questionOpen?: boolean;
}

/**
 * The input box (agent86-web's, adapted). Enter sends, Shift+Enter adds a line, Esc stops a
 * running turn. `/` at the start offers commands, `@` offers workspace files, and Up and Down walk
 * this workspace's history. While a turn runs the next prompt can be typed, but not sent.
 */
export function PromptInput({
  workspace,
  running,
  cancelling,
  commands,
  findFiles,
  onSend,
  onStop,
  questionOpen = false,
}: Props) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  /** Files for the @ token, with the token they were found for. */
  const [files, setFiles] = useState<{ key: string; items: MenuItem[] }>({ key: "", items: [] });
  /** The highlighted row, with the token it belongs to (a new token starts at the top). */
  const [highlight, setHighlight] = useState<{ key: string; index: number }>({ key: "", index: 0 });
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  const picked = useRef(new Set<string>());
  const history = useRef<{ entries: string[]; index: number; draft: string }>({
    entries: [],
    index: -1,
    draft: "",
  });
  const ref = useRef<HTMLTextAreaElement>(null);
  const hadQuestion = useRef(questionOpen);

  useEffect(() => {
    history.current = { entries: loadHistory(workspace), index: -1, draft: "" };
  }, [workspace]);

  useEffect(() => {
    if (hadQuestion.current && !questionOpen) ref.current?.focus();
    hadQuestion.current = questionOpen;
  }, [questionOpen]);

  useEffect(() => {
    if (!running) ref.current?.focus();
  }, [running]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const token = tokenAt(text, caret);
  const tokenKey = token ? `${token.kind}:${token.start}:${token.query}` : undefined;

  const commandItems = useMemo<MenuItem[]>(() => {
    if (token?.kind !== "command") return [];
    const q = token.query.toLowerCase();
    return commands
      .filter((c) => c.name.toLowerCase().startsWith(q))
      .map((c) => ({
        key: c.name,
        label: `/${c.name}`,
        detail: c.hint ? `${c.description} (${c.hint})` : c.description,
        insert: `/${c.name} `,
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tokenKey captures the token.
  }, [tokenKey, commands]);

  // Ask for files matching the @ token, after a short pause in typing.
  useEffect(() => {
    if (token?.kind !== "mention" || !tokenKey) return;
    let live = true;
    const timer = setTimeout(() => {
      findFiles(token.query)
        .then((found) => {
          if (live) {
            setFiles({
              key: tokenKey,
              items: found.slice(0, 12).map((f) => ({ key: f, label: f, insert: `@${f} ` })),
            });
          }
        })
        .catch(() => live && setFiles({ key: tokenKey, items: [] }));
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tokenKey captures the token.
  }, [tokenKey]);

  const items =
    token?.kind === "command" ? commandItems : token && files.key === tokenKey ? files.items : [];
  const selected =
    highlight.key === tokenKey ? Math.min(highlight.index, Math.max(0, items.length - 1)) : 0;
  const menuOpen = !!token && items.length > 0 && dismissed !== tokenKey;
  const canSend = !running && text.trim().length > 0;

  function send() {
    if (!canSend) return;
    const message = text.trim();
    onSend(message, pickedMentions(message, picked.current));
    history.current = { entries: pushHistory(workspace, message), index: -1, draft: "" };
    picked.current = new Set();
    setText("");
    setCaret(0);
  }

  function choose(item: MenuItem) {
    if (!token) return;
    const end = token.start + 1 + token.query.length;
    const next = text.slice(0, token.start) + item.insert + text.slice(end);
    if (token.kind === "mention") picked.current.add(item.key);
    setText(next);
    const position = token.start + item.insert.length;
    setCaret(position);
    requestAnimationFrame(() => ref.current?.setSelectionRange(position, position));
  }

  function recall(step: -1 | 1): boolean {
    const h = history.current;
    if (h.entries.length === 0) return false;
    if (h.index === -1 && step === 1) return false;
    if (h.index === -1) h.draft = text;
    const index = h.index === -1 ? h.entries.length - 1 : h.index + step;
    if (index < 0) return true;
    if (index >= h.entries.length) {
      h.index = -1;
      setText(h.draft);
      return true;
    }
    h.index = index;
    setText(h.entries[index]!);
    return true;
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (menuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setHighlight({
          key: tokenKey ?? "",
          index: (selected + step + items.length) % items.length,
        });
        return;
      }
      const item = items[selected]!;
      // A command typed out in full runs on Enter, as at the terminal; otherwise Enter completes.
      const complete = event.key === "Enter" && item.insert.trim() === text.trim();
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && !complete)) {
        event.preventDefault();
        choose(item);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(tokenKey);
        return;
      }
    }
    if (event.key === "Escape" && running) {
      event.preventDefault();
      onStop();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
      return;
    }
    const el = event.currentTarget;
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
    const atEnd = el.selectionStart === text.length;
    if (event.key === "ArrowUp" && (atStart || text === "" || history.current.index !== -1)) {
      if (recall(-1)) event.preventDefault();
    } else if (event.key === "ArrowDown" && (atEnd || history.current.index !== -1)) {
      if (recall(1)) event.preventDefault();
    }
  }

  return (
    <div className="border-t border-border bg-panel p-3">
      <div className="relative mx-auto max-w-4xl rounded-lg border border-border bg-bg focus-within:border-accent">
        {menuOpen && (
          <ul
            role="listbox"
            aria-label={token?.kind === "command" ? "Commands" : "Files"}
            className="absolute bottom-full left-0 mb-2 max-h-72 w-full overflow-auto rounded-lg border border-border bg-panel py-1 shadow-lg"
          >
            {items.map((item, i) => (
              <li
                key={item.key}
                role="option"
                aria-selected={i === selected}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(item);
                }}
                className={`flex cursor-pointer gap-3 px-3 py-1 text-sm ${i === selected ? "bg-panel-2" : ""}`}
              >
                <span className="shrink-0 font-mono">{item.label}</span>
                {item.detail && <span className="truncate text-muted">{item.detail}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2 p-2">
          <span aria-hidden className="pb-1.5 pl-1 font-mono text-accent">
            &gt;
          </span>
          <textarea
            data-prompt-input
            ref={ref}
            rows={1}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setCaret(event.target.selectionStart);
              setDismissed(undefined);
              history.current.index = -1;
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            placeholder={
              running
                ? "Agent 86 is working… (type ahead, Esc to stop)"
                : "Message Agent 86 (/ for commands, @ for files)"
            }
            aria-label="Prompt"
            aria-autocomplete="list"
            aria-expanded={menuOpen}
            autoFocus
            className="max-h-60 min-h-8 flex-1 resize-none bg-transparent py-1 text-sm outline-none placeholder:text-muted"
          />
          {running ? (
            <button
              type="button"
              onClick={onStop}
              disabled={cancelling}
              title={`Stop the turn (Esc, or ${modLabel()}.)`}
              className="rounded border border-border px-3 py-1 text-sm hover:border-error hover:text-error disabled:opacity-50"
            >
              {cancelling ? "Stopping…" : "Stop"}
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              className="rounded bg-accent px-3 py-1 text-sm font-medium text-bg disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

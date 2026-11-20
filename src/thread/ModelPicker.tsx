import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { listModels } from "../desktop-client/backend.ts";
import type { ModelMenu } from "../desktop-client/events.ts";

/** One line of the menu: a model to switch to, or going back to the settings' model. */
export interface MenuItem {
  /** `provider:model`; `""` means the settings' model. */
  reference: string;
  label: string;
  group: string;
}

/** `provider:model`, with a provider name and a non-empty model. */
export function looksLikeReference(text: string): boolean {
  return /^[A-Za-z0-9_.-]+:\S/.test(text.trim());
}

/**
 * The menu's items for `filter`: the settings' models first, then each provider's list (the current
 * model's provider first, so a local server's few models are not buried under a cloud catalog),
 * then what was typed when it names a model the lists do not have. Matching ignores case and looks at both
 * the reference and the provider's label.
 */
export function menuItems(
  menu: ModelMenu | null,
  filter: string,
  current: string,
  ownModel: boolean,
): MenuItem[] {
  const needle = filter.trim().toLowerCase();
  const matches = (item: MenuItem) =>
    !needle ||
    item.reference.toLowerCase().includes(needle) ||
    item.label.toLowerCase().includes(needle);
  const items: MenuItem[] = [];
  const seen = new Set<string>();
  const add = (item: MenuItem) => {
    if (seen.has(item.reference) || !matches(item)) return;
    seen.add(item.reference);
    items.push(item);
  };
  if (ownModel && !needle) {
    items.push({ reference: "", label: "The settings' model", group: "Settings" });
  }
  for (const reference of menu?.configured ?? []) {
    add({ reference, label: reference, group: "Settings" });
  }
  const currentProvider = current.split(":")[0];
  const providers = [...(menu?.providers ?? [])].sort(
    (a, b) => Number(b.provider === currentProvider) - Number(a.provider === currentProvider),
  );
  for (const provider of providers) {
    for (const model of provider.models) {
      add({
        reference: model.reference,
        label: model.label ? `${model.reference} (${model.label})` : model.reference,
        group: provider.provider,
      });
    }
  }
  const typed = filter.trim();
  if (looksLikeReference(typed) && !seen.has(typed)) {
    items.push({ reference: typed, label: `Use ${typed}`, group: "Typed" });
  }
  // The current model stays listed but is not a change.
  return items.filter((item) => item.reference !== current || item.reference === "");
}

/**
 * The thread's model, as a button that opens a menu of models to switch to: those in the
 * settings, what each provider lists, or a `provider:model` typed in. Switching keeps the
 * conversation and applies to this thread only.
 */
export function ModelPicker({
  model,
  ownModel,
  disabled,
  switching,
  onChoose,
}: {
  model: string;
  /** The thread runs on a model chosen here, not the settings'. */
  ownModel: boolean;
  /** A turn is running. */
  disabled: boolean;
  /** A switch is under way. */
  switching: boolean;
  /** `""` goes back to the settings' model. */
  onChoose: (reference: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<ModelMenu | null>(null);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const items = useMemo(
    () => menuItems(menu, filter, model, ownModel),
    [menu, filter, model, ownModel],
  );

  const show = () => {
    setOpen(true);
    setFilter("");
    setIndex(0);
    setProblem(null);
    setLoading(true);
    listModels().then(
      (listed) => {
        setMenu(listed);
        setLoading(false);
      },
      (e: unknown) => {
        setProblem(String(e));
        setLoading(false);
      },
    );
  };

  // Close on a click elsewhere.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const choose = (item: MenuItem) => {
    setOpen(false);
    onChoose(item.reference);
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setIndex((i) => (i + step + items.length) % items.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[Math.min(index, items.length - 1)];
      if (item) choose(item);
    }
  };

  const failed = menu?.providers.filter((p) => p.problem) ?? [];
  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        className="flex max-w-80 items-center gap-1 rounded px-1.5 font-mono text-xs text-muted hover:bg-panel-2 hover:text-text disabled:opacity-50"
        onClick={() => (open ? setOpen(false) : show())}
        disabled={disabled || switching}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${model}. Change this thread's model`}
        title={
          disabled
            ? "The model can be changed between turns"
            : "Change this thread's model (the conversation carries on)"
        }
      >
        <span className="truncate">{switching ? "Switching…" : model}</span>
        {ownModel && !switching && (
          <span className="text-accent" title="Chosen for this thread">
            •
          </span>
        )}
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="absolute top-full right-0 z-30 mt-1 w-[28rem] rounded-md border border-border bg-panel shadow-xl">
          <input
            ref={input}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onKey}
            placeholder="Filter, or type provider:model"
            aria-label="Filter models"
            spellCheck={false}
            className="w-full border-b border-border bg-transparent px-3 py-2 font-mono text-xs outline-none placeholder:text-muted"
          />
          <ul role="listbox" aria-label="Models" className="max-h-80 overflow-y-auto py-1 text-xs">
            {items.map((item, i) => {
              const header = i === 0 || items[i - 1]?.group !== item.group ? item.group : null;
              return (
                <li key={`${item.group}/${item.reference}`}>
                  {header && (
                    <div className="px-3 pt-2 pb-0.5 text-[0.65rem] tracking-wide text-muted uppercase">
                      {header}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === index}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => choose(item)}
                    className={`block w-full truncate px-3 py-1 text-left font-mono ${
                      i === index ? "bg-panel-2 text-text" : "text-muted"
                    }`}
                    title={item.reference || "Use the default model and triage from Settings"}
                  >
                    {item.label}
                  </button>
                </li>
              );
            })}
            {!loading && items.length === 0 && (
              <li className="px-3 py-2 text-muted">
                {filter ? "No model matches. Type provider:model to use one." : "No other models."}
              </li>
            )}
          </ul>
          <div className="space-y-0.5 border-t border-border px-3 py-1.5 text-[0.7rem] text-muted">
            <div>
              Current: <span className="font-mono">{model}</span>
            </div>
            {loading && <div>Asking the providers for their models…</div>}
            {problem && <div className="text-error">{problem}</div>}
            {failed.map((p) => (
              <div key={p.provider} title={p.problem ?? undefined} className="truncate">
                {p.provider}: {p.problem}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import type { Approval } from "../desktop-client/events.ts";

/** How each approval mode reads in the header and its menu. */
export const MODES: Record<Approval, { label: string; detail: string; className: string }> = {
  ask: {
    label: "Ask",
    detail: "Ask before each change to files and each command",
    className: "text-muted",
  },
  auto: {
    label: "Auto",
    detail: "Make changes and run commands without asking",
    className: "text-warn",
  },
  deny: {
    label: "Read-only",
    detail: "Refuse every change and command; reading still works",
    className: "text-muted",
  },
};

const ORDER: Approval[] = ["ask", "auto", "deny"];

/**
 * What happens to the agent's side-effecting tool calls in this thread, as a button that opens a
 * menu of the three modes. Switching keeps the conversation and the thread's "always allow"
 * choices, and applies to this thread only.
 */
export function PermissionPicker({
  approval,
  ownApproval,
  disabled,
  switching,
  onChoose,
}: {
  approval: Approval;
  /** The mode was chosen here rather than taken from the settings. */
  ownApproval: boolean;
  /** A turn is running. */
  disabled: boolean;
  switching: boolean;
  /** `null` goes back to the settings' mode. */
  onChoose: (approval: Approval | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const mode = MODES[approval];

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const choose = (next: Approval | null) => {
    setOpen(false);
    onChoose(next);
  };

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        className={`flex items-center gap-1 rounded px-1.5 text-xs hover:bg-panel-2 hover:text-text disabled:opacity-50 ${mode.className}`}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || switching}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Permissions: ${mode.label}. Change what this thread may do`}
        title={disabled ? "Permissions can be changed between turns" : mode.detail}
      >
        <span aria-hidden>🛡</span>
        <span>{switching ? "Switching…" : mode.label}</span>
        {ownApproval && !switching && (
          <span className="text-accent" title="Chosen for this thread">
            •
          </span>
        )}
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Permissions"
          className="absolute top-full right-0 z-30 mt-1 w-80 rounded-md border border-border bg-panel py-1 text-xs shadow-xl"
        >
          {ORDER.map((value) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={value === approval}
              onClick={() => (value === approval ? setOpen(false) : choose(value))}
              className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-panel-2"
            >
              <span className="w-3 shrink-0 text-accent" aria-hidden>
                {value === approval ? "✓" : ""}
              </span>
              <span>
                <span className={value === "auto" ? "text-warn" : "text-text"}>
                  {MODES[value].label}
                </span>
                <span className="block text-muted">{MODES[value].detail}</span>
              </span>
            </button>
          ))}
          {ownApproval && (
            <button
              type="button"
              role="menuitem"
              onClick={() => choose(null)}
              className="mt-1 block w-full border-t border-border px-3 pt-1.5 pb-1 pl-8 text-left text-muted hover:bg-panel-2 hover:text-text"
            >
              Use the settings&apos; mode
            </button>
          )}
          <div className="border-t border-border px-3 pt-1.5 pb-1 text-[0.7rem] text-muted">
            For this thread only; the conversation and its &quot;always allow&quot; choices carry
            on.
          </div>
        </div>
      )}
    </div>
  );
}

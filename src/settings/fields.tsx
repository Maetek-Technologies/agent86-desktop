// Small form controls shared by the settings screens, styled like the rest of the app.
import { useId, useState, type ReactNode } from "react";
import type { ProviderSettings } from "../desktop-client/events.ts";
import { splitRef } from "./settings-model.ts";

/** An input's look without a width, for controls sized on their own. */
export const inputBase =
  "rounded border border-border bg-bg px-2 py-1 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60";
export const inputClass = `w-full ${inputBase}`;
export const buttonClass =
  "shrink-0 whitespace-nowrap rounded border border-border px-3 py-1 text-sm hover:bg-panel-2 disabled:opacity-50";
export const primaryClass =
  "shrink-0 whitespace-nowrap rounded bg-accent px-3 py-1 text-sm font-medium text-bg disabled:opacity-50";

/** A labelled control with an optional hint under it. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
      </label>
      {children(id)}
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function TextField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  mono,
  disabled,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <input
          id={id}
          className={`${inputClass} ${mono ? "font-mono" : ""}`}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

/**
 * A number typed as text: `parse` turns the text into a value or `null` when it is not one, and
 * only valid values reach `onChange`; an invalid entry is marked until fixed.
 */
export function NumberField({
  label,
  hint,
  value,
  parse,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: ReactNode;
  value: number | null;
  parse: (text: string) => number | null;
  onChange: (value: number | null) => void;
  placeholder?: string;
}) {
  const shown = value === null ? "" : String(value);
  const [text, setText] = useState(shown);
  const [synced, setSynced] = useState(shown);
  // Follow outside changes (an import, a reset) without fighting the user's typing.
  if (shown !== synced) {
    setSynced(shown);
    setText(shown);
  }
  const optional = placeholder !== undefined;
  const bad = !(text.trim() === "" && optional) && parse(text) === null;
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <input
          id={id}
          inputMode="decimal"
          className={`${inputBase} w-40 ${bad ? "border-error" : ""}`}
          value={text}
          placeholder={placeholder}
          aria-invalid={bad}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            if (next.trim() === "" && optional) {
              setSynced("");
              onChange(null);
              return;
            }
            const parsed = parse(next);
            if (parsed !== null) {
              setSynced(String(parsed));
              onChange(parsed);
            }
          }}
        />
      )}
    </Field>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-1 accent-[var(--accent)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

export function Select<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <select
          id={id}
          className={`${inputBase} w-auto self-start`}
          value={value}
          onChange={(e) => onChange(e.target.value as T)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** Multi-line text committed as typed; `parse` may refuse it, and the refusal is shown. */
export function LinesField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  /** Returns a problem to show, or `null` when the text was taken. */
  onChange: (text: string) => string | null;
  placeholder?: string;
  rows?: number;
}) {
  const [text, setText] = useState(value);
  const [problem, setProblem] = useState<string | null>(null);
  const [synced, setSynced] = useState(value);
  const [focused, setFocused] = useState(false);
  // Outside changes (an import, a discard) show once the user is not typing here, so what they
  // type is never reformatted under them.
  if (!focused && problem === null && value !== synced) {
    setSynced(value);
    setText(value);
  }
  return (
    <Field label={label} hint={problem ? <span className="text-error">{problem}</span> : hint}>
      {(id) => (
        <textarea
          id={id}
          rows={rows}
          className={`${inputClass} font-mono ${problem ? "border-error" : ""}`}
          value={text}
          placeholder={placeholder}
          spellCheck={false}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setText(e.target.value);
            setProblem(onChange(e.target.value));
          }}
        />
      )}
    </Field>
  );
}

/** A `provider:model` reference edited as a provider choice and a model name. */
export function ModelRefField({
  label,
  hint,
  value,
  providers,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  providers: Record<string, ProviderSettings>;
  onChange: (reference: string) => void;
}) {
  const names = Object.keys(providers);
  const split = splitRef(value);
  const [provider, setProvider] = useState(split?.provider ?? names[0] ?? "");
  const [model, setModel] = useState(split?.model ?? "");
  const [synced, setSynced] = useState(value);
  // A value from outside (an import, a discard) replaces what is shown; what this field emitted
  // itself does not, so typing is never rewritten.
  if (value !== synced) {
    setSynced(value);
    if (split) {
      setProvider(split.provider);
      setModel(split.model);
    }
  }
  const emit = (p: string, m: string) => {
    const next = m.trim() === "" ? "" : `${p}:${m.trim()}`;
    setSynced(next);
    onChange(next);
  };
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <div className="flex gap-1">
          <select
            aria-label={`${label} provider`}
            className={`${inputBase} w-44 shrink-0`}
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              emit(e.target.value, model);
            }}
          >
            {!names.includes(provider) && provider !== "" && (
              <option value={provider}>{provider} (not set up)</option>
            )}
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <input
            id={id}
            className={`${inputClass} font-mono`}
            placeholder="model name"
            value={model}
            spellCheck={false}
            onChange={(e) => {
              setModel(e.target.value);
              emit(provider, e.target.value);
            }}
          />
        </div>
      )}
    </Field>
  );
}

/** A titled group of fields. */
export function Section({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {intro && <p className="mt-1 text-sm text-muted">{intro}</p>}
      </div>
      {children}
    </section>
  );
}

export function Problems({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div role="alert" className="rounded-md border border-error px-3 py-2 text-sm text-error">
      {text.split("\n").map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  );
}

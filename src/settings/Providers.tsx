import { useCallback, useEffect, useState } from "react";
import { deleteKey, keyStatuses, setKey } from "../desktop-client/backend.ts";
import type {
  KeyStatus,
  KeyUse,
  ProviderPreset,
  ProviderSettings,
  Settings,
} from "../desktop-client/events.ts";
import {
  buttonClass,
  inputClass,
  NumberField,
  primaryClass,
  Section,
  Select,
  TextField,
  Toggle,
} from "./fields.tsx";
import {
  fixedKeyUse,
  KIND_LABELS,
  keyUse,
  parseAmount,
  parseCount,
  uniqueName,
  usersOf,
  validProviderName,
  withoutProvider,
  withProvider,
} from "./settings-model.ts";

/**
 * Where each provider's key comes from, refreshed when the providers change and after a key is
 * stored or removed.
 */
export function useKeyStatuses(providers: Record<string, ProviderSettings>) {
  const [statuses, setStatuses] = useState<Record<string, KeyStatus>>({});
  const [version, setVersion] = useState(0);
  // Only what decides a key's source, so typing a URL does not re-read the keyring. Rust fills
  // the other fields with their defaults.
  const relevant = JSON.stringify(
    Object.fromEntries(
      Object.entries(providers).map(([n, p]) => [
        n,
        { kind: p.kind, key: p.key, apiKeyEnv: p.apiKeyEnv },
      ]),
    ),
  );
  useEffect(() => {
    let live = true;
    keyStatuses(JSON.parse(relevant) as Record<string, ProviderSettings>).then(
      (list) => live && setStatuses(Object.fromEntries(list.map((s) => [s.provider, s]))),
      () => live && setStatuses({}),
    );
    return () => {
      live = false;
    };
  }, [relevant, version]);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  return { statuses, refresh };
}

function describe(status: KeyStatus | undefined): { text: string; tone: string } {
  if (!status) return { text: "Checking…", tone: "text-muted" };
  switch (status.state) {
    case "keyring":
      return { text: "Key stored in the OS keyring", tone: "text-ok" };
    case "env":
      return { text: `Key from ${status.env ?? "the environment"}`, tone: "text-ok" };
    case "missing":
      return { text: "No key: threads using this provider will not start", tone: "text-error" };
    case "notSet":
      return { text: "No key (none needed unless the server asks for one)", tone: "text-muted" };
    case "notUsed":
      return { text: "Uses no key", tone: "text-muted" };
  }
}

/** A provider's key: where it comes from, and storing or removing one in the keyring. */
export function KeyRow({
  name,
  status,
  onChanged,
}: {
  name: string;
  status: KeyStatus | undefined;
  onChanged: () => void;
}) {
  const [entry, setEntry] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = describe(status);
  if (status?.state === "notUsed") return <div className="text-xs text-muted">{shown.text}</div>;

  const store = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await setKey(name, entry);
      setEntry("");
      onChanged();
    } catch (e) {
      setProblem(String(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await deleteKey(name);
      onChanged();
    } catch (e) {
      setProblem(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className={`text-xs ${shown.tone}`}>
        {shown.text}
        {status?.state === "env" && status.inKeyring && " (a keyring key is also stored)"}
      </div>
      <div className="flex gap-1">
        <input
          type="password"
          aria-label={`API key for ${name}`}
          className={`${inputClass} font-mono`}
          placeholder={status?.inKeyring ? "Paste a new key to replace it" : "Paste an API key"}
          value={entry}
          autoComplete="off"
          onChange={(e) => setEntry(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && entry.trim() !== "") void store();
          }}
        />
        <button
          type="button"
          className={primaryClass}
          disabled={busy || entry.trim() === ""}
          onClick={() => void store()}
        >
          Store key
        </button>
        {status?.inKeyring && (
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void remove()}
          >
            Remove key
          </button>
        )}
      </div>
      <div className="text-xs text-muted">
        Shared with the CLI: <span className="font-mono">agent86 keys set {name}</span> uses the
        same entry.
      </div>
      {problem && <div className="text-xs text-error">{problem}</div>}
    </div>
  );
}

const KEY_USES: { value: KeyUse; label: string }[] = [
  { value: "required", label: "Required" },
  { value: "optional", label: "Optional (sent when stored)" },
  { value: "none", label: "None" },
];

function ProviderCard({
  name,
  provider,
  usedBy,
  status,
  onChange,
  onRemove,
  onKeyChanged,
}: {
  name: string;
  provider: ProviderSettings;
  usedBy: string[];
  status: KeyStatus | undefined;
  onChange: (provider: ProviderSettings) => void;
  onRemove: () => void;
  onKeyChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<ProviderSettings>) => onChange({ ...provider, ...patch });
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-panel p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-semibold">{name}</span>
        <span className="rounded bg-panel-2 px-1.5 text-xs text-muted">
          {KIND_LABELS[provider.kind]}
        </span>
        <span className="flex-1 truncate text-xs text-muted">
          {usedBy.length > 0 && `used by ${usedBy.join(", ")}`}
        </span>
        <button
          type="button"
          className="text-xs text-muted hover:text-error disabled:opacity-40"
          disabled={usedBy.length > 0}
          title={usedBy.length > 0 ? "A model uses this provider" : `Remove ${name}`}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>
      {provider.kind !== "anthropic" && provider.kind !== "google" ? (
        <TextField
          label="URL"
          value={provider.baseUrl ?? ""}
          mono
          placeholder="the adapter's default"
          onChange={(v) => set({ baseUrl: v.trim() === "" ? null : v.trim() })}
        />
      ) : null}
      <KeyRow name={name} status={status} onChanged={onKeyChanged} />
      <button
        type="button"
        className="self-start text-xs text-muted hover:text-text"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "▾" : "▸"} More
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-3">
          {(provider.kind === "anthropic" || provider.kind === "google") && (
            <TextField
              label="URL"
              value={provider.baseUrl ?? ""}
              mono
              placeholder="the provider's own"
              onChange={(v) => set({ baseUrl: v.trim() === "" ? null : v.trim() })}
            />
          )}
          {fixedKeyUse(provider.kind) === null && (
            <Select
              label="API key"
              value={provider.key}
              options={KEY_USES}
              onChange={(key) => set({ key })}
            />
          )}
          {keyUse(provider) !== "none" && (
            <TextField
              label="Key variable"
              hint="An environment variable that wins over the keyring."
              value={provider.apiKeyEnv ?? ""}
              mono
              placeholder="none"
              onChange={(v) => set({ apiKeyEnv: v.trim() === "" ? null : v.trim() })}
            />
          )}
          <NumberField
            label="Output cap (tokens)"
            hint="Overrides the limit for this provider's models."
            value={provider.maxTokens}
            parse={(t) => parseCount(t, 1)}
            placeholder="the limit"
            onChange={(maxTokens) => set({ maxTokens })}
          />
          {provider.kind === "ollama" && (
            <NumberField
              label="Context to ask for (num_ctx)"
              value={provider.numCtx}
              parse={(t) => parseCount(t, 1)}
              placeholder="Ollama's default"
              onChange={(numCtx) => set({ numCtx })}
            />
          )}
          <NumberField
            label="Connect timeout (s)"
            value={provider.connectTimeoutS}
            parse={parseAmount}
            onChange={(v) => v !== null && set({ connectTimeoutS: v })}
          />
          <NumberField
            label="Read timeout (s)"
            hint="The longest gap between streamed chunks."
            value={provider.readTimeoutS}
            parse={parseAmount}
            onChange={(v) => v !== null && set({ readTimeoutS: v })}
          />
          <NumberField
            label="Retries"
            value={provider.maxRetries}
            parse={(t) => parseCount(t)}
            onChange={(v) => v !== null && set({ maxRetries: v })}
          />
          {provider.kind === "anthropic" && (
            <Toggle
              label="Prompt caching"
              checked={provider.promptCache}
              onChange={(promptCache) => set({ promptCache })}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The providers models can run on, each with its key. */
export function ProvidersSection({
  draft,
  presets,
  onChange,
}: {
  draft: Settings;
  presets: ProviderPreset[];
  onChange: (settings: Settings) => void;
}) {
  const { statuses, refresh } = useKeyStatuses(draft.providers);
  const [choice, setChoice] = useState(presets[0]?.name ?? "custom");
  const [name, setName] = useState("");
  const chosen = presets.find((p) => p.name === choice);
  const suggested = uniqueName(Object.keys(draft.providers), chosen?.name ?? "custom");
  const newName = name.trim() === "" ? suggested : name.trim();
  const nameOk = validProviderName(newName) && !(newName in draft.providers);

  const add = () => {
    const provider: ProviderSettings = chosen
      ? chosen.provider
      : {
          ...(presets.find((p) => p.name === "openai")?.provider as ProviderSettings),
          baseUrl: "",
        };
    onChange(withProvider(draft, newName, provider));
    setName("");
  };

  return (
    <Section
      title="Providers"
      intro="Where models run. A model is named provider:model, and each provider's API key is kept in the OS keyring under the provider's name."
    >
      {Object.entries(draft.providers).map(([n, p]) => (
        <ProviderCard
          key={n}
          name={n}
          provider={p}
          usedBy={usersOf(draft, n)}
          status={statuses[n]}
          onChange={(next) => onChange(withProvider(draft, n, next))}
          onRemove={() => onChange(withoutProvider(draft, n))}
          onKeyChanged={refresh}
        />
      ))}
      <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border p-3">
        <Select
          label="Add a provider"
          value={choice}
          options={[
            ...presets.map((p) => ({ value: p.name, label: p.label })),
            { value: "custom", label: "Other OpenAI-compatible endpoint" },
          ]}
          onChange={setChoice}
        />
        <div className="w-48">
          <TextField label="Name" value={name} placeholder={suggested} mono onChange={setName} />
        </div>
        <button type="button" className={buttonClass} disabled={!nameOk} onClick={add}>
          Add
        </button>
      </div>
    </Section>
  );
}

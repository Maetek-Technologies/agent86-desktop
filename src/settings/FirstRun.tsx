import { useState } from "react";
import { previewCliImport, saveSettings, setKey, testModel } from "../desktop-client/backend.ts";
import type { ImportPreview, Settings, SettingsState } from "../desktop-client/events.ts";
import { buttonClass, inputClass, primaryClass, Problems, Select, TextField } from "./fields.tsx";
import { keyUse, setupSettings, validProviderName } from "./settings-model.ts";
import { ImportSummary } from "./SettingsView.tsx";

/**
 * The first screen, before the app has settings: bring them over from the agent86 CLI, or set
 * up one provider and model. Either way the result is the app's own settings.json.
 */
export function FirstRun({
  state,
  onDone,
}: {
  state: SettingsState;
  onDone: (settings: Settings) => void;
}) {
  return (
    <main className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
        <div className="flex items-center gap-4">
          <img src="/agent86-logo.png" alt="" width={64} height={64} />
          <div>
            <h1 className="text-2xl font-semibold">Welcome to Agent 86</h1>
            <p className="text-sm text-muted">Choose the model the agent runs on to get started.</p>
          </div>
        </div>
        {state.problem && (
          <Problems
            text={`The settings file could not be read, so you are setting up afresh; saving replaces it.\n${state.problem}`}
          />
        )}
        {state.cliConfig && <ImportCard path={state.cliConfig} onDone={onDone} />}
        <SetupCard state={state} onDone={onDone} alternative={!!state.cliConfig} />
        {state.path && <p className="text-xs text-muted">Settings are kept in {state.path}.</p>}
      </div>
    </main>
  );
}

function ImportCard({ path, onDone }: { path: string; onDone: (settings: Settings) => void }) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const read = () => {
    setProblem(null);
    previewCliImport().then(setPreview, (e: unknown) => setProblem(String(e)));
  };
  const take = async () => {
    if (!preview) return;
    setBusy(true);
    setProblem(null);
    try {
      onDone(await saveSettings(preview.settings));
    } catch (e) {
      setProblem(
        `${String(e)}\nFix this after importing is not possible here; set up a provider below instead, or edit the CLI config and read it again.`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-accent p-4">
      <h2 className="font-semibold">Use your agent86 CLI settings</h2>
      <p className="text-sm text-muted">
        Found <span className="font-mono">{path}</span>. Bring over its models, providers, limits,
        guardrails, and MCP servers. Keys stored with{" "}
        <span className="font-mono">agent86 keys</span> work here as they are. This is a copy: later
        changes to either side stay on that side.
      </p>
      {!preview && (
        <div>
          <button type="button" className={primaryClass} onClick={read}>
            Review what would be imported
          </button>
        </div>
      )}
      {preview && (
        <ImportSummary
          preview={preview}
          action={busy ? "Importing…" : "Import and continue"}
          busy={busy}
          onUse={() => void take()}
        />
      )}
      <Problems text={problem} />
    </section>
  );
}

function SetupCard({
  state,
  onDone,
  alternative,
}: {
  state: SettingsState;
  onDone: (settings: Settings) => void;
  /** Shown under the import card, as the other way. */
  alternative: boolean;
}) {
  const presets = state.presets;
  const [choice, setChoice] = useState(presets[0]?.name ?? "");
  const preset = presets.find((p) => p.name === choice) ?? presets[0]!;
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [key, setKeyText] = useState("");
  const [keyStored, setKeyStored] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const providerName = name.trim() === "" ? preset.name : name.trim();
  const settings = setupSettings(state.defaults, preset, providerName, model, baseUrl);
  const uses = keyUse(preset.provider);
  const urlEditable = preset.provider.kind !== "anthropic" && preset.provider.kind !== "google";
  const ready = model.trim() !== "" && validProviderName(providerName);

  /** Store the typed key (if any) where the CLI keeps it; the test and the threads read it there. */
  const storeKey = async () => {
    if (key.trim() === "") return;
    await setKey(providerName, key);
    setKeyText("");
    setKeyStored(true);
  };

  const finish = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await storeKey();
      onDone(await saveSettings(settings));
    } catch (e) {
      setProblem(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h2 className="font-semibold">
        {alternative ? "Or set up a provider" : "Set up a provider"}
      </h2>
      <div className="flex flex-wrap gap-3">
        <Select
          label="Provider"
          value={choice}
          options={presets.map((p) => ({ value: p.name, label: p.label }))}
          onChange={(v) => {
            setChoice(v);
            setBaseUrl("");
            setKeyStored(false);
          }}
        />
        <div className="w-44">
          <TextField
            label="Name"
            hint="Also the keyring account for its key."
            value={name}
            placeholder={preset.name}
            mono
            onChange={setName}
          />
        </div>
      </div>
      {urlEditable && (
        <TextField
          label="URL"
          value={baseUrl}
          placeholder={preset.provider.baseUrl ?? ""}
          mono
          onChange={setBaseUrl}
        />
      )}
      <TextField
        label="Model"
        value={model}
        placeholder={`e.g. ${preset.exampleModel}`}
        mono
        onChange={setModel}
      />
      {uses !== "none" && (
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted" htmlFor="first-run-key">
            API key{uses === "optional" ? " (only if the server needs one)" : ""}
          </label>
          <input
            id="first-run-key"
            type="password"
            autoComplete="off"
            className={`${inputClass} font-mono`}
            value={key}
            placeholder={
              keyStored
                ? "Stored in the keyring"
                : `Paste a key, or leave empty if agent86 keys set ${providerName} was used`
            }
            onChange={(e) => setKeyText(e.target.value)}
          />
          <span className="text-xs text-muted">
            Kept in the OS keyring, never in the settings file.
          </span>
        </div>
      )}
      <Problems text={problem} />
      <div className="flex flex-wrap items-start gap-2">
        <button
          type="button"
          className={primaryClass}
          disabled={!ready || busy}
          onClick={() => void finish()}
        >
          {busy ? "Saving…" : "Save and continue"}
        </button>
        <SetupTest ready={ready} storeKey={storeKey} settings={settings} />
      </div>
    </section>
  );
}

/** Test the model as set up so far, storing a typed key first (the test reads it from the keyring). */
function SetupTest({
  ready,
  storeKey,
  settings,
}: {
  ready: boolean;
  storeKey: () => Promise<void>;
  settings: Settings;
}) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      await storeKey();
      setResult({ ok: true, text: await testModel(settings, settings.model.default) });
    } catch (e) {
      setResult({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-start gap-2">
      <button
        type="button"
        className={buttonClass}
        disabled={!ready || busy}
        onClick={() => void run()}
      >
        {busy ? "Testing…" : "Test"}
      </button>
      {result && (
        <span className={`pt-1 text-xs ${result.ok ? "text-ok" : "text-error"}`}>
          {result.text}
        </span>
      )}
    </div>
  );
}

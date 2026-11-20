import { useEffect, useState } from "react";
import {
  forgetTrust,
  previewCliImport,
  saveSettings,
  testModel,
  trustedProjects,
} from "../desktop-client/backend.ts";
import type {
  ImportPreview,
  McpServerSettings,
  McpTransport,
  Settings,
  SettingsState,
  TrustedProject,
} from "../desktop-client/events.ts";
import {
  buttonClass,
  LinesField,
  ModelRefField,
  NumberField,
  primaryClass,
  Problems,
  Section,
  Select,
  TextField,
  Toggle,
} from "./fields.tsx";
import { ProvidersSection } from "./Providers.tsx";
import {
  formatPairs,
  parseAmount,
  parseCount,
  parseLines,
  parsePairs,
  sameSettings,
  validServerName,
} from "./settings-model.ts";

const SECTIONS = [
  "Model",
  "Providers",
  "Limits",
  "Guardrails",
  "MCP servers",
  "Memory",
  "Projects",
] as const;
type SectionName = (typeof SECTIONS)[number];

/**
 * The app's settings, edited as a draft and kept with Save. Threads already open keep the
 * settings they started with; API keys are stored at once, apart from the draft.
 */
export function SettingsView({
  state,
  onSaved,
  onClose,
}: {
  state: SettingsState & { settings: Settings };
  onSaved: (settings: Settings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Settings>(state.settings);
  const [section, setSection] = useState<SectionName>("Model");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = !sameSettings(draft, state.settings);

  const change = (next: Settings) => {
    setDraft(next);
    setSaved(false);
  };
  const save = async () => {
    setSaving(true);
    setProblem(null);
    try {
      const kept = await saveSettings(draft);
      setDraft(kept);
      setSaved(true);
      onSaved(kept);
    } catch (e) {
      setProblem(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2">
        <h1 className="text-lg font-semibold">Settings</h1>
        <span className="flex-1 truncate text-xs text-muted">
          {saved ? "Saved. New threads use these settings." : state.path}
        </span>
        {dirty ? (
          <>
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setDraft(state.settings);
                setProblem(null);
              }}
            >
              Discard changes
            </button>
            <button
              type="button"
              className={primaryClass}
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        ) : (
          <button type="button" className={buttonClass} onClick={onClose}>
            Close
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-border p-2 text-sm">
          {SECTIONS.map((name) => (
            <button
              key={name}
              type="button"
              aria-current={name === section ? "page" : undefined}
              className={`rounded px-2 py-1 text-left ${
                name === section ? "bg-panel-2 text-text" : "text-muted hover:text-text"
              }`}
              onClick={() => setSection(name)}
            >
              {name}
            </button>
          ))}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
            <Problems text={problem} />
            {section === "Model" && <ModelSection draft={draft} onChange={change} />}
            {section === "Providers" && (
              <ProvidersSection draft={draft} presets={state.presets} onChange={change} />
            )}
            {section === "Limits" && <LimitsSection draft={draft} onChange={change} />}
            {section === "Guardrails" && <GuardrailsSection draft={draft} onChange={change} />}
            {section === "MCP servers" && <McpSection draft={draft} onChange={change} />}
            {section === "Memory" && (
              <MemorySection state={state} draft={draft} onChange={change} />
            )}
            {section === "Projects" && <ProjectsSection />}
          </div>
        </main>
      </div>
    </div>
  );
}

type Props = { draft: Settings; onChange: (settings: Settings) => void };

/** A button that sends a model a one-line request and shows what came back. */
export function TestButton({ settings, reference }: { settings: Settings; reference: string }) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult({ ok: true, text: await testModel(settings, reference) });
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
        disabled={busy || reference.trim() === ""}
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

function ModelSection({ draft, onChange }: Props) {
  const model = draft.model;
  const setModel = (patch: Partial<Settings["model"]>) =>
    onChange({ ...draft, model: { ...model, ...patch } });
  const windows = Object.entries(model.contextWindows);
  return (
    <Section
      title="Model"
      intro="The model new threads use. A test sends it one short request with these settings, saved or not."
    >
      <ModelRefField
        label="Default model"
        value={model.default}
        providers={draft.providers}
        onChange={(v) => setModel({ default: v })}
      />
      <TestButton settings={draft} reference={model.default} />
      <Toggle
        label="Triage"
        hint="Send short, plain asks to a cheap model and everything else to a frontier model; compaction summaries use the cheap one."
        checked={model.triage !== null}
        onChange={(on) =>
          setModel({
            triage: on ? { cheap: model.default, frontier: model.default } : null,
          })
        }
      />
      {model.triage && (
        <div className="flex flex-col gap-3 border-l-2 border-border pl-4">
          <ModelRefField
            label="Cheap model"
            value={model.triage.cheap}
            providers={draft.providers}
            onChange={(cheap) => setModel({ triage: { ...model.triage!, cheap } })}
          />
          <TestButton settings={draft} reference={model.triage.cheap} />
          <ModelRefField
            label="Frontier model"
            value={model.triage.frontier}
            providers={draft.providers}
            onChange={(frontier) => setModel({ triage: { ...model.triage!, frontier } })}
          />
          <TestButton settings={draft} reference={model.triage.frontier} />
        </div>
      )}
      <LinesField
        label="Context windows"
        hint="One per line, model=tokens (provider:model or the bare model name), for models agent86's table does not know, such as a local server's."
        value={windows.map(([k, v]) => `${k}=${v}`).join("\n")}
        placeholder="vllm:my-model=131072"
        onChange={(text) => {
          const parsed = parsePairs(text);
          if ("error" in parsed) return parsed.error;
          const entries: [string, number][] = [];
          for (const [key, value] of Object.entries(parsed.pairs)) {
            const n = parseCount(value, 1);
            if (n === null) return `${key}: ${value || "(empty)"} is not a number of tokens.`;
            entries.push([key, n]);
          }
          setModel({ contextWindows: Object.fromEntries(entries) });
          return null;
        }}
      />
    </Section>
  );
}

function LimitsSection({ draft, onChange }: Props) {
  const limits = draft.limits;
  const setLimits = (patch: Partial<Settings["limits"]>) =>
    onChange({ ...draft, limits: { ...limits, ...patch } });
  const agents = draft.agents;
  const setAgents = (patch: Partial<Settings["agents"]>) =>
    onChange({ ...draft, agents: { ...agents, ...patch } });
  return (
    <>
      <Section
        title="Limits"
        intro="When a turn stops. A turn that reaches its step budget asks before going on."
      >
        <div className="grid grid-cols-2 gap-4">
          <NumberField
            label="Steps per turn"
            value={limits.maxSteps}
            parse={(t) => parseCount(t, 1)}
            onChange={(v) => v !== null && setLimits({ maxSteps: v })}
          />
          <NumberField
            label="Spending cap per turn (USD)"
            hint="0 for none. Only priced models count."
            value={limits.maxCostUsd}
            parse={parseAmount}
            onChange={(v) => v !== null && setLimits({ maxCostUsd: v })}
          />
          <NumberField
            label="Time per turn (s)"
            hint="0 for no limit."
            value={limits.maxWallClockS}
            parse={(t) => parseCount(t)}
            onChange={(v) => v !== null && setLimits({ maxWallClockS: v })}
          />
          <NumberField
            label="Tool timeout (s)"
            hint="How long one command or fetch may run."
            value={limits.toolTimeoutS}
            parse={(t) => parseCount(t, 1)}
            onChange={(v) => v !== null && setLimits({ toolTimeoutS: v })}
          />
          <NumberField
            label="Output cap (tokens)"
            hint="The most one model call may write."
            value={limits.maxOutputTokens}
            parse={(t) => parseCount(t, 1)}
            onChange={(v) => v !== null && setLimits({ maxOutputTokens: v })}
          />
          <NumberField
            label="@ file size cap (bytes)"
            hint="The most of one mentioned file put into a prompt."
            value={draft.tools.mentionMaxBytes}
            parse={(t) => parseCount(t, 1)}
            onChange={(v) => v !== null && onChange({ ...draft, tools: { mentionMaxBytes: v } })}
          />
        </div>
      </Section>
      <Section title="Sub-agents and skills">
        <Toggle
          label="Sub-agents"
          hint="Let the model delegate to agent86's specialists and your own in ~/.agent86/agents."
          checked={agents.enabled}
          onChange={(enabled) => setAgents({ enabled })}
        />
        {agents.enabled && (
          <div className="grid grid-cols-3 gap-4">
            <NumberField
              label="Steps each"
              value={agents.maxSteps}
              parse={(t) => parseCount(t, 1)}
              onChange={(v) => v !== null && setAgents({ maxSteps: v })}
            />
            <NumberField
              label="At once"
              value={agents.maxParallel}
              parse={(t) => parseCount(t, 1)}
              onChange={(v) => v !== null && setAgents({ maxParallel: v })}
            />
            <NumberField
              label="Nesting depth"
              value={agents.maxDepth}
              parse={(t) => parseCount(t)}
              onChange={(v) => v !== null && setAgents({ maxDepth: v })}
            />
          </div>
        )}
        <Toggle
          label="Skills"
          hint="From ~/.agent86/skills and ~/.claude/skills, and the folders below."
          checked={draft.skills.enabled}
          onChange={(enabled) => onChange({ ...draft, skills: { ...draft.skills, enabled } })}
        />
        {draft.skills.enabled && (
          <LinesField
            label="More skill folders"
            hint="One per line; ~ is your home folder."
            value={draft.skills.paths.join("\n")}
            placeholder="~/work/skills"
            onChange={(text) => {
              onChange({ ...draft, skills: { ...draft.skills, paths: parseLines(text) } });
              return null;
            }}
          />
        )}
      </Section>
    </>
  );
}

function GuardrailsSection({ draft, onChange }: Props) {
  const g = draft.guardrails;
  const set = (patch: Partial<Settings["guardrails"]>) =>
    onChange({ ...draft, guardrails: { ...g, ...patch } });
  return (
    <Section
      title="Guardrails"
      intro="agent86's safety checks. The workspace jail and the secret vault are always on."
    >
      <Select
        label="Side-effecting tool calls"
        hint={
          g.approval === "auto"
            ? "Writes and commands run without asking. Only for workspaces you can afford to lose."
            : "Writes, commands, and other changes."
        }
        value={g.approval}
        options={[
          { value: "ask", label: "Ask me each time" },
          { value: "auto", label: "Run without asking" },
          { value: "deny", label: "Refuse them" },
        ]}
        onChange={(approval) => set({ approval })}
      />
      <Select
        label="Incoming text (prompt injection)"
        value={g.ingress}
        options={[
          { value: "warn", label: "Warn" },
          { value: "block", label: "Block turns that carry it" },
          { value: "off", label: "Off" },
        ]}
        onChange={(ingress) => set({ ingress })}
      />
      <Select
        label="Outgoing text (secrets, personal data)"
        value={g.egress}
        options={[
          { value: "warn", label: "Warn" },
          { value: "redact", label: "Redact" },
          { value: "off", label: "Off" },
        ]}
        onChange={(egress) => set({ egress })}
      />
      <Toggle
        label="Scan tool results too"
        checked={g.scanObservations}
        onChange={(scanObservations) => set({ scanObservations })}
      />
    </Section>
  );
}

const NEW_SERVER: McpServerSettings = {
  enabled: true,
  transport: "stdio",
  command: "",
  args: [],
  env: {},
  url: "",
  headers: {},
  connectTimeoutS: 30,
  callTimeoutS: 120,
  maxResultChars: 8000,
};

function McpSection({ draft, onChange }: Props) {
  const [name, setName] = useState("");
  const servers = draft.mcpServers;
  const setServer = (n: string, server: McpServerSettings | null) => {
    const next = { ...servers };
    if (server) next[n] = server;
    else delete next[n];
    onChange({ ...draft, mcpServers: next });
  };
  const nameOk = validServerName(name.trim()) && !(name.trim() in servers);
  return (
    <Section
      title="MCP servers"
      intro={
        <>
          Tools from Model Context Protocol servers, started with each thread. Write{" "}
          <span className="font-mono">{"${NAME}"}</span> for a token: it is read from the
          environment variable NAME, or else the keyring entry NAME.
        </>
      }
    >
      {Object.entries(servers).map(([n, s]) => (
        <McpServerCard
          key={n}
          name={n}
          server={s}
          onChange={(next) => setServer(n, next)}
          onRemove={() => setServer(n, null)}
        />
      ))}
      <div className="flex items-end gap-2 rounded-md border border-dashed border-border p-3">
        <div className="w-56">
          <TextField label="Add a server" value={name} placeholder="name" mono onChange={setName} />
        </div>
        <button
          type="button"
          className={buttonClass}
          disabled={!nameOk}
          onClick={() => {
            setServer(name.trim(), NEW_SERVER);
            setName("");
          }}
        >
          Add
        </button>
      </div>
    </Section>
  );
}

function McpServerCard({
  name,
  server,
  onChange,
  onRemove,
}: {
  name: string;
  server: McpServerSettings;
  onChange: (server: McpServerSettings) => void;
  onRemove: () => void;
}) {
  const set = (patch: Partial<McpServerSettings>) => onChange({ ...server, ...patch });
  const remote = server.transport !== "stdio";
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-panel p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-semibold">{name}</span>
        <span className="flex-1" />
        <Toggle label="On" checked={server.enabled} onChange={(enabled) => set({ enabled })} />
        <button type="button" className="text-xs text-muted hover:text-error" onClick={onRemove}>
          Remove
        </button>
      </div>
      <Select<McpTransport>
        label="Transport"
        value={server.transport}
        options={[
          { value: "stdio", label: "A program (stdio)" },
          { value: "http", label: "HTTP" },
          { value: "sse", label: "SSE (older servers)" },
        ]}
        onChange={(transport) => set({ transport })}
      />
      {remote ? (
        <>
          <TextField label="URL" value={server.url} mono onChange={(url) => set({ url })} />
          <LinesField
            label="Headers"
            hint="One per line, Name: value."
            value={formatPairs(server.headers, ":")}
            placeholder="Authorization: Bearer ${MY_TOKEN}"
            onChange={(text) => {
              const parsed = parsePairs(text, ":");
              if ("error" in parsed) return parsed.error;
              set({ headers: parsed.pairs });
              return null;
            }}
          />
        </>
      ) : (
        <>
          <TextField
            label="Command"
            value={server.command}
            mono
            placeholder="npx"
            onChange={(command) => set({ command })}
          />
          <LinesField
            label="Arguments"
            hint="One per line."
            value={server.args.join("\n")}
            onChange={(text) => {
              set({ args: parseLines(text) });
              return null;
            }}
          />
          <LinesField
            label="Environment"
            hint="One per line, NAME=value. The server gets agent86's scrubbed environment plus these."
            value={formatPairs(server.env)}
            onChange={(text) => {
              const parsed = parsePairs(text);
              if ("error" in parsed) return parsed.error;
              set({ env: parsed.pairs });
              return null;
            }}
          />
        </>
      )}
    </div>
  );
}

function MemorySection({
  state,
  draft,
  onChange,
}: Props & { state: SettingsState & { settings: Settings } }) {
  const memory = draft.memory;
  const set = (patch: Partial<Settings["memory"]>) =>
    onChange({ ...draft, memory: { ...memory, ...patch } });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <Section
        title="Memory"
        intro="Sessions and long-term memory, in the database the agent86 CLI uses, so a session started in one opens in the other."
      >
        {state.memoryOpen && (
          <p className="text-xs text-warn">
            The database is open: changes here apply after a restart.
          </p>
        )}
        <Toggle
          label="Save sessions and memory"
          checked={memory.enabled}
          onChange={(enabled) => set({ enabled })}
        />
        <TextField label="Database" value={memory.path} mono onChange={(path) => set({ path })} />
        <TextField
          label="Embedder"
          hint="Must match the CLI's ([memory] embeddings), or memory written by one is not found by the other."
          value={memory.embeddings}
          mono
          onChange={(embeddings) => set({ embeddings })}
        />
      </Section>
      <Section
        title="Import from the agent86 CLI"
        intro={
          state.cliConfig
            ? `Replace these settings with what ${state.cliConfig} says. You can review it before saving.`
            : "There is no agent86 CLI config (~/.agent86/config.toml) to import."
        }
      >
        {draft.importedFrom && (
          <p className="text-xs text-muted">
            These settings were imported from {draft.importedFrom}.
          </p>
        )}
        <div>
          <button
            type="button"
            className={buttonClass}
            disabled={!state.cliConfig}
            onClick={() => {
              setProblem(null);
              previewCliImport().then(setPreview, (e: unknown) => setProblem(String(e)));
            }}
          >
            Read the CLI config…
          </button>
        </div>
        <Problems text={problem} />
        {preview && (
          <ImportSummary
            preview={preview}
            action="Use these settings"
            onUse={() => {
              onChange(preview.settings);
              setPreview(null);
            }}
          />
        )}
      </Section>
    </>
  );
}

/** What an import would bring over, with its notes, and a button to take it. */
export function ImportSummary({
  preview,
  action,
  onUse,
  busy,
}: {
  preview: ImportPreview;
  action: string;
  onUse: () => void;
  busy?: boolean;
}) {
  const s = preview.settings;
  const servers = Object.entries(s.mcpServers);
  const prices = Object.keys(s.pricing).length;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-panel p-3 text-sm">
      <div>
        Default model <span className="font-mono">{s.model.default}</span>
        {s.model.triage && (
          <span className="text-muted">
            {" "}
            · triage <span className="font-mono">{s.model.triage.cheap}</span> /{" "}
            <span className="font-mono">{s.model.triage.frontier}</span>
          </span>
        )}
      </div>
      <div>
        Providers <span className="font-mono">{Object.keys(s.providers).join(", ") || "none"}</span>
      </div>
      {servers.length > 0 && (
        <div>
          MCP servers{" "}
          <span className="font-mono">
            {servers.map(([n, v]) => (v.enabled ? n : `${n} (off)`)).join(", ")}
          </span>
        </div>
      )}
      <div className="text-muted">
        Limits: {s.limits.maxSteps} steps, ${s.limits.maxCostUsd} per turn · approvals{" "}
        {s.guardrails.approval}
        {prices > 0 && ` · ${prices} model prices`}
      </div>
      {preview.notes.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-warn">
          {preview.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">
        API keys stay where they are: the keyring entries the CLI uses are used here too.
      </p>
      <div>
        <button type="button" className={primaryClass} disabled={busy} onClick={onUse}>
          {action}
        </button>
      </div>
    </div>
  );
}

/** The projects whose skills, specialists, and MCP servers the user trusted. */
function ProjectsSection() {
  const [list, setList] = useState<TrustedProject[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    trustedProjects().then(setList, (e: unknown) => setProblem(String(e)));
  }, []);
  return (
    <Section
      title="Trusted projects"
      intro="A project's own skills, specialists, and MCP servers load only once you trust them, and again after any change to them. Stopping trust takes effect for threads opened or reloaded afterwards."
    >
      {list && list.length === 0 && <p className="text-sm text-muted">No trusted projects.</p>}
      {list && list.length > 0 && (
        <ul className="space-y-1">
          {list.map((p) => (
            <li
              key={p.workspace}
              className="flex items-center gap-2 rounded border border-border bg-panel px-3 py-1.5 text-sm"
            >
              <span className="min-w-0 flex-1 truncate font-mono" title={p.sha256}>
                {p.workspace}
              </span>
              <button
                type="button"
                className={buttonClass}
                onClick={() =>
                  forgetTrust(p.workspace).then(
                    () => setList((l) => (l ?? []).filter((x) => x.workspace !== p.workspace)),
                    (e: unknown) => setProblem(String(e)),
                  )
                }
              >
                Stop trusting
              </button>
            </li>
          ))}
        </ul>
      )}
      <Problems text={problem} />
    </Section>
  );
}

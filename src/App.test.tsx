import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { App } from "./App.tsx";
import type { ProviderSettings, Settings } from "./desktop-client/events.ts";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  clearMocks();
});

const info = {
  appVersion: "0.1.0",
  coreVersion: "1.1.0",
  os: "windows",
  arch: "x86_64",
  memoryOk: true,
};
const model = {
  reference: "vllm:qwen",
  contextWindow: 32768,
  triage: false,
  problem: null,
};
const capabilities = {
  skills: ["code-reviewer"],
  specialists: ["explorer"],
  tools: ["read_file", "write_file"],
};
const sessions = {
  database: "/home/u/.agent86/memory.db",
  problem: null,
  note: null,
  sessions: [
    {
      id: "s-old",
      title: "Fix the parser",
      updatedAt: 1_700_000_000,
      workspace: "C:\\code\\parser",
    },
    { id: "s-nofolder", title: "From the terminal", updatedAt: 1_700_000_000, workspace: null },
  ],
};

function opened(threadId: string, workspace: string, sessionId: string, history: unknown[] = []) {
  return {
    threadId,
    workspace,
    model: "vllm:qwen",
    contextWindow: 32768,
    capabilities,
    sessionId,
    history,
    memoryNote: null,
  };
}

type Call = { cmd: string; args: Record<string, unknown> };

const vllm: ProviderSettings = {
  kind: "vllm",
  baseUrl: "http://localhost:8000/v1",
  key: "optional",
  apiKeyEnv: "VLLM_API_KEY",
  maxTokens: null,
  numCtx: null,
  connectTimeoutS: 10,
  readTimeoutS: 300,
  maxRetries: 2,
  promptCache: true,
  store: false,
  routing: null,
};

/** Rust's `Settings::default()`: no model yet. */
function defaults(): Settings {
  return {
    version: 1,
    model: { default: "", triage: null, contextWindows: {} },
    providers: {},
    limits: {
      maxSteps: 40,
      maxCostUsd: 5,
      maxWallClockS: 900,
      toolTimeoutS: 60,
      maxOutputTokens: 8192,
    },
    guardrails: { approval: "ask", ingress: "warn", egress: "warn", scanObservations: true },
    mcpServers: {},
    agents: { enabled: true, maxDepth: 2, maxSteps: 8, maxParallel: 3 },
    skills: { enabled: true, paths: [] },
    memory: {
      enabled: true,
      path: "~/.agent86/memory.db",
      embeddings: "sentence-transformers:all-MiniLM-L6-v2",
      hfOffline: true,
      retentionMaxEpisodes: 1000,
      retentionMaxSessions: 500,
      retentionMaxAgeDays: 0,
    },
    tools: { mentionMaxBytes: 200000 },
    pricing: {},
    importedFrom: null,
  };
}

function configured(): Settings {
  const s = defaults();
  return { ...s, providers: { vllm }, model: { ...s.model, default: "vllm:qwen" } };
}

const presets = [
  {
    name: "openrouter",
    label: "OpenRouter",
    provider: {
      ...vllm,
      kind: "openai",
      key: "required",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
    },
    exampleModel: "anthropic/claude",
  },
  { name: "vllm", label: "vLLM", provider: vllm, exampleModel: "Qwen/Qwen3-32B" },
];

const CLI_CONFIG = "C:\\Users\\u\\.agent86\\config.toml";

function settingsState(settings: Settings | null, cliConfig: string | null = null) {
  return {
    settings,
    problem: null,
    path: "C:\\Users\\u\\AppData\\Roaming\\agent86\\settings.json",
    cliConfig,
    presets,
    defaults: defaults(),
    memoryOpen: false,
  };
}

function backend(extra: (cmd: string, args: Record<string, unknown>) => unknown = () => undefined) {
  const calls: Call[] = [];
  let threads = 0;
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args: a });
    const given = extra(cmd, a);
    if (given !== undefined) return given;
    switch (cmd) {
      case "app_info":
        return info;
      case "model_info":
        return model;
      case "get_settings":
        return settingsState(configured());
      case "list_sessions":
        return sessions;
      case "pick_workspace":
        return "C:\\code\\demo";
      case "open_thread":
        threads += 1;
        return opened(
          `t${threads}`,
          a.workspace as string,
          (a.sessionId as string | null) ?? `new${threads}`,
        );
      case "prompt":
      case "close_thread":
        return null;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
  return calls;
}

test("shows the model, the core version, and the saved sessions", async () => {
  backend();
  render(<App />);
  expect(await screen.findByText("vllm:qwen")).toBeTruthy();
  expect(await screen.findByText(/agent86-core v1\.1\.0/)).toBeTruthy();
  const list = await screen.findByRole("navigation", { name: "Sessions" });
  expect(await within(list).findByText("Fix the parser")).toBeTruthy();
  expect(within(list).getByText("parser")).toBeTruthy();
  expect(within(list).getByText("folder unknown")).toBeTruthy();
});

test("explains a model that cannot start and disables new threads", async () => {
  backend((cmd) => (cmd === "model_info" ? { ...model, problem: "No API key found." } : undefined));
  render(<App />);
  expect(await screen.findByText("No API key found.")).toBeTruthy();
  const choose = screen.getByRole("button", { name: /Choose a workspace/ }) as HTMLButtonElement;
  expect(choose.disabled).toBe(true);
});

test("opens a new thread in a tab and sends a prompt", async () => {
  const calls = backend();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Choose a workspace/ }));
  expect(await screen.findByRole("tab", { name: /demo/ })).toBeTruthy();
  const box = await screen.findByLabelText("Prompt");
  fireEvent.change(box, { target: { value: "what is here?" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(await screen.findByText("what is here?")).toBeTruthy();
  expect(calls.find((c) => c.cmd === "open_thread")?.args).toMatchObject({
    workspace: "C:\\code\\demo",
    sessionId: null,
  });
  expect(calls.find((c) => c.cmd === "prompt")?.args).toMatchObject({
    threadId: "t1",
    turn: { kind: "goal", text: "what is here?", mentions: [] },
  });
});

test("reopens a saved session in its folder, with its conversation, once", async () => {
  const calls = backend((cmd, args) =>
    cmd === "open_thread" && args.sessionId === "s-old"
      ? opened("t1", "C:\\code\\parser", "s-old", [
          { kind: "user", text: "fix the parser" },
          { kind: "tool", id: "c1", name: "read_file", arguments: {}, output: "x", ok: true },
          { kind: "agent", text: "Fixed it." },
        ])
      : undefined,
  );
  render(<App />);
  const list = await screen.findByRole("navigation", { name: "Sessions" });
  fireEvent.click(await within(list).findByText("Fix the parser"));
  expect(await screen.findByText("Fixed it.")).toBeTruthy();
  expect(screen.getByText("fix the parser")).toBeTruthy();
  expect(screen.getByRole("tab", { name: /Fix the parser/ })).toBeTruthy();
  expect(calls.find((c) => c.cmd === "open_thread")?.args).toMatchObject({
    workspace: "C:\\code\\parser",
    sessionId: "s-old",
  });
  // Clicking it again shows the open tab instead of opening a second one.
  fireEvent.click(within(list).getByText("Fix the parser"));
  expect(calls.filter((c) => c.cmd === "open_thread")).toHaveLength(1);
});

test("asks for the folder of a session the app does not know", async () => {
  const calls = backend();
  render(<App />);
  const list = await screen.findByRole("navigation", { name: "Sessions" });
  fireEvent.click(await within(list).findByText("From the terminal"));
  expect(await screen.findByRole("tab", { name: /From the terminal/ })).toBeTruthy();
  expect(calls.map((c) => c.cmd)).toContain("pick_workspace");
  expect(calls.find((c) => c.cmd === "open_thread")?.args).toMatchObject({
    workspace: "C:\\code\\demo",
    sessionId: "s-nofolder",
  });
});

test("closes a tab and its thread", async () => {
  const calls = backend();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Choose a workspace/ }));
  await screen.findByLabelText("Prompt");
  fireEvent.click(await screen.findByRole("button", { name: /Close demo/ }));
  expect(screen.queryByRole("tab")).toBeNull();
  expect(calls.find((c) => c.cmd === "close_thread")?.args).toMatchObject({ threadId: "t1" });
});

test("shows /tools as a list without starting a turn", async () => {
  const calls = backend();
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Choose a workspace/ }));
  const box = await screen.findByLabelText("Prompt");
  fireEvent.change(box, { target: { value: "/tools" } });
  fireEvent.keyDown(box, { key: "Escape" });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(await screen.findByText("/tools (2)")).toBeTruthy();
  expect(calls.map((c) => c.cmd)).not.toContain("prompt");
});

test("says so when the core cannot be reached", async () => {
  mockIPC(() => {
    throw new Error("boom");
  });
  render(<App />);
  expect(await screen.findByText(/Could not reach the app core/)).toBeTruthy();
});

test("first run: sets up a provider, stores its key, and saves the settings", async () => {
  let saved: Settings | null = null;
  const calls = backend((cmd, args) => {
    if (cmd === "get_settings") return settingsState(saved);
    if (cmd === "set_key") return null;
    if (cmd === "save_settings") {
      saved = args.settings as Settings;
      return saved;
    }
    return undefined;
  });
  render(<App />);
  expect(await screen.findByText("Welcome to Agent 86")).toBeTruthy();
  expect(screen.queryByText(/Use your agent86 CLI settings/)).toBeNull();
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "anthropic/claude-x" } });
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-or-abcdef" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
  expect(await screen.findByRole("button", { name: /Choose a workspace/ })).toBeTruthy();
  expect(calls.find((c) => c.cmd === "set_key")?.args).toEqual({
    provider: "openrouter",
    key: "sk-or-abcdef",
  });
  const settings = calls.find((c) => c.cmd === "save_settings")?.args.settings as Settings;
  expect(settings.model.default).toBe("openrouter:anthropic/claude-x");
  expect(settings.providers.openrouter?.baseUrl).toBe("https://openrouter.ai/api/v1");
  expect(settings.limits.maxSteps).toBe(40);
  // The key went to the keyring, never into the settings.
  expect(JSON.stringify(settings)).not.toContain("sk-or-abcdef");
});

test("first run: imports the CLI config after showing what it holds", async () => {
  let saved: Settings | null = null;
  const imported = { ...configured(), importedFrom: CLI_CONFIG };
  const calls = backend((cmd, args) => {
    if (cmd === "get_settings") return settingsState(saved, CLI_CONFIG);
    if (cmd === "preview_cli_import")
      return { path: CLI_CONFIG, settings: imported, notes: ["Not imported: [sandbox]."] };
    if (cmd === "save_settings") {
      saved = args.settings as Settings;
      return saved;
    }
    return undefined;
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Review what would be imported" }));
  expect(await screen.findByText("Not imported: [sandbox].")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Import and continue" }));
  expect(await screen.findByRole("button", { name: /Choose a workspace/ })).toBeTruthy();
  expect(calls.find((c) => c.cmd === "save_settings")?.args.settings).toEqual(imported);
});

test("settings: edits a limit and saves; stores a key at once", async () => {
  const calls = backend((cmd, args) => {
    if (cmd === "save_settings") return args.settings;
    if (cmd === "key_statuses")
      return [{ provider: "vllm", state: "notSet", env: "VLLM_API_KEY", inKeyring: false }];
    if (cmd === "set_key") return null;
    return undefined;
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Settings/ }));
  expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Limits" }));
  fireEvent.change(screen.getByLabelText("Steps per turn"), { target: { value: "75" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText(/Saved\. New threads use these settings\./)).toBeTruthy();
  const settings = calls.find((c) => c.cmd === "save_settings")?.args.settings as Settings;
  expect(settings.limits.maxSteps).toBe(75);

  fireEvent.click(screen.getByRole("button", { name: "Providers" }));
  expect(await screen.findByText(/No key \(none needed/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("API key for vllm"), { target: { value: "tok-123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Store key" }));
  await waitFor(() =>
    expect(calls.find((c) => c.cmd === "set_key")?.args).toEqual({
      provider: "vllm",
      key: "tok-123456",
    }),
  );
  await waitFor(() =>
    expect(calls.filter((c) => c.cmd === "key_statuses").length).toBeGreaterThan(1),
  );
});

test("settings: a save the core refuses shows its problems and keeps the draft", async () => {
  backend((cmd) => {
    if (cmd === "save_settings") throw new Error("Choose the default model.");
    if (cmd === "key_statuses") return [];
    return undefined;
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Settings/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Guardrails" }));
  fireEvent.change(screen.getByLabelText("Side-effecting tool calls"), {
    target: { value: "deny" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText(/Choose the default model\./)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Discard changes" })).toBeTruthy();
});

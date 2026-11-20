import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { App } from "./App.tsx";

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
  source: "/home/u/.agent86/config.toml",
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

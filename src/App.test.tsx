import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { App } from "./App.tsx";

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

test("shows the model and the core version, and offers a workspace", async () => {
  mockIPC((cmd) => {
    if (cmd === "app_info") return info;
    if (cmd === "model_info") return model;
    throw new Error(`unexpected command ${cmd}`);
  });
  render(<App />);
  expect(await screen.findByText("vllm:qwen")).toBeTruthy();
  expect(await screen.findByText(/agent86-core v1\.1\.0/)).toBeTruthy();
  const choose = screen.getByRole("button", { name: /Choose a workspace/ }) as HTMLButtonElement;
  expect(choose.disabled).toBe(false);
});

test("explains a model that cannot start and disables the button", async () => {
  mockIPC((cmd) => {
    if (cmd === "app_info") return info;
    if (cmd === "model_info") return { ...model, problem: "No API key found." };
    throw new Error(`unexpected command ${cmd}`);
  });
  render(<App />);
  expect(await screen.findByText("No API key found.")).toBeTruthy();
  const choose = screen.getByRole("button", { name: /Choose a workspace/ }) as HTMLButtonElement;
  expect(choose.disabled).toBe(true);
});

test("opens a thread in the picked folder and sends a prompt", async () => {
  const calls: { cmd: string; args: unknown }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "app_info") return info;
    if (cmd === "model_info") return model;
    if (cmd === "pick_workspace") return "C:\\code\\demo";
    if (cmd === "open_thread")
      return { threadId: "t1", workspace: "C:\\code\\demo", model: "vllm:qwen" };
    if (cmd === "prompt") return null;
    throw new Error(`unexpected command ${cmd}`);
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /Choose a workspace/ }));
  expect(await screen.findByText("C:\\code\\demo")).toBeTruthy();

  const box = screen.getByLabelText("Prompt");
  fireEvent.change(box, { target: { value: "what is here?" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(await screen.findByText("what is here?")).toBeTruthy();
  expect(calls.find((c) => c.cmd === "prompt")?.args).toMatchObject({
    threadId: "t1",
    text: "what is here?",
  });
  // The turn is running: Stop replaces Send.
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
});

test("says so when the core cannot be reached", async () => {
  mockIPC(() => {
    throw new Error("boom");
  });
  render(<App />);
  expect(await screen.findByText(/Could not reach the app core/)).toBeTruthy();
});

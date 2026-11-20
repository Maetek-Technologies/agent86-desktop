import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { App } from "./App.tsx";

afterEach(() => {
  cleanup();
  clearMocks();
});

test("shows what app_info reports", async () => {
  mockIPC((cmd) => {
    if (cmd === "app_info") {
      return {
        appVersion: "0.1.0",
        coreVersion: "1.1.0",
        os: "windows",
        arch: "x86_64",
        memoryOk: true,
      };
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  render(<App />);
  expect(await screen.findByText("v1.1.0")).toBeTruthy();
  expect(screen.getByText("ok")).toBeTruthy();
});

test("says so when the core cannot be reached", async () => {
  mockIPC(() => {
    throw new Error("boom");
  });
  render(<App />);
  expect(await screen.findByText(/Could not reach the app core/)).toBeTruthy();
});

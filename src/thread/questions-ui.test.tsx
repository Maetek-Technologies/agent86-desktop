import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalInfo, LimitInfo } from "../desktop-client/events.ts";
import { SecretPrompt } from "../secrets/SecretPrompt.tsx";
import { PermissionPanel } from "../tools/PermissionPanel.tsx";
import { LimitPanel } from "./LimitPanel.tsx";

afterEach(cleanup);

const base: ApprovalInfo = {
  summary: "{}",
  detail: null,
  lexer: null,
  warning: null,
  full: false,
  change: null,
  asker: null,
};

describe("PermissionPanel", () => {
  it("shows a write as a diff and the call in one line", () => {
    const { container } = render(
      <PermissionPanel
        tool="write_file"
        preview={{
          ...base,
          summary: '{"path": "notes.txt", "content": "new"}',
          change: { path: "/w/notes.txt", oldText: "old\n", newText: "new\n", line: 1 },
        }}
        onAnswer={() => {}}
      />,
    );
    // In the one-line summary and in the diff's header.
    expect(screen.getAllByText("notes.txt", { exact: false })).toHaveLength(2);
    const rows = container.querySelectorAll("[data-kind]");
    expect([...rows].map((r) => r.getAttribute("data-kind"))).toContain("add");
    expect([...rows].map((r) => r.getAttribute("data-kind"))).toContain("del");
  });

  it("shows a command as code", () => {
    render(
      <PermissionPanel
        tool="run_command"
        preview={{ ...base, summary: '{"command": "ls -la"}', detail: "ls -la", lexer: "bash" }}
        onAnswer={() => {}}
      />,
    );
    expect(screen.getByText("command")).toBeTruthy();
  });

  it("answers with number keys and rejects on Esc", () => {
    const onAnswer = vi.fn();
    render(<PermissionPanel tool="write_file" preview={base} onAnswer={onAnswer} />);
    const panel = screen.getByRole("group", { name: /Approval needed/ });
    fireEvent.keyDown(panel, { key: "2" });
    fireEvent.keyDown(panel, { key: "Escape" });
    fireEvent.keyDown(panel, { key: "Enter" });
    expect(onAnswer.mock.calls).toEqual([["allowAlways"], ["reject"]]);
  });

  it("names the tool in the allow-always option and shows a warning", () => {
    render(
      <PermissionPanel
        tool="edit_file"
        preview={{ ...base, warning: "This edits agent86's own config." }}
        onAnswer={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Always allow edit_file in this thread/ }),
    ).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("own config");
  });
});

describe("LimitPanel", () => {
  const limit: LimitInfo = {
    kind: "steps",
    headline: "Step budget reached (40 steps)",
    agent: null,
    current: 40,
    offers: [80, 160],
    runOnly: false,
  };

  it("offers agent86's raises and a stop", () => {
    const onAnswer = vi.fn();
    render(<LimitPanel limit={limit} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: /Raise to 160 steps/ }));
    fireEvent.click(screen.getByRole("button", { name: "Stop here" }));
    fireEvent.keyDown(screen.getByRole("group"), { key: "1" });
    expect(onAnswer.mock.calls).toEqual([[160], [null], [80]]);
  });
});

describe("SecretPrompt", () => {
  it("sends the value once and clears it from the page", () => {
    const onEnter = vi.fn();
    const { container } = render(
      <SecretPrompt
        name="API_TOKEN"
        reason="to call the API"
        replacing={false}
        onEnter={onEnter}
        onDecline={() => {}}
      />,
    );
    const input = screen.getByLabelText("Value for API_TOKEN") as HTMLInputElement;
    expect(input.type).toBe("password");
    fireEvent.change(input, { target: { value: "hunter2-secret" } });
    fireEvent.submit(screen.getByRole("dialog"));
    expect(onEnter).toHaveBeenCalledWith("hunter2-secret");
    expect(input.value).toBe("");
    expect(container.innerHTML).not.toContain("hunter2-secret");
  });

  it("refuses a value agent86 would refuse, and declines on Esc", () => {
    const onEnter = vi.fn();
    const onDecline = vi.fn();
    render(<SecretPrompt name="PIN" reason="" replacing onEnter={onEnter} onDecline={onDecline} />);
    const input = screen.getByLabelText("Value for PIN");
    fireEvent.change(input, { target: { value: "123" } });
    fireEvent.submit(screen.getByRole("dialog"));
    expect(onEnter).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("at least 6");
    expect(screen.getByRole("note").textContent).toContain("replaces it");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onDecline).toHaveBeenCalled();
  });
});

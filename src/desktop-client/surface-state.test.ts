import { describe, expect, it } from "vitest";
import type { DesktopEvent } from "./events.ts";
import { initialState, reduce, type LocalAction, type SessionState } from "./session-state.ts";

function fold(...actions: (DesktopEvent | LocalAction)[]): SessionState {
  return actions.reduce(reduce, initialState());
}

const create = (surfaceId: string): DesktopEvent => ({
  type: "ui",
  toolCallId: "c1",
  message: { version: "1.0", createSurface: { surfaceId, catalogId: "basic", components: [] } },
});
const update: DesktopEvent = {
  type: "ui",
  toolCallId: "c2",
  message: { version: "1.0", updateDataModel: { surfaceId: "form", path: "/name", value: "Ada" } },
};
const remove: DesktopEvent = {
  type: "ui",
  toolCallId: "c3",
  message: { version: "1.0", deleteSurface: { surfaceId: "form" } },
};
const action = {
  name: "submit",
  surfaceId: "form",
  sourceComponentId: "ok",
  timestamp: "2026-11-22T10:00:00Z",
  context: {},
};

describe("agent86UI surfaces in the session state", () => {
  it("places a surface at the call that created it and redraws it in place", () => {
    const state = fold(create("form"), { type: "agentText", text: "Here." }, update);
    expect(state.entries.map((e) => e.kind)).toEqual(["surface", "agent"]);
    expect(state.entries[0]).toMatchObject({ surfaceId: "form", toolCallId: "c1", deleted: false });
    expect(state.uiLog).toHaveLength(2);
  });

  it("marks a deleted surface, and a new one with the same id gets a new place", () => {
    const state = fold(create("form"), remove, create("form"));
    expect(state.entries).toMatchObject([
      { kind: "surface", surfaceId: "form", deleted: true },
      { kind: "surface", surfaceId: "form", deleted: false },
    ]);
  });

  it("logs the user's input as updateDataModel messages", () => {
    const state = fold(create("form"), {
      type: "local/uiInput",
      surfaceId: "form",
      path: "/name",
      value: "Ada",
    });
    expect(state.uiLog.at(-1)).toEqual({
      version: "1.0",
      updateDataModel: { surfaceId: "form", path: "/name", value: "Ada" },
    });
  });

  it("holds a press until its turn starts or is dropped", () => {
    const held = fold({ type: "local/uiHeld", surfaceId: "form" });
    expect(held.uiHeld).toEqual(["form"]);
    expect(reduce(held, { type: "uiActionStarted", action }).uiHeld).toEqual([]);
    expect(reduce(held, { type: "uiActionDropped", action }).uiHeld).toEqual([]);
  });

  it("places a reopened session's surfaces after the call that last drew them", () => {
    const drew = (id: string, surfaceId: string, asString = false) => {
      const messages = [{ version: "1.0", updateComponents: { surfaceId, components: [] } }];
      return {
        kind: "tool" as const,
        id,
        name: "render_ui",
        arguments: { messages: asString ? JSON.stringify(messages) : messages },
        output: null,
        ok: true,
      };
    };
    const state = fold(
      {
        type: "local/history",
        items: [
          { kind: "user", text: "ask me" },
          drew("c1", "form"),
          { kind: "agent", text: "Here." },
          drew("c2", "form", true),
          { kind: "agent", text: "Updated." },
        ],
      },
      {
        type: "local/surfaces",
        messages: [
          { version: "1.0", createSurface: { surfaceId: "form" } },
          { version: "1.0", createSurface: { surfaceId: "lost" } },
        ],
      },
    );
    expect(
      state.entries.map((e) => (e.kind === "surface" ? `surface ${e.surfaceId}` : e.kind)),
    ).toEqual(["user", "tool", "agent", "tool", "surface form", "agent", "surface lost"]);
    expect(state.entries[4]).toMatchObject({ toolCallId: "c2" });
    expect(state.uiLog).toHaveLength(2);
  });

  it("keeps one log entry for repeated input to the same field", () => {
    const type = (value: string): LocalAction => ({
      type: "local/uiInput",
      surfaceId: "form",
      path: "/name",
      value,
    });
    const state = fold(create("form"), type("A"), type("Ad"), type("Ada"));
    expect(state.uiLog).toHaveLength(2);
    expect(state.uiLog[1]).toMatchObject({ updateDataModel: { value: "Ada" } });
  });
});

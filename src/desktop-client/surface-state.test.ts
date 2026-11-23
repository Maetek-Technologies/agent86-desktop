import { describe, expect, it } from "vitest";
import type { DesktopEvent } from "./events.ts";
import { TRIP_FORM } from "./ask.fixture.ts";
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

  it("locks a surface the user sent from until the agent changes it or the user unlocks it", () => {
    const sent = fold(create("form"), { type: "local/uiSent", surfaceId: "form" });
    expect(sent.uiSent).toEqual(["form"]);
    expect(reduce(sent, update).uiSent).toEqual([]);
    expect(reduce(sent, { type: "local/uiUnlock", surfaceId: "form" }).uiSent).toEqual([]);
    expect(reduce(sent, { type: "uiActionDropped", action }).uiSent).toEqual([]);
    // Another surface's change leaves it locked.
    expect(reduce(sent, create("other")).uiSent).toEqual(["form"]);
  });
});

// `ask_user` (agent86-core 1.2.2): agent86 builds the form for the model's questions, draws it as
// surface `agent86_ask_<n>`, waits on its Send, and takes it down once answered or dismissed.
describe("ask_user forms in the session state", () => {
  const ask = (id: string): DesktopEvent => ({
    type: "toolCall",
    id,
    name: "ask_user",
    title: "ask_user(...)",
    arguments: { title: "Your weekend trip", questions: [] },
  });
  const listDir: DesktopEvent = {
    type: "toolCall",
    id: "c2",
    name: "list_dir",
    title: "list_dir(.)",
    arguments: { path: "." },
  };
  const drawn = (toolCallId: string, surfaceId = "agent86_ask_1"): DesktopEvent => ({
    type: "ui",
    toolCallId,
    message: { ...TRIP_FORM, createSurface: { ...(TRIP_FORM.createSurface as object), surfaceId } },
  });
  const wait: DesktopEvent = { type: "uiWaitRequest", qid: 1, surfaceIds: ["agent86_ask_1"] };
  const typed: LocalAction = {
    type: "local/uiInput",
    surfaceId: "agent86_ask_1",
    path: "/answers/from",
    value: "Boston",
  };
  const takenDown = (toolCallId: string): DesktopEvent => ({
    type: "ui",
    toolCallId,
    message: { version: "1.0", deleteSurface: { surfaceId: "agent86_ask_1" } },
  });
  const result = (id: string, ok: boolean, output: string): DesktopEvent => ({
    type: "toolResult",
    id,
    name: "ask_user",
    ok,
    output,
    truncated: false,
    error: ok ? null : output,
    summary: "",
  });
  const ANSWERED = 'The user answered:\n{"from": "Boston", "style": "Outdoors", "nights": null}';
  const DISMISSED = "The user closed the form without answering. Do not ask these questions again.";
  const kinds = (state: SessionState) =>
    state.entries.map((e) =>
      e.kind === "surface" ? `surface ${e.surfaceId}` : e.kind === "tool" ? e.toolCallId : e.kind,
    );

  it("places the form at its call, though the call names no surface and later calls came first", () => {
    // agent86 announces the step's batch (ask_user, then list_dir) before drawing the form.
    const state = fold(ask("c1"), listDir, drawn("c1"), wait);
    expect(kinds(state)).toEqual(["c1", "surface agent86_ask_1", "c2"]);
    expect(state.entries[1]).toMatchObject({ toolCallId: "c1", deleted: false });
    expect(state.questions).toEqual([{ kind: "ui", qid: 1, surfaceIds: ["agent86_ask_1"] }]);
  });

  it("keeps the answered form, with what was entered, under an id of its own", () => {
    const state = fold(
      ask("c1"),
      drawn("c1"),
      wait,
      typed,
      { type: "local/uiSent", surfaceId: "agent86_ask_1" },
      { type: "questionClosed", qid: 1, answered: true },
      takenDown("c1"),
      result("c1", true, ANSWERED),
    );
    const kept = state.entries[1];
    expect(kept).toMatchObject({
      kind: "surface",
      surfaceId: "agent86_ask_1~2",
      toolCallId: "c1",
      deleted: false,
      kept: true,
      outcome: "answered",
    });
    // The log draws it under the new id, as it was when sent; nothing names the old one.
    expect(state.uiLog).toHaveLength(2);
    expect(state.uiLog[0]).toMatchObject({ createSurface: { surfaceId: "agent86_ask_1~2" } });
    expect(state.uiLog[1]).toEqual({
      version: "1.0",
      updateDataModel: { surfaceId: "agent86_ask_1~2", path: "/answers/from", value: "Boston" },
    });
    expect(state.uiSent).toEqual([]);
    expect(state.entries.find((e) => e.kind === "tool")).toMatchObject({ status: "completed" });
  });

  it("gives a later form agent86 numbers the same a place of its own", () => {
    // A reload rebuilds the agent, which numbers its forms from 1 again.
    const state = fold(
      ask("c1"),
      drawn("c1"),
      takenDown("c1"),
      result("c1", true, ANSWERED),
      ask("c9"),
      drawn("c9"),
    );
    expect(kinds(state)).toEqual(["c1", "surface agent86_ask_1~2", "c9", "surface agent86_ask_1"]);
    expect(state.entries[3]).toMatchObject({ toolCallId: "c9" });
    expect(state.entries[3]).not.toHaveProperty("kept");
  });

  it("keeps a dismissed form too, and says how each form's questions ended", () => {
    const dismissed = fold(
      ask("c1"),
      drawn("c1"),
      wait,
      { type: "questionClosed", qid: 1, answered: true },
      takenDown("c1"),
      result("c1", true, DISMISSED),
    );
    expect(dismissed.entries[1]).toMatchObject({ kept: true, outcome: "dismissed" });
    const stopped = fold(
      ask("c1"),
      drawn("c1"),
      wait,
      { type: "questionClosed", qid: 1, answered: false },
      takenDown("c1"),
      result("c1", false, "The turn was cancelled before the user answered."),
    );
    expect(stopped.entries[1]).toMatchObject({ kept: true, outcome: "unanswered" });
  });

  it("leaves a surface the model deleted with render_ui marked as deleted, as before", () => {
    const state = fold(create("form"), remove);
    expect(state.entries[0]).toMatchObject({ deleted: true });
    expect(state.entries[0]).not.toHaveProperty("kept");
  });
});

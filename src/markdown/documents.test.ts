import { describe, expect, it } from "vitest";
import { documentsReduce, NO_DOCUMENTS, type OpenDocument } from "./documents.ts";

const ready = (id: number, title = `doc ${id}`): OpenDocument => ({
  id,
  title,
  path: `/ws/${title}`,
  status: "ready",
  text: `# ${title}`,
});

describe("documentsReduce", () => {
  it("opens a new stack, pushes links on it, and goes back", () => {
    let state = documentsReduce(NO_DOCUMENTS, { type: "open", doc: ready(1) });
    state = documentsReduce(state, { type: "push", doc: ready(2) });
    state = documentsReduce(state, { type: "push", doc: ready(3) });
    expect(state.stack.map((d) => d.id)).toEqual([1, 2, 3]);
    state = documentsReduce(state, { type: "back" });
    expect(state.stack.map((d) => d.id)).toEqual([1, 2]);
    // Opening from outside the pane starts over.
    state = documentsReduce(state, { type: "open", doc: ready(4) });
    expect(state.stack.map((d) => d.id)).toEqual([4]);
    // The first document has nothing to go back to.
    expect(documentsReduce(state, { type: "back" })).toBe(state);
    expect(documentsReduce(state, { type: "close" })).toEqual(NO_DOCUMENTS);
  });

  it("settles only the load it started", () => {
    const loading: OpenDocument = { id: 1, title: "a.md", path: "a.md", status: "loading" };
    let state = documentsReduce(NO_DOCUMENTS, { type: "open", doc: loading });
    state = documentsReduce(state, { type: "settle", doc: ready(1, "a.md") });
    expect(state.stack).toEqual([ready(1, "a.md")]);
    // Settled already: a second answer changes nothing.
    expect(documentsReduce(state, { type: "settle", doc: ready(1, "b.md") })).toBe(state);
    // Another document was opened meanwhile, or the pane closed: the late answer is dropped.
    const other = documentsReduce(documentsReduce(NO_DOCUMENTS, { type: "open", doc: loading }), {
      type: "open",
      doc: ready(2),
    });
    expect(documentsReduce(other, { type: "settle", doc: ready(1) })).toBe(other);
    expect(documentsReduce(NO_DOCUMENTS, { type: "settle", doc: ready(1) })).toBe(NO_DOCUMENTS);
  });

  it("replaces a refreshed document where it is, whatever its status", () => {
    const again: OpenDocument = {
      id: 1,
      title: "doc 1",
      path: "/ws/doc 1",
      status: "ready",
      text: "# again",
    };
    let state = documentsReduce(NO_DOCUMENTS, { type: "open", doc: ready(1) });
    state = documentsReduce(state, { type: "push", doc: ready(2) });
    const failed: OpenDocument = {
      id: 1,
      title: "doc 1",
      path: "/ws/doc 1",
      status: "failed",
      problem: "gone",
    };
    state = documentsReduce(state, { type: "replace", doc: failed });
    expect(state.stack).toEqual([failed, ready(2)]);
    state = documentsReduce(state, { type: "replace", doc: again });
    expect(state.stack[0]).toEqual(again);
    // Gone back past it, or closed: nothing to replace.
    const back = documentsReduce(state, { type: "back" });
    expect(documentsReduce(back, { type: "replace", doc: ready(2) })).toBe(back);
    expect(documentsReduce(NO_DOCUMENTS, { type: "replace", doc: ready(1) })).toBe(NO_DOCUMENTS);
  });
});

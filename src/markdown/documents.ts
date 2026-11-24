// What the document pane shows (docs/PROJECT_PLAN.md §7a, step 4): a stack of documents, so a
// followed link can go back. Opening one from outside the pane (a tool card, a reply) starts a
// new stack; following a link inside it pushes.

/** A document as the pane shows it. `path` is absent for a reply shown as a document. */
export type OpenDocument = { id: number; title: string; path?: string } & (
  { status: "loading" } | { status: "ready"; text: string } | { status: "failed"; problem: string }
);

export interface DocumentsState {
  /** Oldest first; the last is shown. Empty: the pane is closed. */
  stack: OpenDocument[];
}

export const NO_DOCUMENTS: DocumentsState = { stack: [] };

export type DocumentsAction =
  /** Start a new stack with `doc`. */
  | { type: "open"; doc: OpenDocument }
  /** Show `doc` above the current one. */
  | { type: "push"; doc: OpenDocument }
  /** A loading document finished: replace it, wherever it is. */
  | { type: "settle"; doc: OpenDocument }
  | { type: "back" }
  | { type: "close" };

export function documentsReduce(state: DocumentsState, action: DocumentsAction): DocumentsState {
  switch (action.type) {
    case "open":
      return { stack: [action.doc] };
    case "push":
      return { stack: [...state.stack, action.doc] };
    case "settle": {
      const { doc } = action;
      // One opened since, or the pane closed: nothing to replace.
      if (!state.stack.some((d) => d.id === doc.id && d.status === "loading")) return state;
      return { stack: state.stack.map((d) => (d.id === doc.id ? doc : d)) };
    }
    case "back":
      return state.stack.length > 1 ? { stack: state.stack.slice(0, -1) } : state;
    case "close":
      return NO_DOCUMENTS;
  }
}

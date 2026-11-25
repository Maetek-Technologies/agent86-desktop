import { useCallback, useMemo, useReducer, useRef } from "react";
import { readTextFile } from "../desktop-client/backend.ts";
import type { TextFile } from "../desktop-client/events.ts";
import { documentsReduce, NO_DOCUMENTS, type OpenDocument } from "./documents.ts";

export interface Documents {
  /** The document shown; none when the pane is closed. */
  current: OpenDocument | undefined;
  canGoBack: boolean;
  /** Show text as a document (a reply), starting a new stack. */
  openDocument: (title: string, text: string) => void;
  /** Read a file of the thread's and show it, starting a new stack. */
  openFile: (path: string) => void;
  /**
   * Read the shown file again, in place (a document the agent is still writing). Resolves once
   * it is read, or failed; nothing to do for a reply or a file still loading.
   */
  refresh: () => Promise<void>;
  /** Show a file a link led to, above the current document. */
  push: (file: TextFile) => void;
  back: () => void;
  close: () => void;
}

/** The document pane's state for thread `threadId`. */
export function useDocuments(threadId: string): Documents {
  const [state, dispatch] = useReducer(documentsReduce, NO_DOCUMENTS);
  const next = useRef(0);

  const openDocument = useCallback((title: string, text: string) => {
    dispatch({ type: "open", doc: { id: ++next.current, title, status: "ready", text } });
  }, []);

  const openFile = useCallback(
    (path: string) => {
      const id = ++next.current;
      dispatch({ type: "open", doc: { id, title: path, path, status: "loading" } });
      readTextFile(threadId, path).then(
        (file) =>
          dispatch({
            type: "settle",
            doc: { id, title: file.path, path: file.path, status: "ready", text: file.text },
          }),
        (error: unknown) =>
          dispatch({
            type: "settle",
            doc: { id, title: path, path, status: "failed", problem: String(error) },
          }),
      );
    },
    [threadId],
  );

  const current = state.stack.at(-1);
  const refresh = useCallback(async () => {
    if (!current?.path || current.status === "loading") return;
    const { id, path, title } = current;
    try {
      const file = await readTextFile(threadId, path);
      dispatch({
        type: "replace",
        doc: { id, title: file.path, path: file.path, status: "ready", text: file.text },
      });
    } catch (error: unknown) {
      dispatch({
        type: "replace",
        doc: { id, title, path, status: "failed", problem: String(error) },
      });
    }
  }, [threadId, current]);

  const push = useCallback((file: TextFile) => {
    dispatch({
      type: "push",
      doc: {
        id: ++next.current,
        title: file.path,
        path: file.path,
        status: "ready",
        text: file.text,
      },
    });
  }, []);

  const back = useCallback(() => dispatch({ type: "back" }), []);
  const close = useCallback(() => dispatch({ type: "close" }), []);

  return useMemo(
    () => ({
      current,
      canGoBack: state.stack.length > 1,
      openDocument,
      openFile,
      refresh,
      push,
      back,
      close,
    }),
    [current, state.stack.length, openDocument, openFile, refresh, push, back, close],
  );
}

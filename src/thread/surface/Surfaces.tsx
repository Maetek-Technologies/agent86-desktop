// agent86UI in a thread: the runtime built from the session state's log, what a press does, and
// a surface drawn in its frame at its place in the transcript.

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { surfaceMediaUrl } from "../../desktop-client/backend.ts";
import type { Answer, UiAction } from "../../desktop-client/events.ts";
import type {
  LocalAction,
  Question,
  SessionState,
  SurfaceEntry,
  UiMessage,
} from "../../desktop-client/session-state.ts";
import { Runtime } from "./runtime/index.ts";
import type { Json, Node } from "./runtime/types.ts";
import { RemovedSurface, SurfaceFrame } from "./SurfaceFrame.tsx";
import { NodeView, type SurfaceHost } from "./widgets.tsx";

/**
 * The runtime for `log`, rebuilt from it whenever it changes. The log stays short (the reducer
 * merges repeated input to one path), and rebuilding keeps this a pure function of the state.
 */
export function useSurfaceRuntime(log: UiMessage[]): Runtime {
  return useMemo(() => {
    const runtime = Runtime.basic();
    runtime.apply(log as Json[]);
    return runtime;
  }, [log]);
}

interface SurfaceThread {
  runtime: Runtime;
  threadId: string;
  model: string;
  /** The open question, if it is a surface's wait. */
  waiting: Extract<Question, { kind: "ui" }> | null;
  held: string[];
  host: (surfaceId: string) => SurfaceHost;
  dismiss: (qid: number) => void;
}

const SurfaceContext = createContext<SurfaceThread | null>(null);
export const SurfaceProvider = SurfaceContext.Provider;

interface Options {
  threadId: string;
  model: string;
  state: SessionState;
  onAnswer: (qid: number, answer: Answer) => void;
  onUiAction: (action: UiAction) => void;
  onLocal: (action: LocalAction) => void;
}

/** The thread's surfaces: the context their entries draw from, and the link waiting for the
 * user's yes. */
export function useSurfaces({ threadId, model, state, onAnswer, onUiAction, onLocal }: Options) {
  const runtime = useSurfaceRuntime(state.uiLog);
  const [link, setLink] = useState<string | null>(null);
  const question = state.questions[0];
  const waiting = question?.kind === "ui" ? question : null;

  const press = useCallback(
    (surfaceId: string, node: Node) => {
      const sent = runtime.component(surfaceId, node.id)?.action;
      if (sent === undefined) return;
      const before = JSON.stringify(runtime.dataModel(surfaceId) ?? null);
      const result = runtime.dispatch(sent, { surfaceId, node, activation: true });
      if ("error" in result) {
        onLocal({
          type: "local/warning",
          text: `[surface ${surfaceId}] ${result.error.code}: ${result.error.message}`,
        });
        return;
      }
      // A local function's data writes are applied on the runtime; keep them in the log too.
      const after = runtime.dataModel(surfaceId) ?? null;
      if (JSON.stringify(after) !== before) {
        onLocal({ type: "local/uiInput", surfaceId, path: "/", value: after });
      }
      for (const effect of result.ok.effects) {
        if (effect.kind === "openUrl") setLink(effect.url);
      }
      const action = result.ok.action;
      if (!action) return;
      if (waiting && waiting.surfaceIds.includes(surfaceId)) {
        onAnswer(waiting.qid, { type: "ui", action });
      } else {
        onUiAction(action);
      }
    },
    [runtime, waiting, onAnswer, onUiAction, onLocal],
  );

  const context = useMemo<SurfaceThread>(
    () => ({
      runtime,
      threadId,
      model,
      waiting,
      held: state.uiHeld,
      dismiss: (qid) => onAnswer(qid, { type: "ui", action: null }),
      host: (surfaceId) => ({
        surfaceId,
        bindingPath: (node, property) => runtime.bindingPath(node, property),
        input: (path, value) => onLocal({ type: "local/uiInput", surfaceId, path, value }),
        press: (node) => press(surfaceId, node),
        workspaceSrc: (path) => surfaceMediaUrl(threadId, path),
      }),
    }),
    // `state.uiLog` changes whenever the runtime's surfaces do, so entries redraw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runtime, threadId, model, waiting, state.uiHeld, state.uiLog, onAnswer, onLocal, press],
  );

  return { context, link, closeLink: () => setLink(null) };
}

/** A surface at its place in the transcript. */
export function SurfaceEntryView({ entry }: { entry: SurfaceEntry }) {
  const thread = useContext(SurfaceContext);
  if (entry.deleted) return <RemovedSurface surfaceId={entry.surfaceId} />;
  if (!thread) return null;
  const tree = thread.runtime.tree(entry.surfaceId);
  const waiting = thread.waiting?.surfaceIds.includes(entry.surfaceId) ? thread.waiting : null;
  return (
    <SurfaceFrame
      surfaceId={entry.surfaceId}
      model={thread.model}
      waiting={waiting !== null}
      held={thread.held.filter((id) => id === entry.surfaceId).length}
      onDismiss={waiting ? () => thread.dismiss(waiting.qid) : undefined}
    >
      {tree ? (
        <NodeView node={tree} host={thread.host(entry.surfaceId)} />
      ) : (
        <span className="text-xs text-muted">Nothing to show yet.</span>
      )}
    </SurfaceFrame>
  );
}

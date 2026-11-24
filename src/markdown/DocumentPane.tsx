import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DOCUMENT_DEFAULT,
  DOCUMENT_MAX,
  DOCUMENT_MIN,
  loadDocumentPane,
  saveDocumentPane,
} from "../shell/layout.ts";
import { ResizeHandle } from "../shell/ResizeHandle.tsx";
import { followLink } from "./follow.ts";
import { MarkdownViewer } from "./MarkdownViewer.tsx";
import type { OpenDocument } from "./documents.ts";
import type { Documents } from "./useDocuments.ts";

const button = "rounded px-1.5 text-muted hover:bg-panel-2 hover:text-text";

/**
 * The Markdown viewer beside a thread's transcript (docs/PROJECT_PLAN.md §7a, step 4). Resizable
 * from its left edge (the width is kept between runs), closed with ✕ or Esc, and with ← back to
 * the document a link was followed from.
 */
export function DocumentPane({ threadId, documents }: { threadId: string; documents: Documents }) {
  return documents.current ? (
    <OpenPane threadId={threadId} documents={documents} current={documents.current} />
  ) : null;
}

/** The pane while it shows a document: mounted on opening, so it reads the saved width then. */
function OpenPane({
  threadId,
  documents,
  current,
}: {
  threadId: string;
  documents: Documents;
  current: OpenDocument;
}) {
  const { canGoBack, back, close, push } = documents;
  const [width, setWidth] = useState(loadDocumentPane);
  const pane = useRef<HTMLElement>(null);

  // Give the focus back where it was when the pane opened, once it closes. Declared before the
  // effect below, so it notes the focus before the pane takes it.
  useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => returnTo?.focus({ preventScroll: true });
  }, []);

  // Take the focus for each document shown, so Esc closes it and the keyboard reads it.
  useEffect(() => {
    pane.current?.focus({ preventScroll: true });
  }, [current.id]);

  const leading = canGoBack ? (
    <button type="button" className={button} onClick={back} title="Back" aria-label="Back">
      ←
    </button>
  ) : null;
  const actions = (
    <button
      type="button"
      className={button}
      onClick={close}
      title="Close (Esc)"
      aria-label="Close document"
    >
      ✕
    </button>
  );

  return (
    <aside
      ref={pane}
      tabIndex={-1}
      aria-label="Document"
      style={{ width }}
      className="relative flex max-w-[70%] shrink-0 flex-col border-l border-border bg-panel focus:outline-none"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        close();
      }}
    >
      <ResizeHandle
        width={width}
        onResize={(next) => {
          setWidth(next);
          saveDocumentPane(next);
        }}
        label="Resize document pane"
        min={DOCUMENT_MIN}
        max={DOCUMENT_MAX}
        reset={DOCUMENT_DEFAULT}
        edge="left"
      />
      {current.status === "ready" ? (
        <MarkdownViewer
          key={current.id}
          text={current.text}
          title={current.title}
          leading={leading}
          actions={actions}
          onLink={(target) =>
            followLink(target, { threadId, documentPath: current.path, show: push })
          }
        />
      ) : (
        <Placeholder title={current.title} leading={leading} actions={actions}>
          {current.status === "loading" ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : (
            <p role="alert" className="text-sm text-error">
              {current.problem}
            </p>
          )}
        </Placeholder>
      )}
    </aside>
  );
}

/** A document still loading, or one that could not be read: its header, and a line. */
function Placeholder({
  title,
  leading,
  actions,
  children,
}: {
  title: string;
  leading: ReactNode;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={title}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-sm">
        {leading}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={title}>
          {title.split(/[\\/]/).pop() || title}
        </span>
        {actions}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

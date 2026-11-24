import { useEffect, useMemo, useRef, useState } from "react";
import { Highlight } from "../highlight/Highlight.tsx";

type Engine = typeof import("./viewer-engine.ts");

let engine: Engine | undefined;
let loading: Promise<Engine> | undefined;

function loadEngine(): Promise<Engine> {
  loading ??= import("./viewer-engine.ts").then((module) => (engine = module));
  // A failed load can be tried again next time.
  loading.catch(() => (loading = undefined));
  return loading;
}

type Mode = "rendered" | "raw";

/** Contents indent per heading level. */
const INDENT = ["", "pl-3", "pl-6", "pl-9", "pl-12", "pl-14"];

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * A Markdown document, rendered with mdglass (GFM, highlighting, front matter) or shown as its
 * source. Used for files the agent wrote and for replies opened as documents. The HTML is cleaned
 * by viewer-engine.ts before it reaches the page.
 */
export function MarkdownViewer({ text, title }: { text: string; title?: string }) {
  const [mode, setMode] = useState<Mode>("rendered");
  const [ready, setReady] = useState(!!engine);
  const [problem, setProblem] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (engine) return;
    let live = true;
    loadEngine().then(
      () => live && setReady(true),
      (error: unknown) => live && setProblem(`The viewer could not load: ${String(error)}`),
    );
    return () => {
      live = false;
    };
  }, []);

  const rendered = useMemo(
    () => (ready && engine ? engine.renderDocument(text) : undefined),
    [text, ready],
  );
  const headings = rendered?.headings.filter((h) => h.id) ?? [];

  const goTo = (id: string) => {
    const target = body.current?.querySelector(`#${CSS.escape(engine!.ID_PREFIX + id)}`);
    target?.scrollIntoView({ block: "start" });
  };

  const tab = (which: Mode, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === which}
      className={`rounded px-2 py-0.5 ${
        mode === which ? "bg-panel-2 text-text" : "text-muted hover:text-text"
      }`}
      onClick={() => setMode(which)}
    >
      {label}
    </button>
  );

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={title ?? "Markdown document"}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-sm">
        {title && (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={title}>
            {fileName(title)}
          </span>
        )}
        <div role="tablist" aria-label="Show as" className="ml-auto flex gap-1 text-xs">
          {tab("rendered", "Rendered")}
          {tab("raw", "Raw")}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {mode === "raw" ? (
          <pre className="font-mono text-xs leading-5 whitespace-pre-wrap">
            <code>
              <Highlight code={text} language="markdown" />
            </code>
          </pre>
        ) : problem ? (
          <p role="alert" className="text-sm text-error">
            {problem}
          </p>
        ) : !rendered ? (
          <p className="text-sm text-muted">Rendering…</p>
        ) : (
          <>
            {headings.length > 1 && (
              <details className="mb-3 rounded border border-border px-3 py-1.5 text-sm">
                <summary className="cursor-pointer text-muted">Contents</summary>
                <nav aria-label="Contents">
                  <ul className="mt-1.5">
                    {headings.map((heading) => (
                      <li key={heading.id} className={INDENT[heading.level - 1]}>
                        <button
                          type="button"
                          className="text-left text-accent hover:underline"
                          onClick={() => goTo(heading.id)}
                        >
                          {heading.text}
                        </button>
                      </li>
                    ))}
                  </ul>
                </nav>
              </details>
            )}
            <div
              ref={body}
              className="md md-document"
              // Cleaned by viewer-engine.ts (mdglass without raw HTML, then DOMPurify).
              dangerouslySetInnerHTML={{ __html: rendered.html }}
            />
          </>
        )}
      </div>
    </section>
  );
}

import {
  createContext,
  memo,
  useContext,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openDocumentLink, openPath } from "../desktop-client/backend.ts";
import { Highlight } from "../highlight/Highlight.tsx";
import { normalizeLanguage } from "../highlight/languages.ts";
import { useThread } from "../thread/ThreadContext.ts";
import { safeUrl, splitBlocks } from "./blocks.ts";
import { classifyHref, isMarkdown } from "./links.ts";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded px-1.5 py-0.5 text-xs text-muted hover:bg-panel hover:text-text"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CodeBlock({ language, code }: { language: string | undefined; code: string }) {
  return (
    <div className="my-3 overflow-hidden rounded-md border border-border bg-panel-2">
      <div className="flex items-center justify-between border-b border-border px-3 py-1 font-mono text-xs text-muted">
        <span>{language ?? "text"}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-3 text-sm leading-relaxed">
        <code>
          <Highlight code={code} language={normalizeLanguage(language)} />
        </code>
      </pre>
    </div>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/**
 * Open a reply's link outside the app. The webview never follows it itself (it would navigate the
 * app away, or do nothing for `target="_blank"`), and has no opener permission: Rust opens it
 * through `open_document_link`, after checking it again.
 */
function openLink(event: MouseEvent<HTMLAnchorElement>, url: string) {
  event.preventDefault();
  openDocumentLink(url).catch((error: unknown) => {
    console.warn(`Could not open ${url}:`, error);
  });
}

/** Whether an element is already inside a link, so inline code in it does not become another. */
const InLink = createContext(false);

/**
 * A link to a file of the thread's, from a reply (docs/PROJECT_PLAN.md §7a, step 8): a Markdown file
 * opens in the document pane, anything else with its default app. Relative paths are taken from
 * the workspace, and Rust checks every path again (inside the workspace or a kept worktree, no
 * programs or scripts). Outside a thread there is nothing to open it with, so it is text.
 */
function FileLink({ path, children }: { path: string; children: ReactNode }) {
  const { threadId, openFile } = useThread();
  const [problem, setProblem] = useState<string | null>(null);
  const markdown = isMarkdown(path);
  if (!threadId || (markdown && !openFile)) {
    return <span className="underline decoration-dotted">{children}</span>;
  }
  return (
    <>
      <a
        href="#"
        className="text-accent underline"
        title={markdown ? `${path} (show it beside the conversation)` : `${path} (open it)`}
        data-file={path}
        onClick={(event) => {
          event.preventDefault();
          setProblem(null);
          if (markdown) openFile?.(path);
          else openPath(threadId, path, false).catch((e: unknown) => setProblem(String(e)));
        }}
      >
        <InLink.Provider value={true}>{children}</InLink.Provider>
      </a>
      {problem && (
        <span role="alert" className="ml-1 text-error" title={problem}>
          ({problem})
        </span>
      )}
    </>
  );
}

/** The path inline code names, when it is a Markdown file (`docs/plan.md`): no spaces, quotes, or
 * wildcards, so prose like `*.md` or `a b.md` stays code. */
function markdownPathIn(code: string): string | undefined {
  const text = code.trim();
  if (!/^[^\s`'"<>|*?]+$/.test(text)) return undefined;
  const target = classifyHref(text);
  if (target.kind !== "file" || !isMarkdown(target.path)) return undefined;
  // A file name, not just the extension (`.md`).
  const name = target.path.split(/[\\/]/).pop() ?? "";
  return name.lastIndexOf(".") > 0 ? target.path : undefined;
}

/** Inline code; a Markdown path in it is a link to the file, unless it is already in a link. */
function InlineCode({ children }: { children: ReactNode }) {
  const inLink = useContext(InLink);
  const code = (
    <code className="rounded bg-panel-2 px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
  );
  const path = inLink ? undefined : markdownPathIn(textOf(children));
  return path ? <FileLink path={path}>{code}</FileLink> : code;
}

const components: Components = {
  a({ href, children }) {
    const target = href ? classifyHref(href) : { kind: "none" as const };
    if (target.kind === "file") return <FileLink path={target.path}>{children}</FileLink>;
    if (target.kind !== "external") {
      return <span className="underline decoration-dotted">{children}</span>;
    }
    const url = target.url;
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-accent underline"
        onClick={(event) => openLink(event, url)}
      >
        <InLink.Provider value={true}>{children}</InLink.Provider>
      </a>
    );
  },
  // Images are never loaded: a model could use one to send data to a server (docs/SECURITY.md T10).
  img({ src, alt }) {
    const url = typeof src === "string" ? safeUrl(src) : undefined;
    const label = `image: ${alt || "untitled"}`;
    return url ? (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="text-accent underline"
        onClick={(event) => openLink(event, url)}
      >
        [{label}]
      </a>
    ) : (
      <span className="text-muted">[{label}]</span>
    );
  },
  pre({ children }) {
    const child = Array.isArray(children) ? children[0] : children;
    const className =
      child && typeof child === "object" && "props" in child
        ? ((child.props as { className?: string }).className ?? "")
        : "";
    const language = /language-([\w+-]+)/.exec(className)?.[1];
    return <CodeBlock language={language} code={textOf(children).replace(/\n$/, "")} />;
  },
  // Only inline code reaches here: `pre` renders code blocks from their text.
  code({ children }) {
    return <InlineCode>{children}</InlineCode>;
  },
  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto">
        <table className="border-collapse text-sm">{children}</table>
      </div>
    );
  },
};

/** react-markdown's own check drops `file:` URLs; keep them for the `a` component, which sorts
 * every link itself (classifyHref) and lets only a local file's path through. */
function urlTransform(url: string): string {
  return /^file:/i.test(url.trim()) ? url : defaultUrlTransform(url);
}

const Block = memo(function Block({ source }: { source: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={components}
      urlTransform={urlTransform}
      skipHtml
    >
      {source}
    </ReactMarkdown>
  );
});

/**
 * Markdown from the model, rendered as React elements: raw HTML is skipped, web links are limited
 * to http, https, and mailto, file links (and Markdown paths in inline code) open the thread's
 * files, and images are shown as links. Finished blocks are memoized, so a
 * streaming reply only re-parses its last block.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => splitBlocks(text), [text]);
  return (
    <div className="md">
      {blocks.map((block, i) => (
        <Block key={i} source={block} />
      ))}
    </div>
  );
}

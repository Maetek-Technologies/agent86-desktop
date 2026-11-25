// What a link in the Markdown viewer leads to (docs/PROJECT_PLAN.md §7a, step 3). The viewer's
// renderer decides at render time and records it in `data-` attributes, so a click only reads
// them back; links are rendered with `href="#"`, so the webview itself never follows one.
import { safeUrl } from "./blocks.ts";

export type LinkTarget =
  /** http, https, or mailto: opened outside the app. */
  | { kind: "external"; url: string }
  /** `#id` in the same document. */
  | { kind: "anchor"; id: string }
  /**
   * A file. `from: "document"` for a Markdown link or image, taken from the document's folder;
   * `from: "workspace"` for a `path:line` reference in the text, taken from the workspace.
   */
  | { kind: "file"; path: string; line?: number; from: "document" | "workspace" }
  /** Anything else (other schemes, `//host`): shown, not followed. */
  | { kind: "none" };

/** A URL scheme, but not a Windows drive (`C:\`, `C:/`). */
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * The local path a `file:` URL names, still encoded and with any fragment: `file:///a/b.md` →
 * `/a/b.md`, `file://localhost/a` → `/a`, `file:///C:/a` → `C:/a`. `undefined` when `raw` is not
 * a `file:` URL; `null` for one on another host, which is not a local file.
 */
function fileUrlPath(raw: string): string | undefined | null {
  const match = /^file:\/\/([^/]*)(\/.*)?$/i.exec(raw);
  if (!match) return /^file:/i.test(raw) ? null : undefined;
  const [, host = "", path = ""] = match;
  if (host && host.toLowerCase() !== "localhost") return null;
  return /^\/[a-z]:[\\/]/i.test(path) ? path.slice(1) : path;
}

/** Where `href`, as written in a Markdown link or image, leads. */
export function classifyHref(href: string): LinkTarget {
  const raw = href.trim();
  if (!raw) return { kind: "none" };
  const url = safeUrl(raw);
  if (url) return { kind: "external", url };
  if (raw.startsWith("#"))
    return raw.length > 1 ? { kind: "anchor", id: decode(raw.slice(1)) } : { kind: "none" };
  const local = fileUrlPath(raw);
  if (local === null) return { kind: "none" };
  if (local === undefined && (SCHEME.test(raw) || raw.startsWith("//"))) return { kind: "none" };
  const rest = local ?? raw;
  const hash = rest.indexOf("#");
  const fragment = hash >= 0 ? rest.slice(hash + 1) : "";
  const path = decode(rest.slice(0, hash >= 0 ? hash : undefined).split("?")[0] ?? "");
  if (!path) return { kind: "none" };
  // GitHub's `#L42` line fragments.
  const line = /^L(\d+)/.exec(fragment)?.[1];
  return line
    ? { kind: "file", path, line: Number(line), from: "document" }
    : { kind: "file", path, from: "document" };
}

/** The `data-` attributes that carry `target` on a rendered link. */
export function linkAttributes(target: LinkTarget): [string, string][] {
  switch (target.kind) {
    case "external":
      return [
        ["data-link", "external"],
        ["data-target", target.url],
        ["title", target.url],
      ];
    case "anchor":
      return [
        ["data-link", "anchor"],
        ["data-target", target.id],
      ];
    case "file": {
      const line =
        target.line === undefined ? [] : [["data-line", String(target.line)] as [string, string]];
      return [
        ["data-link", target.from === "document" ? "document-file" : "workspace-file"],
        ["data-target", target.path],
        ...line,
        ["title", target.line === undefined ? target.path : `${target.path}:${target.line}`],
      ];
    }
    case "none":
      return [["data-link", "none"]];
  }
}

/** The target a rendered link carries, from its `data-` attributes. */
export function targetOf(link: HTMLElement): LinkTarget {
  const target = link.dataset.target ?? "";
  const line = link.dataset.line ? Number(link.dataset.line) : undefined;
  switch (link.dataset.link) {
    case "external":
      return safeUrl(target) ? { kind: "external", url: target } : { kind: "none" };
    case "anchor":
      return target ? { kind: "anchor", id: target } : { kind: "none" };
    case "document-file":
    case "workspace-file": {
      if (!target) return { kind: "none" };
      const from = link.dataset.link === "document-file" ? "document" : "workspace";
      return line === undefined
        ? { kind: "file", path: target, from }
        : { kind: "file", path: target, line, from };
    }
    case undefined: {
      // Footnote references and back-links come from markdown-it-footnote's own rules, not
      // viewerLinks, so they keep a real `#id` href.
      const href = link.getAttribute("href") ?? "";
      return href.length > 1 && href.startsWith("#")
        ? { kind: "anchor", id: decode(href.slice(1)) }
        : { kind: "none" };
    }
    default:
      return { kind: "none" };
  }
}

/** Whether `path` names a Markdown file, which the viewer shows itself. */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(path);
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[a-z]:[\\/]/i.test(path);
}

/**
 * `target`'s path as the app's file commands take it: absolute, or relative to the workspace.
 * A document's own links are taken from its folder; a reply (no `documentPath`) and `path:line`
 * references from the workspace. Rust still checks the result is inside the workspace.
 */
export function filePath(
  target: { path: string; from: "document" | "workspace" },
  documentPath?: string,
): string {
  if (isAbsolute(target.path) || target.from === "workspace" || !documentPath) return target.path;
  const folder = documentPath.replace(/[\\/][^\\/]*$/, "");
  const sep = documentPath.includes("\\") ? "\\" : "/";
  return (
    folder +
    sep +
    target.path
      .replace(/^\.[\\/]/, "")
      .split("/")
      .join(sep)
  );
}

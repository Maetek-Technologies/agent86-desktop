// The Markdown viewer's renderer (docs/PROJECT_PLAN.md §7a), loaded on demand by
// MarkdownViewer.tsx so mdglass and DOMPurify stay out of the startup bundle.
//
// Unlike chat replies (Markdown.tsx, React elements only), the viewer shows mdglass's HTML through
// innerHTML, so the HTML is made safe here, in two layers (docs/SECURITY.md T10):
// - mdglass runs with raw HTML off: tags in the source are shown as text.
// - DOMPurify then cleans what the plugins produced: HTML only (no SVG or MathML), no `style`
//   attributes, no images or other media (never loaded: a model could use one to send data out),
//   no forms or frames, and `id`s and `name`s prefixed with `user-content-` as GitHub does, so a
//   heading called "root" cannot clash with the app's own elements.
// - Links never point anywhere themselves (viewerLinks): the viewer follows them.
// Math and Mermaid are left out: their inline styles need a CSP decision first.
import DOMPurify from "dompurify";
import type MarkdownIt from "markdown-it";
import {
  createRenderer,
  fileReferences,
  frontMatter,
  gfm,
  highlight,
  type Heading,
  type MarkdownPlugin,
} from "mdglass";
import "mdglass/styles.css";
import hljs from "../highlight/hljs-common.ts";
import { classifyHref, linkAttributes, type LinkTarget } from "./links.ts";

/** What DOMPurify puts before every `id` and `name`. */
export const ID_PREFIX = "user-content-";

const FORBID_TAGS = [
  "img",
  "picture",
  "source",
  "video",
  "audio",
  "track",
  "image",
  "form",
  "button",
  "select",
  "textarea",
  "iframe",
  "frame",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "style",
];

export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR: ["style", "srcset", "formaction", "action", "background", "poster"],
    SANITIZE_NAMED_PROPS: true,
    ALLOW_DATA_ATTR: true,
  });
}

/**
 * Every link carries where it leads in `data-` attributes (links.ts) and gets `href="#"`, so the
 * webview never follows one itself; the viewer's click handler does. Images are never loaded:
 * each becomes a link labelled `[image: alt]`, as in chat (Markdown.tsx).
 */
const viewerLinks: MarkdownPlugin = {
  name: "viewer-links",
  extend(md: MarkdownIt) {
    const escape = md.utils.escapeHtml;
    md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
      const token = tokens[index]!;
      const filePath = token.attrGet("data-file-path");
      const line = Number(token.attrGet("data-file-line"));
      const target: LinkTarget = filePath
        ? // A `path:line` reference (mdglass's file references) names a workspace path.
          Number.isInteger(line) && line > 0
          ? { kind: "file", path: filePath, line, from: "workspace" }
          : { kind: "file", path: filePath, from: "workspace" }
        : classifyHref(token.attrGet("href") ?? "");
      const kept = token.attrs?.filter(([name]) => name === "class") ?? [];
      token.attrs = [["href", "#"], ...kept, ...linkAttributes(target)];
      return self.renderToken(tokens, index, options);
    };
    md.renderer.rules.image = (tokens, index, options, env, self) => {
      const token = tokens[index]!;
      const alt = self.renderInlineAsText(token.children ?? [], options, env);
      const label = escape(`[image: ${alt || "untitled"}]`);
      const target = classifyHref(token.attrGet("src") ?? "");
      if (target.kind === "none" || target.kind === "anchor") {
        return `<span class="image-ref">${label}</span>`;
      }
      const pairs: [string, string][] = [
        ["href", "#"],
        ["class", "image-ref"],
        ...linkAttributes(target),
      ];
      const attributes = pairs.map(([name, value]) => ` ${name}="${escape(value)}"`).join("");
      return `<a${attributes}>${label}</a>`;
    };
  },
};

const renderer = createRenderer({
  html: false,
  // A viewer for inspecting what the agent wrote: show its quotes and dashes as written.
  typographer: false,
  sanitize,
})
  .use(frontMatter({ display: "table", label: "Front matter" }))
  .use(gfm())
  // The grammars lowlight already loads, and the app's hljs-* colours (styles.css).
  .use(highlight({ hljs }))
  // `src/app.ts:42` in the text becomes a link (handled by viewerLinks, after it).
  .use(fileReferences())
  .use(viewerLinks);

export interface Rendered {
  html: string;
  headings: Heading[];
}

/** `source` as safe HTML, with its headings (ids without `ID_PREFIX`) for a contents list. */
export function renderDocument(source: string): Rendered {
  const { html, headings } = renderer.render(source);
  return { html, headings };
}

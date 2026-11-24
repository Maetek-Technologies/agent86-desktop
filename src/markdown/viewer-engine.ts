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
// Math and Mermaid are left out: their inline styles need a CSP decision first.
import DOMPurify from "dompurify";
import { createRenderer, frontMatter, gfm, highlight, type Heading } from "mdglass";
import "mdglass/styles.css";
import hljs from "../highlight/hljs-common.ts";

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

const renderer = createRenderer({
  html: false,
  // A viewer for inspecting what the agent wrote: show its quotes and dashes as written.
  typographer: false,
  sanitize,
})
  .use(frontMatter({ display: "table", label: "Front matter" }))
  .use(gfm())
  // The grammars lowlight already loads, and the app's hljs-* colours (styles.css).
  .use(highlight({ hljs }));

export interface Rendered {
  html: string;
  headings: Heading[];
}

/** `source` as safe HTML, with its headings (ids without `ID_PREFIX`) for a contents list. */
export function renderDocument(source: string): Rendered {
  const { html, headings } = renderer.render(source);
  return { html, headings };
}

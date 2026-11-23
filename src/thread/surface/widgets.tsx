// The A2UI basic catalog drawn with the app's own widgets (agent86UI). Each component draws a
// resolved `Node` from the runtime: values are already bound, templates expanded, and checks
// evaluated. Input goes back through `host.input` to the bound path; a button goes through
// `host.press`, which builds the action. Nothing here may look like agent86's own approval or
// secret panels: those use the warn colour and solid borders, these the `agent` hue.

import { useId, useState, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { mediaSource, type MediaSource } from "./media.ts";
import type { Json, Node } from "./runtime/types.ts";

/** What a surface's widgets need from the thread. */
export interface SurfaceHost {
  surfaceId: string;
  /** The absolute data path a node's property is bound to, or `null` (a literal value). */
  bindingPath: (node: Node, property: string) => string | null;
  /** The user entered `value` at `path`. */
  input: (path: string, value: Json) => void;
  /** The user pressed a button (or another component with an action). */
  press: (node: Node) => void;
  /** A workspace-relative media path as a URL of the app's media scheme. */
  workspaceSrc: (path: string) => string;
}

const str = (value: Json | undefined): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const num = (value: Json | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function childrenOf(node: Node, property: string): Node[] {
  return node.children.find(([name]) => name === property)?.[1] ?? [];
}

/** The messages of the failing checks, errors first. */
function problems(node: Node): string[] {
  return node.failures
    .filter((f) => (f.severity ?? "error") === "error")
    .map((f) => str(f.message))
    .filter(Boolean);
}

function label(node: Node): string | undefined {
  const text = node.accessibility?.label;
  return typeof text === "string" ? text : undefined;
}

/** A component's `weight`: its share of a Row's or Column's free space. */
function weightStyle(node: Node): CSSProperties | undefined {
  const weight = num(node.properties.weight);
  return weight !== undefined && weight > 0 ? { flexGrow: weight, flexBasis: 0 } : undefined;
}

const JUSTIFY: Record<string, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  spaceBetween: "justify-between",
  spaceAround: "justify-around",
  spaceEvenly: "justify-evenly",
  stretch: "justify-stretch",
};
const ALIGN: Record<string, string> = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
};

/** Draw one node and its children. */
export function NodeView({ node, host }: { node: Node; host: SurfaceHost }) {
  const drawn = draw(node, host);
  const style = weightStyle(node);
  if (!style) return drawn;
  return (
    <div style={style} className="min-w-0">
      {drawn}
    </div>
  );
}

function draw(node: Node, host: SurfaceHost): ReactNode {
  if (node.placeholder) {
    return <span className="text-xs text-muted">…</span>;
  }
  const p = node.properties;
  const kids = (property: string) =>
    childrenOf(node, property).map((child, i) => (
      <NodeView key={`${child.id}-${child.dataPath}-${i}`} node={child} host={host} />
    ));
  switch (node.component) {
    case "Text":
      return <SurfaceText text={str(p.text)} caption={p.variant === "caption"} />;
    case "Image":
      return <SurfaceImage node={node} host={host} />;
    case "Icon":
      return <SurfaceIcon name={p.name} label={label(node)} />;
    case "Video":
      return <SurfaceVideo node={node} host={host} />;
    case "AudioPlayer":
      return <SurfaceAudio node={node} host={host} />;
    case "Row":
    case "Column":
    case "List": {
      const horizontal =
        node.component === "Row" || (node.component === "List" && p.direction === "horizontal");
      const justify = JUSTIFY[str(p.justify)] ?? "justify-start";
      const align = ALIGN[str(p.align)] ?? (horizontal ? "items-center" : "items-stretch");
      return (
        <div
          className={`flex gap-2 ${horizontal ? "flex-row flex-wrap" : "flex-col"} ${justify} ${align}`}
          role={node.component === "List" ? "list" : undefined}
          aria-label={label(node)}
        >
          {kids("children")}
        </div>
      );
    }
    case "Card":
      return (
        <div className="rounded-md border border-border bg-panel p-3" aria-label={label(node)}>
          {kids("child")}
        </div>
      );
    case "Tabs":
      return <SurfaceTabs node={node} host={host} />;
    case "Modal":
      return <SurfaceModal node={node} host={host} />;
    case "Divider":
      return p.axis === "vertical" ? (
        <div className="w-px self-stretch bg-border" role="separator" aria-orientation="vertical" />
      ) : (
        <hr className="border-border" />
      );
    case "Button":
      return <SurfaceButton node={node} host={host} label={kids("child")} />;
    case "TextField":
      return <SurfaceTextField node={node} host={host} />;
    case "CheckBox":
      return <SurfaceCheckBox node={node} host={host} />;
    case "ChoicePicker":
      return <SurfaceChoicePicker node={node} host={host} />;
    case "Slider":
      return <SurfaceSlider node={node} host={host} />;
    case "DateTimeInput":
      return <SurfaceDateTime node={node} host={host} />;
    default:
      // agent86 validates against the basic catalog, so this is a component a later catalog
      // added: say so rather than draw nothing.
      return <span className="text-xs text-muted">[{node.component} is not shown here]</span>;
  }
}

/** The basic catalog's Text: simple Markdown, without HTML, images, or links. */
function SurfaceText({ text, caption }: { text: string; caption: boolean }) {
  return (
    <div className={`surface-text ${caption ? "text-xs text-muted" : "text-sm"}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={["a", "img"]}
        unwrapDisallowed
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function Refused({ why }: { why: string }) {
  return (
    <div className="rounded border border-dashed border-border px-2 py-1 text-xs text-muted">
      {why}
    </div>
  );
}

function source(node: Node, property: string, host: SurfaceHost): MediaSource {
  return mediaSource(node.properties[property], host.workspaceSrc);
}

const IMAGE_SIZE: Record<string, string> = {
  icon: "h-6 w-6",
  avatar: "h-10 w-10 rounded-full",
  smallFeature: "max-h-24",
  mediumFeature: "max-h-48",
  largeFeature: "max-h-80",
  header: "max-h-40 w-full",
};
const FIT: Record<string, string> = {
  contain: "object-contain",
  cover: "object-cover",
  fill: "object-fill",
  none: "object-none",
  scaleDown: "object-scale-down",
};

function SurfaceImage({ node, host }: { node: Node; host: SurfaceHost }) {
  const media = source(node, "url", host);
  if ("refused" in media) return <Refused why={`Image not shown. ${media.refused}`} />;
  const p = node.properties;
  return (
    <img
      src={media.src}
      alt={str(p.description) || label(node) || ""}
      className={`max-w-full ${IMAGE_SIZE[str(p.variant)] ?? "max-h-64"} ${FIT[str(p.fit)] ?? "object-contain"}`}
    />
  );
}

function SurfaceVideo({ node, host }: { node: Node; host: SurfaceHost }) {
  const media = source(node, "url", host);
  if ("refused" in media) return <Refused why={`Video not shown. ${media.refused}`} />;
  const poster = node.properties.posterUrl === undefined ? null : source(node, "posterUrl", host);
  return (
    <video
      controls
      preload="metadata"
      src={media.src}
      poster={poster && "src" in poster ? poster.src : undefined}
      aria-label={label(node)}
      className="max-h-80 max-w-full rounded"
    />
  );
}

function SurfaceAudio({ node, host }: { node: Node; host: SurfaceHost }) {
  const media = source(node, "url", host);
  if ("refused" in media) return <Refused why={`Audio not shown. ${media.refused}`} />;
  const description = str(node.properties.description);
  return (
    <figure className="space-y-1">
      {description && <figcaption className="text-xs text-muted">{description}</figcaption>}
      <audio controls preload="metadata" src={media.src} aria-label={label(node) ?? description} />
    </figure>
  );
}

/** The basic catalog's named icons, as text glyphs (the app ships no icon font). */
const ICONS: Record<string, string> = {
  accountCircle: "◉",
  add: "+",
  arrowBack: "←",
  arrowForward: "→",
  attachFile: "📎",
  calendarToday: "📅",
  call: "📞",
  camera: "📷",
  check: "✓",
  close: "✕",
  delete: "🗑",
  download: "⤓",
  edit: "✎",
  event: "📅",
  error: "⊘",
  fastForward: "⏩",
  favorite: "♥",
  favoriteOff: "♡",
  folder: "📁",
  help: "?",
  home: "⌂",
  info: "ℹ",
  locationOn: "📍",
  lock: "🔒",
  lockOpen: "🔓",
  mail: "✉",
  menu: "☰",
  moreVert: "⋮",
  moreHoriz: "⋯",
  notificationsOff: "🔕",
  notifications: "🔔",
  pause: "⏸",
  payment: "💳",
  person: "👤",
  phone: "📱",
  photo: "🖼",
  play: "▶",
  print: "🖨",
  refresh: "↻",
  rewind: "⏪",
  search: "🔍",
  send: "➤",
  settings: "⚙",
  share: "⇪",
  shoppingCart: "🛒",
  skipNext: "⏭",
  skipPrevious: "⏮",
  star: "★",
  starHalf: "⯨",
  starOff: "☆",
  stop: "⏹",
  upload: "⤒",
  visibility: "👁",
  visibilityOff: "◌",
  volumeDown: "🔉",
  volumeMute: "🔈",
  volumeOff: "🔇",
  volumeUp: "🔊",
  warning: "△",
};

function SurfaceIcon({ name, label }: { name: Json | undefined; label: string | undefined }) {
  if (
    name &&
    typeof name === "object" &&
    !Array.isArray(name) &&
    typeof name.svgPath === "string"
  ) {
    return (
      <svg
        viewBox="0 0 24 24"
        className="inline h-5 w-5 fill-current"
        role="img"
        aria-label={label}
      >
        <path d={name.svgPath} />
      </svg>
    );
  }
  const glyph = typeof name === "string" ? ICONS[name] : undefined;
  return (
    <span role="img" aria-label={label ?? (typeof name === "string" ? name : "icon")}>
      {glyph ?? "•"}
    </span>
  );
}

function SurfaceTabs({ node, host }: { node: Node; host: SurfaceHost }) {
  const [active, setActive] = useState(0);
  const tabs = Array.isArray(node.properties.tabs) ? node.properties.tabs : [];
  const panels = childrenOf(node, "tabs");
  const shown = Math.min(active, Math.max(panels.length - 1, 0));
  const panel = panels[shown];
  return (
    <div>
      <div role="tablist" className="mb-2 flex gap-1 border-b border-border">
        {tabs.map((tab, i) => {
          const title = tab && typeof tab === "object" && !Array.isArray(tab) ? str(tab.title) : "";
          return (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === shown}
              onClick={() => setActive(i)}
              className={`-mb-px border-b-2 px-2 py-1 text-sm ${i === shown ? "border-agent text-text" : "border-transparent text-muted hover:text-text"}`}
            >
              {title || `Tab ${i + 1}`}
            </button>
          );
        })}
      </div>
      <div role="tabpanel">{panel && <NodeView node={panel} host={host} />}</div>
    </div>
  );
}

/**
 * The basic catalog's Modal, drawn inline inside the surface's frame rather than as an overlay
 * on the app: a full-window dialog drawn by the model could pass for one of the app's own.
 */
function SurfaceModal({ node, host }: { node: Node; host: SurfaceHost }) {
  const [open, setOpen] = useState(false);
  const trigger = childrenOf(node, "trigger")[0];
  const content = childrenOf(node, "content")[0];
  return (
    <div>
      <div onClickCapture={() => setOpen(true)}>
        {trigger && <NodeView node={trigger} host={host} />}
      </div>
      {open && content && (
        <div
          role="dialog"
          aria-label={label(node)}
          className="mt-2 rounded-md border border-dashed border-agent bg-panel p-3"
        >
          <div className="mb-2 flex justify-end">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded px-1.5 text-xs text-muted hover:bg-panel-2 hover:text-text"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <NodeView node={content} host={host} />
        </div>
      )}
    </div>
  );
}

const BUTTON: Record<string, string> = {
  primary: "bg-agent text-bg hover:opacity-90",
  borderless: "text-agent hover:bg-panel-2",
  default: "border border-agent/60 text-text hover:bg-panel-2",
};

function SurfaceButton({
  node,
  host,
  label: children,
}: {
  node: Node;
  host: SurfaceHost;
  label: ReactNode;
}) {
  const blocked = problems(node);
  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        disabled={blocked.length > 0}
        title={blocked.join("\n") || undefined}
        aria-label={label(node)}
        onClick={() => host.press(node)}
        className={`rounded px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${BUTTON[str(node.properties.variant)] ?? BUTTON.default}`}
      >
        {children}
      </button>
    </span>
  );
}

function Problems({ node, id }: { node: Node; id: string }) {
  const messages = problems(node);
  if (messages.length === 0) return null;
  return (
    <ul id={id} className="mt-1 space-y-0.5 text-xs text-error">
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

/** A field's value, written back to its bound path; a literal value is edited in place only. */
function useBound(node: Node, host: SurfaceHost, property: string) {
  const path = host.bindingPath(node, property);
  const [local, setLocal] = useState<Json | undefined>(undefined);
  const value = path === null && local !== undefined ? local : (node.properties[property] ?? null);
  const set = (next: Json) => (path === null ? setLocal(next) : host.input(path, next));
  return [value, set] as const;
}

const FIELD =
  "w-full rounded border border-border bg-bg px-2 py-1 text-sm text-text outline-none focus:border-agent";

function SurfaceTextField({ node, host }: { node: Node; host: SurfaceHost }) {
  const id = useId();
  const [value, set] = useBound(node, host, "value");
  const p = node.properties;
  const fieldLabel = str(p.label);
  const shared = {
    id,
    value: str(value),
    placeholder: str(p.placeholder) || undefined,
    "aria-label": fieldLabel ? undefined : label(node),
    "aria-invalid": problems(node).length > 0 || undefined,
    "aria-describedby": `${id}-problems`,
    className: FIELD,
  };
  return (
    <div className="min-w-0">
      {fieldLabel && (
        <label htmlFor={id} className="mb-0.5 block text-xs text-muted">
          {fieldLabel}
        </label>
      )}
      {p.variant === "longText" ? (
        <textarea {...shared} rows={4} onChange={(e) => set(e.target.value)} />
      ) : (
        <input
          {...shared}
          type={p.variant === "number" ? "number" : "text"}
          onChange={(e) => set(e.target.value)}
        />
      )}
      <Problems node={node} id={`${id}-problems`} />
    </div>
  );
}

function SurfaceCheckBox({ node, host }: { node: Node; host: SurfaceHost }) {
  const id = useId();
  const [value, set] = useBound(node, host, "value");
  return (
    <div>
      <label className="inline-flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => set(e.target.checked)}
          aria-describedby={`${id}-problems`}
          className="accent-[var(--agent)]"
        />
        {str(node.properties.label) || label(node)}
      </label>
      <Problems node={node} id={`${id}-problems`} />
    </div>
  );
}

function SurfaceChoicePicker({ node, host }: { node: Node; host: SurfaceHost }) {
  const id = useId();
  const [value, set] = useBound(node, host, "value");
  const [filter, setFilter] = useState("");
  const p = node.properties;
  const single = p.variant === "mutuallyExclusive";
  const chosen = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
  const options = (Array.isArray(p.options) ? p.options : []).flatMap((option) =>
    option &&
    typeof option === "object" &&
    !Array.isArray(option) &&
    typeof option.value === "string"
      ? [{ value: option.value, label: str(option.label) || option.value }]
      : [],
  );
  const shown = options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase()));
  const toggle = (option: string) =>
    set(
      single
        ? [option]
        : chosen.includes(option)
          ? chosen.filter((v) => v !== option)
          : [...chosen, option],
    );
  const chips = p.displayStyle === "chips";
  return (
    <fieldset className="min-w-0" aria-describedby={`${id}-problems`}>
      {str(p.label) && <legend className="mb-1 text-xs text-muted">{str(p.label)}</legend>}
      {p.filterable === true && (
        <input
          className={`${FIELD} mb-1`}
          placeholder="Filter"
          aria-label="Filter the options"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      <div className={chips ? "flex flex-wrap gap-1" : "space-y-1"}>
        {shown.map((option) =>
          chips ? (
            <button
              key={option.value}
              type="button"
              aria-pressed={chosen.includes(option.value)}
              onClick={() => toggle(option.value)}
              className={`rounded-full border px-2 py-0.5 text-xs ${chosen.includes(option.value) ? "border-agent bg-agent/15 text-text" : "border-border text-muted hover:text-text"}`}
            >
              {option.label}
            </button>
          ) : (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <input
                type={single ? "radio" : "checkbox"}
                name={id}
                checked={chosen.includes(option.value)}
                onChange={() => toggle(option.value)}
                className="accent-[var(--agent)]"
              />
              {option.label}
            </label>
          ),
        )}
      </div>
      <Problems node={node} id={`${id}-problems`} />
    </fieldset>
  );
}

function SurfaceSlider({ node, host }: { node: Node; host: SurfaceHost }) {
  const id = useId();
  const [value, set] = useBound(node, host, "value");
  const p = node.properties;
  const min = num(p.min) ?? 0;
  const max = num(p.max) ?? 100;
  const steps = num(p.steps);
  const step = steps && steps >= 1 && max > min ? (max - min) / steps : "any";
  const current = num(value) ?? min;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-0.5 flex justify-between text-xs text-muted">
        <span>{str(p.label) || label(node)}</span>
        <span className="font-mono">{current}</span>
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        onChange={(e) => set(Number(e.target.value))}
        aria-describedby={`${id}-problems`}
        className="w-full accent-[var(--agent)]"
      />
      <Problems node={node} id={`${id}-problems`} />
    </div>
  );
}

function SurfaceDateTime({ node, host }: { node: Node; host: SurfaceHost }) {
  const id = useId();
  const [value, set] = useBound(node, host, "value");
  const p = node.properties;
  const date = p.enableDate !== false;
  const time = p.enableTime === true;
  const type = date && time ? "datetime-local" : time ? "time" : "date";
  // ISO 8601 as the input shows it: no seconds' fraction or zone for datetime-local.
  const shown = (iso: string) => (type === "datetime-local" ? iso.slice(0, 16) : iso);
  return (
    <div className="min-w-0">
      {str(p.label) && (
        <label htmlFor={id} className="mb-0.5 block text-xs text-muted">
          {str(p.label)}
        </label>
      )}
      <input
        id={id}
        type={type}
        value={shown(str(value))}
        min={typeof p.min === "string" ? shown(p.min) : undefined}
        max={typeof p.max === "string" ? shown(p.max) : undefined}
        onChange={(e) => set(e.target.value)}
        aria-label={str(p.label) ? undefined : label(node)}
        aria-describedby={`${id}-problems`}
        className={FIELD}
      />
      <Problems node={node} id={`${id}-problems`} />
    </div>
  );
}

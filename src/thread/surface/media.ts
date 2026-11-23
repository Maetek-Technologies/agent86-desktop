// Where a surface's media may load from (docs/agent86ui.md, "Safety"). agent86 already refuses a
// batch whose media URL is anything but a `data:` URL or a workspace-relative path (remote media is
// off: the app does not call `Ui::allow_remote_media`), and the CSP allows nothing else. This is
// the renderer's own check on top: a workspace path goes to the app's `agent86-media` scheme,
// which resolves it against this thread's workspace in Rust and refuses anything outside it.

/** What a media URL becomes: a source to load, or why it is not shown. */
export type MediaSource = { src: string } | { refused: string };

const DATA_MEDIA = /^data:(image|video|audio)\/[a-z0-9.+-]+[;,]/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * `url` as a surface gave it, resolved. `workspaceSrc` turns a workspace-relative path into a
 * URL of the app's media scheme (`surfaceMediaUrl` in the backend).
 */
export function mediaSource(url: unknown, workspaceSrc: (path: string) => string): MediaSource {
  if (typeof url !== "string" || url.trim() === "") return { refused: "No media was given." };
  const given = url.trim();
  if (given.toLowerCase().startsWith("data:")) {
    return DATA_MEDIA.test(given) ? { src: given } : { refused: "Not an image, video, or audio." };
  }
  if (HAS_SCHEME.test(given)) {
    return { refused: "Media from the web is not shown in this app." };
  }
  if (given.startsWith("/") || given.startsWith("\\")) {
    return { refused: "Only files inside the workspace are shown." };
  }
  return { src: workspaceSrc(given) };
}

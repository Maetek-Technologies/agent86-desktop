// Following a link the Markdown viewer reports (links.ts): what the viewer's pane does with it.
import { openDocumentLink, openPath, readTextFile } from "../desktop-client/backend.ts";
import type { TextFile } from "../desktop-client/events.ts";
import { filePath, isMarkdown, type LinkTarget } from "./links.ts";

export interface LinkHost {
  threadId: string;
  /** The document's own path (absolute), or none for a reply shown as a document. */
  documentPath?: string;
  /** Show another Markdown file in the viewer. */
  show(file: TextFile): void;
}

/**
 * External links open in the browser or mail app (Rust checks them again). A Markdown file loads
 * in the viewer; any other file opens with its default app (Rust refuses programs and scripts and
 * anything outside the workspace). Anchors are the viewer's own business, and `none` does nothing.
 */
export async function followLink(target: LinkTarget, host: LinkHost): Promise<void> {
  switch (target.kind) {
    case "external":
      return openDocumentLink(target.url);
    case "file": {
      const path = filePath(target, host.documentPath);
      if (isMarkdown(path)) {
        host.show(await readTextFile(host.threadId, path));
        return;
      }
      return openPath(host.threadId, path, false);
    }
    case "anchor":
    case "none":
      return;
  }
}

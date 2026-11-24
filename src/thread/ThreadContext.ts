import { createContext, useContext } from "react";

/**
 * What components deep in a thread need to know about it: its workspace, for relative paths, and
 * its id, for opening its files; and the document pane beside its transcript.
 */
export interface ThreadInfo {
  cwd?: string;
  threadId?: string;
  /** Show a Markdown file of the thread's in the document pane. */
  openFile?: (path: string) => void;
  /** Show text (a reply) as a document in the pane. */
  openDocument?: (title: string, text: string) => void;
}

export const ThreadContext = createContext<ThreadInfo>({});

export function useThread(): ThreadInfo {
  return useContext(ThreadContext);
}

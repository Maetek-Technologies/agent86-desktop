import { createContext, useContext } from "react";

/**
 * What components deep in a thread need to know about it: its workspace, for relative paths, and
 * its id, for opening its files.
 */
export interface ThreadInfo {
  cwd?: string;
  threadId?: string;
}

export const ThreadContext = createContext<ThreadInfo>({});

export function useThread(): ThreadInfo {
  return useContext(ThreadContext);
}

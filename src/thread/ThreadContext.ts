import { createContext, useContext } from "react";

/** What components deep in a thread need to know about it: its workspace, for relative paths. */
export interface ThreadInfo {
  cwd?: string;
}

export const ThreadContext = createContext<ThreadInfo>({});

export function useThread(): ThreadInfo {
  return useContext(ThreadContext);
}

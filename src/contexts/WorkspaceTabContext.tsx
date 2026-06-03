"use client";

import { createContext, useContext } from "react";

type WorkspaceTabContextType = {
  openTab: (url: string, label: string) => void;
  /** Soft-reload whichever tab the user is currently viewing — same path
   *  as the toolbar's reload button. The chat panel calls this after a
   *  turn that touched files so the user can see their change without
   *  hitting reload manually. No-op if no tab is active. */
  reloadActiveTab: () => void;
};

export const WorkspaceTabContext = createContext<WorkspaceTabContextType | null>(null);

export function useWorkspaceTab() {
  return useContext(WorkspaceTabContext);
}

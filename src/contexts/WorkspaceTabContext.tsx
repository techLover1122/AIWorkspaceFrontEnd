"use client";

import { createContext, useContext } from "react";

type WorkspaceTabContextType = {
  openTab: (url: string, label: string) => void;
};

export const WorkspaceTabContext = createContext<WorkspaceTabContextType | null>(null);

export function useWorkspaceTab() {
  return useContext(WorkspaceTabContext);
}

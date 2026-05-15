import type { ChatMessage, EditorTab } from "../types/types";

export const createInitialTabs = (codeServerUrl: string): EditorTab[] => [
  { id: "vscode-1", label: "VS Code", url: codeServerUrl },
];

export const chatMessages: ChatMessage[] = [
  { id: "init-1", type: "chat", role: "assistant", content: "code-server connected. Open a new VS Code tab with +.", timestamp: Date.now() },
  { id: "init-2", type: "chat", role: "user", content: "Need multi-tab VS Code with a clean component structure.", timestamp: Date.now() },
  { id: "init-3", type: "chat", role: "assistant", content: "Done. Tabs are isolated and easy to extend later.", timestamp: Date.now() },
];

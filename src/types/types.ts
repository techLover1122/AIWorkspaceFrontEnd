export type EditorTab = {
  id: string;
  label: string;
  url: string;
  groupId?: string;
};

export type TabGroup = {
  id: string;
  label: string;
  color: string;
  collapsed: boolean;
};

export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";

export type ChatMessage = {
  id: string;
  type: "chat" | "tool" | "tool_result" | "system" | "thinking" | "error" | "abort";
  role?: "user" | "assistant";
  content: string;
  timestamp: number;
  toolName?: string;
  toolUseId?: string;
  /** Raw input passed to the tool — used to render args inline (e.g. file path). */
  toolInput?: Record<string, unknown>;
  isStreaming?: boolean;
  toolUseResult?: {
    summary?: string;
    isError?: boolean;
  };
};

export type StreamResponse = {
  type: "claude_json" | "error" | "done" | "aborted";
  data?: unknown;
  error?: string;
};

export type ChatRequest = {
  message: string;
  sessionId?: string;
  requestId: string;
  allowedTools?: string[];
  workingDirectory?: string;
  permissionMode?: PermissionMode;
};

export type ProjectInfo = {
  path: string;
  encodedName: string;
};

export type ConversationSummary = {
  sessionId: string;
  startTime: string;
  lastTime: string;
  messageCount: number;
  lastMessagePreview: string;
};

export type PermissionRequest = {
  toolName: string;
  toolUseId: string;
  patterns: string[];
  isPlanMode: boolean;
};

export type ChatState = {
  messages: ChatMessage[];
  sessionId: string | null;
  isLoading: boolean;
  currentRequestId: string | null;
};

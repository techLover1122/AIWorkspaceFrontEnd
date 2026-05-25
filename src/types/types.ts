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
  /** Inline image attachments (data URLs) — used for user messages so the
   *  composer can show small thumbnails instead of dumping the filename as
   *  text in the chat transcript. */
  imageUrls?: string[];
};

export type StreamResponse = {
  type:
    | "claude_json"
    | "error"
    | "done"
    | "aborted"
    | "permission_request"
    // Backend emits this every ~15s while the SDK is busy or waiting on a
    // permission decision. Frontend ignores it; its only purpose is to keep
    // the HTTP stream's bytes flowing so proxies (Traefik / Cloudflare /
    // nginx) don't close the connection during long idle stretches.
    | "heartbeat";
  data?: unknown;
  error?: string;
};

export type ChatAttachmentPayload = {
  /** "image/png", "image/jpeg", … — used for the Anthropic SDK image
   *  source's `media_type`. */
  mediaType: string;
  /** Base64-encoded bytes (no `data:...;base64,` prefix). */
  base64: string;
  /** Original filename, surfaced in the chat UI and SDK metadata. */
  name: string;
};

export type ChatRequest = {
  message: string;
  sessionId?: string;
  requestId: string;
  allowedTools?: string[];
  workingDirectory?: string;
  permissionMode?: PermissionMode;
  /** Image attachments sent alongside the message — passed to Claude as
   *  multimodal content blocks instead of file-path mentions. */
  attachments?: ChatAttachmentPayload[];
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

/** Mirrors the SDK's PermissionUpdate shape (kept loose to avoid pulling
 *  the SDK types into the frontend bundle). */
export type PermissionUpdate = Record<string, unknown>;

/** Structured permission request emitted by the backend's canUseTool
 *  callback. Replaces the old regex-derived shape. */
export type PermissionRequest = {
  /** Server-side id used when POSTing the decision back. */
  id: string;
  toolName: string;
  toolUseId: string;
  input?: Record<string, unknown>;
  /** Pre-rendered prompt sentence from the SDK bridge, e.g.
   *  "Claude wants to write foo.txt". Prefer this over reconstructing. */
  title?: string;
  /** Short noun phrase ("Write file") for compact UI. */
  displayName?: string;
  /** Human-readable subtitle. */
  description?: string;
  /** File path that triggered the request, if applicable. */
  blockedPath?: string;
  /** Why the SDK is asking (decisionReason from the bridge). */
  decisionReason?: string;
  /** PermissionUpdates we should send back as `updatedPermissions` when
   *  the user picks "Always allow". */
  suggestions?: PermissionUpdate[];
  /** True when the surrounding session is in plan mode. */
  isPlanMode: boolean;
};

/* AskUserQuestion (Claude Code built-in tool) — shape mirrors the SDK. */
export type AskUserQuestionOption = {
  label: string;
  description: string;
  preview?: string;
};

export type AskUserQuestionItem = {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
};

export type AskUserQuestionRequest = {
  toolUseId: string;
  questions: AskUserQuestionItem[];
};

export type ChatState = {
  messages: ChatMessage[];
  sessionId: string | null;
  isLoading: boolean;
  currentRequestId: string | null;
};

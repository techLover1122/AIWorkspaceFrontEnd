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
    | "permission_resolved"
    | "token_usage"
    | "heartbeat"
    | "intent_guard_request"
    | "intent_guard_resolved"
    | "anomaly_alert";
  data?: unknown;
  error?: string;
};

export type IntentGuardOption = {
  key: "narrow" | "broad";
  label: string;
  isLargeScale: boolean;
  estimatedScope?: string;
};

export type IntentGuardRequest = {
  id: string;
  originalMessage: string;
  question: string;
  narrowOption: IntentGuardOption;
  broadOption: IntentGuardOption;
};

export type AnomalyCheck = {
  name: string;
  status: "pass" | "warn" | "fail";
  detail?: string;
};

export type AnomalyAlert = {
  severity: "none" | "low" | "high";
  summary: string;
  checks: AnomalyCheck[];
  capturedIntent?: string;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
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
  /** Tool Guard Agent enrichment — present when a high-impact tool triggered
   *  the modal instead of (or in addition to) the SDK permission gate. */
  toolGuardReason?: string;
  toolGuardImpactCategory?: string;
  toolGuardActionSummary?: string;
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
  /** Active background task id on the server. Same value space as
   *  `currentRequestId` was historically — the frontend generates one
   *  per send. Null means no in-flight task. */
  currentRequestId: string | null;
  /** Highest seq we've ack'd from the streaming endpoint. Used to resume
   *  cleanly after a reconnect via `?from=lastSeq+1`. -1 means nothing
   *  received yet. */
  lastSeq: number;
};

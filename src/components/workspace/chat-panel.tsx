"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AskUserQuestionRequest,
  AnomalyAlert,
  ChatMessage,
  ChatRequest,
  IntentGuardRequest,
  PermissionMode,
  PermissionRequest,
  ProjectInfo,
} from "../../types/types";
import { useClaudeStreaming } from "../../hooks/useClaudeStreaming";
import { useChatState, createUserMessage } from "../../hooks/useChatState";
import { INSTANCE_IP, conversationUrl, eventsUrl, permissionDecisionUrl, portScanUrl, projectsUrl } from "../../constant/api";
import { convertHistoryMessages } from "../../utils/messageConverter";
import { ChatMessages } from "../chat/ChatMessages";
import {
  ChatInput,
  type Attachment,
  type ChatInputHandle,
  type SlashCommand,
} from "../chat/ChatInput";
import { PermissionInputPanel } from "../chat/PermissionInputPanel";
import { PlanPermissionInputPanel } from "../chat/PlanPermissionInputPanel";
import { IntentGuardPanel } from "../chat/IntentGuardPanel";
import { AnomalyAlertBanner } from "../chat/AnomalyAlert";
import { HistoryView } from "../chat/HistoryView";
import { EnvironmentPackModal, type InstalledPack } from "../chat/EnvironmentPackModal";
import { WhatsAppLinkModal } from "../chat/WhatsAppLinkModal";
import { AskUserQuestionModal } from "../chat/AskUserQuestionModal";
import { ConfirmDialog, type ConfirmRequest } from "../chat/ConfirmDialog";
import { AccountUsageModal } from "../chat/AccountUsageModal";
import { MiniBot } from "../chat/MiniBot";
import { TypingIndicator } from "../chat/AnimatedAIBot";
import { ConnectScreen } from "../chat/ConnectScreen";
import { ConnectionCheckLoader } from "../chat/ConnectionCheckLoader";
import { ProjectSelector } from "../project/ProjectSelector";
import { useConnectionStatus } from "../../hooks/useConnectionStatus";
import { useWorkspaceTab } from "../../contexts/WorkspaceTabContext";

type ScannedPort = {
  port: number;
  pid: number | null;
  processName: string | null;
  appLabel: string | null;
  address: string;
  isWebUI?: boolean;
  title?: string | null;
};

/** Read a File into its base64 payload + detected media type. Strips the
 *  `data:<type>;base64,` prefix so the result is ready to drop straight
 *  into an Anthropic SDK image source. */
function readFileAsBase64(
  file: File
): Promise<{ base64: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      const header = comma >= 0 ? result.slice(0, comma) : "";
      const base64 = comma >= 0 ? result.slice(comma + 1) : result;
      const m = header.match(/^data:([^;]+);base64$/);
      const mediaType = m ? m[1] : file.type || "application/octet-stream";
      resolve({ base64, mediaType });
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------------
 * Last-active-session persistence
 *
 * Without this, every page refresh / workspace reopen lands the user
 * on a blank chat even though their previous conversation is still on
 * disk (the backend keeps full transcripts under ~/.claude/projects/).
 * We remember the sessionId per working directory in localStorage and
 * replay the same history-load path that the manual History view uses.
 * Scoped per cwd so switching projects doesn't pull the wrong chat in.
 * ------------------------------------------------------------------ */
const LAST_SESSION_KEY = "ai-ide:last-session-by-cwd";

function loadLastSessionMap(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LAST_SESSION_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function writeLastSessionMap(map: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(map));
  } catch {
    // Quota exceeded or storage disabled — silently ignore.
  }
}

function rememberLastSession(cwd: string | undefined, sessionId: string): void {
  if (!cwd || !sessionId) return;
  const map = loadLastSessionMap();
  if (map[cwd] === sessionId) return;
  map[cwd] = sessionId;
  writeLastSessionMap(map);
}

function forgetLastSession(cwd: string | undefined): void {
  if (!cwd) return;
  const map = loadLastSessionMap();
  if (!(cwd in map)) return;
  delete map[cwd];
  writeLastSessionMap(map);
}

// HistoryView uses the same normalization to match cwd against the
// backend's project list — keep them in sync.
function normalizeCwd(p: string): string {
  return p.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
}

/* ------------------------------------------------------------------
 * Permission mode persistence
 *
 * The user explicitly asked to stop being prompted "Allow / Allow"
 * for every tool — they want it to just always allow. We default new
 * sessions to "bypassPermissions" and remember whatever mode they
 * pick from the toggle so a refresh doesn't snap them back to a
 * prompting mode.
 * ------------------------------------------------------------------ */
const PERMISSION_MODE_KEY = "ai-ide:permission-mode";
const VALID_MODES: readonly PermissionMode[] = [
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
];

function loadPermissionMode(): PermissionMode {
  if (typeof window === "undefined") return "bypassPermissions";
  try {
    const raw = window.localStorage.getItem(PERMISSION_MODE_KEY);
    if (raw && (VALID_MODES as readonly string[]).includes(raw)) {
      return raw as PermissionMode;
    }
  } catch {
    // fall through to default
  }
  return "bypassPermissions";
}

function writePermissionMode(mode: PermissionMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PERMISSION_MODE_KEY, mode);
  } catch {
    // quota / disabled — ignore
  }
}

// Tool calls that mean "files on disk just changed" — used to decide
// whether to auto-reload the active preview tab after a turn finishes.
// Bash is intentionally NOT here: it would also fire for read-only
// commands (ls, cat, grep) and reloads would feel random. The edit
// tools below are a clean signal.
const FILE_EDIT_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

type ChatPanelProps = {
  workingDirectory?: string;
  onChangeProject?: (path: string) => void;
  /** Optional ref the parent (WorkspaceShell) uses to push attachments
   *  into the composer — e.g. the annotation-snapshot Send button drops a
   *  composited PNG here. */
  chatInputRef?: React.Ref<ChatInputHandle>;
  /** Multi-session: namespaces this panel's persisted chat (localStorage)
   *  so several sessions can share one working directory without clobbering
   *  each other. Undefined = the legacy single-session namespace, so the
   *  pre-existing chat shows up as the first session. */
  sessionKey?: string;
  /** Whether this panel is the visible/active session. Inactive panels stay
   *  mounted (so their server task keeps streaming live in the background),
   *  but they must NOT react to global side-effect events (pack-install
   *  notifications, WhatsApp task hijacks) — only the active one does. */
  active?: boolean;
  /** Reports this session's in-flight state up to the session tab strip so
   *  it can show a "running" dot on background tabs. */
  onLoadingChange?: (loading: boolean) => void;
  /** Called once, with the first user prompt text, so the session tab can
   *  auto-rename itself to reflect the conversation topic. */
  onFirstMessage?: (text: string) => void;
};

export function ChatPanel({
  workingDirectory,
  onChangeProject,
  chatInputRef: externalChatInputRef,
  sessionKey,
  active = true,
  onLoadingChange,
  onFirstMessage,
}: ChatPanelProps) {
  const tabCtx = useWorkspaceTab();
  const {
    state,
    addMessage,
    appendToLastMessage,
    finalizeLastMessage,
    setSessionId,
    setLoading,
    setCurrentRequestId,
    setLastSeq,
    resetSeqCursor,
    setMessages,
    stateRef,
  } = useChatState(workingDirectory, sessionKey);

  // localStorage scope for the "last active session per cwd" memory. With
  // multi-session, several panels share one working directory, so the
  // last-session lookup is namespaced by sessionKey too. The REAL
  // workingDirectory is still used for backend project lookups below.
  const persistCwd =
    sessionKey && workingDirectory ? `${workingDirectory}::${sessionKey}` : workingDirectory;

  // Report in-flight state up to the session tab strip (for the running
  // dot). Routed through a ref so a changing parent callback identity can't
  // turn this into a render loop — it fires only when isLoading flips.
  const onLoadingChangeRef = useRef(onLoadingChange);
  onLoadingChangeRef.current = onLoadingChange;
  useEffect(() => {
    onLoadingChangeRef.current?.(state.isLoading);
  }, [state.isLoading]);
  const { send, attachToTask, abort } = useClaudeStreaming();

  // Default to bypassPermissions so the user isn't prompted "Allow / Allow"
  // for every tool call. Whatever mode they switch to via the toggle is
  // persisted, so refreshes keep their preference.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    loadPermissionMode
  );
  useEffect(() => {
    writePermissionMode(permissionMode);
  }, [permissionMode]);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [planRequest, setPlanRequest] = useState<PermissionRequest | null>(null);
  const [intentGuardRequest, setIntentGuardRequest] = useState<IntentGuardRequest | null>(null);
  const [anomalyAlert, setAnomalyAlert] = useState<AnomalyAlert | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [showPackModal, setShowPackModal] = useState(false);
  const [showWhatsAppModal, setShowWhatsAppModal] = useState(false);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [accountModalFocus, setAccountModalFocus] = useState<"account" | "usage">("account");

  // Allow the ProfileButton (in the tab bar) to open the account modal via a
  // custom DOM event — avoids prop drilling through workspace-shell.
  useEffect(() => {
    const handler = () => {
      setAccountModalFocus("account");
      setShowAccountModal(true);
    };
    window.addEventListener("ai-ide:open-account", handler);
    return () => window.removeEventListener("ai-ide:open-account", handler);
  }, []);
  const [askQuestion, setAskQuestion] = useState<AskUserQuestionRequest | null>(null);
  // Prompt queue: messages the user submitted while a turn was already in
  // flight. They auto-drain one at a time as each turn finishes (see the
  // drain effect below). Each carries its own attachments so a queued
  // message keeps any images that were attached when it was composed.
  const [queue, setQueue] = useState<
    { id: string; message: string; attachments: Attachment[] }[]
  >([]);
  // Tool-call internals (TodoWrite payloads, tool_result blobs, thinking
  // blocks) stay hidden by default — the user explicitly toggles them on
  // via the eye icon in the composer when they want to debug a turn.
  const [showToolDetails, setShowToolDetails] = useState(false);
  // Live token usage from the backend. Drives the CompactRing in the
  // header. Resets on /clear, /logout, and after a manual compact since
  // each starts a fresh conversation with no carryover context.
  const [tokenUsage, setTokenUsage] = useState<{ inputTokens: number; outputTokens: number }>({
    inputTokens: 0,
    outputTokens: 0,
  });
  // Conservative model-context default. Sonnet/Opus 4.x are 200k input;
  // we keep a single static budget rather than per-model lookup so the
  // ring fill stays predictable. The compact-suggested threshold (80%)
  // is encoded into the ring color, not into auto-trigger behavior.
  const MODEL_CONTEXT_LIMIT = 200_000;
  const chatInputRef = useRef<ChatInputHandle>(null);

  // Fan the ChatInput's imperative handle out to both our internal ref
  // (used for setDraft / handleReuseMessage) and an optional external
  // ref from the parent (WorkspaceShell uses it for the snapshot Send
  // flow to attach a composited image).
  const setChatInputRef = useCallback(
    (node: ChatInputHandle | null) => {
      chatInputRef.current = node;
      if (typeof externalChatInputRef === "function") {
        externalChatInputRef(node);
      } else if (externalChatInputRef) {
        (externalChatInputRef as { current: ChatInputHandle | null }).current =
          node;
      }
    },
    [externalChatInputRef]
  );

  const connection = useConnectionStatus();
  const isConnected = connection.status === "connected";

  // Persist the active sessionId as soon as the backend assigns one,
  // keyed by working directory. Empty/null is intentional — we only
  // record real sessions, and explicit clears call forgetLastSession.
  useEffect(() => {
    if (state.sessionId) rememberLastSession(persistCwd, state.sessionId);
  }, [state.sessionId, persistCwd]);

  // Restore the last active chat for this cwd on first connect.
  // Guarded by restoredForRef so the setMessages/setSessionId calls
  // we make below don't re-trigger the effect, and by the empty-chat
  // check so we never yank a user out of a chat they're already in.
  const restoredForRef = useRef<string | null>(null);

  // Index into state.messages where the current turn began (the user
  // message we're about to push). onDone reads it to scan only THIS
  // turn's tool calls — not historical ones from earlier in the chat.
  const turnStartIndexRef = useRef(0);
  useEffect(() => {
    if (!isConnected || !workingDirectory || !persistCwd) return;
    if (restoredForRef.current === persistCwd) return;
    restoredForRef.current = persistCwd;

    const lastSessionId = loadLastSessionMap()[persistCwd];
    if (!lastSessionId) return;
    if (stateRef.current.sessionId || stateRef.current.messages.length > 0) return;

    let cancelled = false;
    (async () => {
      try {
        const projRes = await fetch(projectsUrl());
        const projData = (await projRes.json()) as { projects?: ProjectInfo[] };
        if (cancelled) return;
        const target = normalizeCwd(workingDirectory);
        const project = (projData.projects ?? []).find(
          (p) => normalizeCwd(p.path) === target
        );
        if (!project) {
          // Backend no longer knows this project — stale entry, drop it.
          forgetLastSession(persistCwd);
          return;
        }
        const convRes = await fetch(
          conversationUrl(project.encodedName, lastSessionId)
        );
        if (!convRes.ok) {
          // 404 means the on-disk transcript is gone (deleted/rotated);
          // anything else is transient and worth keeping for next try.
          if (convRes.status === 404) forgetLastSession(persistCwd);
          return;
        }
        const convData: { messages?: unknown[] } = await convRes.json();
        const converted = convertHistoryMessages(convData.messages ?? []);
        if (cancelled) return;
        // Re-check — user may have typed or picked another chat while
        // we were fetching.
        if (stateRef.current.sessionId || stateRef.current.messages.length > 0) {
          return;
        }
        setSessionId(lastSessionId);
        setMessages(converted);
      } catch {
        // Network blip — leave the stored entry alone, retry next mount.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isConnected, workingDirectory, persistCwd, setSessionId, setMessages, stateRef]);

  const handleReuseMessage = useCallback((text: string) => {
    chatInputRef.current?.setDraft(text);
  }, []);

  // Captured once at mount: which taskId (if any) was hydrated from
  // localStorage? The reattach effect (defined below, after
  // streamCallbacks) uses this so it ONLY reattaches to that initial
  // taskId — fresh sends during this session attach via send().
  const initialTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    initialTaskIdRef.current = stateRef.current.currentRequestId;
    // run once on mount — ignore subsequent state changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const reattachedRef = useRef<string | null>(null);

  // Stable ref so the SSE handler can attach a WhatsApp-originated task
  // without the EventSource being recreated on every render.
  const attachWhatsAppTaskRef = useRef<(taskId: string, userMessage?: string) => void>(() => {});
  // WhatsApp turns that arrived while the panel was mid-stream. We must NOT
  // drop them (the old bug: only the first of a back-to-back WhatsApp burst
  // showed in the panel). Instead we queue them here and drain one-by-one as
  // each turn finishes. De-duped by taskId so a re-published event can't
  // double-add.
  const pendingWhatsAppRef = useRef<Array<{ taskId: string; userMessage?: string }>>([]);
  const seenWhatsAppTaskRef = useRef<Set<string>>(new Set());

  // Manual compact: ask the AI to produce a structured summary of the
  // current conversation, then start a fresh session with just that
  // summary as context. Auto-compact is disabled in the backend
  // (settings.autoCompactEnabled = false), so this button is the only
  // way to compact — the user is in full control of WHEN it happens.
  // Themed replacement for window.confirm() — see ConfirmDialog. `confirm`
  // returns a promise that resolves when the user picks an option, so call
  // sites can `await` it just like the native dialog's boolean.
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const confirmResolverRef = useRef<((ok: boolean) => void) | null>(null);
  const confirm = useCallback((req: ConfirmRequest): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmRequest(req);
    });
  }, []);
  const resolveConfirm = useCallback((ok: boolean) => {
    setConfirmRequest(null);
    const resolve = confirmResolverRef.current;
    confirmResolverRef.current = null;
    resolve?.(ok);
  }, []);

  const [isCompacting, setIsCompacting] = useState(false);
  const handleCompact = useCallback(async () => {
    if (isCompacting) return;
    if (state.isLoading) return;
    if (state.messages.length === 0) return;
    const proceed = await confirm({
      title: "Compact conversation",
      message:
        "Claude will produce a structured summary of what we've discussed " +
        "so far and then start a fresh session that begins with that " +
        "summary. The full transcript stays in your history. Token usage " +
        "should drop sharply afterwards.",
      confirmLabel: "Compact",
    });
    if (!proceed) return;
    setIsCompacting(true);
    // We piggy-back the existing handleSend path so the user sees the
    // summary being generated as a normal assistant turn. After it
    // finishes (onDone fires), the next effect below clears the session
    // and seeds the summary as a system message.
    const summaryRequest =
      "[COMPACT REQUEST — user clicked the compact button]\n\n" +
      "Produce a structured handoff summary of this conversation so far. " +
      "Format as markdown sections:\n\n" +
      "## What we're building\n## Current state\n## Key decisions\n" +
      "## Files touched (full paths)\n## What's pending / next\n\n" +
      "Keep it tight — 500 to 800 words. After you produce this summary, " +
      "I will start a fresh session seeded with it; nothing else from " +
      "this conversation will carry over. So include every fact you'd " +
      "want a fresh-context Claude to know.";
    // Use ref so the onDone-driven post-process runs against the LATEST
    // assistant message even if a stream chunk arrived after we kicked off.
    pendingCompactRef.current = true;
    handleSendRef.current?.(summaryRequest, []);
  }, [isCompacting, state.isLoading, state.messages.length, confirm]);

  // Refs used by the compact handshake: pendingCompactRef tells onDone
  // "I'm waiting for a summary"; handleSendRef lets handleCompact reach
  // the (later-declared) handleSend without React's hooks-order rules
  // blowing up on a forward reference.
  const pendingCompactRef = useRef(false);
  const handleSendRef = useRef<((message: string, attachments: Attachment[]) => void) | null>(null);

  const handleStop = useCallback(() => {
    // Stop means halt: cancel the in-flight turn AND drop anything still
    // queued, so the drain effect doesn't immediately fire the next one.
    setQueue([]);
    if (state.currentRequestId) {
      abort(state.currentRequestId);
      setLoading(false);
      setCurrentRequestId(null);
    }
  }, [state.currentRequestId, abort, setLoading, setCurrentRequestId]);

  /**
   * Pull the SDK's on-disk transcript for a session and replace the
   * chat panel's messages with it. Used as the recovery path when the
   * in-memory TaskRegistry has lost a task (backend was restarted, the
   * workspace machine was powered off overnight, 30-min idle TTL fired)
   * but the SDK already wrote the conversation to
   * `~/.claude/projects/<encoded>/<sessionId>.jsonl`. The user gets to
   * see exactly what happened during the unattended run instead of a
   * dead 404 + blank chat.
   *
   * Returns true on success, false if the transcript couldn't be
   * fetched (project not found, transcript missing, network blip).
   */
  const restoreFromDisk = useCallback(
    async (sessionId: string): Promise<boolean> => {
      if (!sessionId || !workingDirectory) return false;
      try {
        const projRes = await fetch(projectsUrl());
        if (!projRes.ok) return false;
        const projData = (await projRes.json()) as { projects?: ProjectInfo[] };
        const target = normalizeCwd(workingDirectory);
        const project = (projData.projects ?? []).find(
          (p) => normalizeCwd(p.path) === target
        );
        if (!project) return false;
        const convRes = await fetch(
          conversationUrl(project.encodedName, sessionId)
        );
        if (!convRes.ok) return false;
        const convData: { messages?: unknown[] } = await convRes.json();
        const converted = convertHistoryMessages(convData.messages ?? []);
        if (converted.length === 0) return false;
        setMessages(converted);
        return true;
      } catch {
        return false;
      }
    },
    [workingDirectory, setMessages]
  );

  const streamCallbacks = useCallback(
    () => ({
      onMessage: (msg: ChatMessage) => addMessage(msg),
      onAppend: (chunk: string) => appendToLastMessage(chunk),
      onFinalize: () => finalizeLastMessage(),
      onSessionId: (id: string) => setSessionId(id),
      onTokenUsage: (usage: { inputTokens: number; outputTokens: number }) =>
        setTokenUsage(usage),
      onTaskGone: () => {
        // Task is no longer in the in-memory TaskRegistry — almost
        // always because it completed while the tab was closed and the
        // backend's completed-task TTL eventually evicted it (less
        // commonly: backend restart, EC2 was powered off). The
        // localStorage transcript already shows whatever the user last
        // saw, and the SDK keeps the canonical transcript on disk under
        // `~/.claude/projects/<cwd>/`, so we recover silently:
        //   1. Clear the stale taskId+seq so the NEXT prompt starts a
        //      fresh task (no reattach against the dead id).
        //   2. Refresh the panel from disk if a sessionId is available
        //      — this picks up anything the SDK wrote after the tab
        //      closed without disturbing the visible state otherwise.
        // No system banner: the previous wording ("workspace was
        // offline, live task ended") was misleading in the common case
        // (task completed cleanly) and just added noise.
        const stuckSessionId = stateRef.current.sessionId ?? "";
        setCurrentRequestId(null);
        setLastSeq(-1);

        if (stuckSessionId) {
          void restoreFromDisk(stuckSessionId);
        }
      },
      onTaskStarted: (taskId: string) => {
        // Server echos the requestId we generated, but call this anyway
        // to keep client/server taskId in lock-step in case the backend
        // ever picks a different id (idempotent re-POST returns the
        // existing task's id).
        setCurrentRequestId(taskId);
      },
      onSeq: (seq: number) => setLastSeq(seq),
      onReconnecting: (attempt: number) => {
        // Soft reconnect — keep it out of the chat transcript so it
        // doesn't add noise. Console-only is fine for now; a status
        // pill in the typing bar would be a nice future polish.
        // eslint-disable-next-line no-console
        console.info("[chat-panel] reconnecting to task:", { attempt });
      },
      onPermissionRequest: (req: PermissionRequest) => {
        if (req.isPlanMode) {
          setPlanRequest(req);
        } else {
          setPermissionRequest(req);
        }
      },
      onIntentGuardRequest: (req: IntentGuardRequest) => {
        setIntentGuardRequest(req);
      },
      onAnomalyAlert: (alert: AnomalyAlert) => {
        setAnomalyAlert(alert);
      },
      onPermissionResolved: (info: {
        id: string;
        decision: "auto-allow" | "auto-deny";
        reason: string;
      }) => {
        // Server auto-resolved this permission — close any stale modal
        // that's showing the same id and drop a soft note in the chat
        // so the user sees what happened when they reconnect.
        setPermissionRequest((cur) => (cur?.id === info.id ? null : cur));
        setPlanRequest((cur) => (cur?.id === info.id ? null : cur));
        const reasonLabel =
          info.reason === "user-absent-timeout"
            ? "you were away for 5+ minutes"
            : info.reason || "server-side";
        addMessage({
          id: `pres_${Date.now()}`,
          type: "system",
          content:
            `Permission auto-${info.decision === "auto-allow" ? "allowed" : "denied"} ` +
            `(${reasonLabel}). Task switched to bypass mode for the remainder of this turn — ` +
            `subsequent tool calls won't prompt. Hit Stop if you want to intervene.`,
          timestamp: Date.now(),
        });
      },
      onAskUserQuestion: (req: AskUserQuestionRequest) => {
        // eslint-disable-next-line no-console
        console.log("[askUserQuestion:modal-open]", {
          toolUseId: req.toolUseId,
          questionCount: req.questions.length,
          aborting: state.currentRequestId,
        });
        addMessage({
          id: `sys_${Date.now()}`,
          type: "system",
          content:
            `Claude is asking you ${req.questions.length} question` +
            `${req.questions.length === 1 ? "" : "s"} ` +
            `(tool_use_id: ${req.toolUseId.slice(0, 12)}…). ` +
            `Opening the answer modal and aborting the in-flight stream so ` +
            `Claude doesn't fallback to plain text in parallel.`,
          timestamp: Date.now(),
        });
        // Abort the in-flight stream so Claude doesn't get a chance to
        // respond to the SDK auto-error before the user answers.
        if (state.currentRequestId) {
          void abort(state.currentRequestId);
        }
        setLoading(false);
        setCurrentRequestId(null);
        setAskQuestion(req);
      },
      onDone: () => {
        setLoading(false);
        setCurrentRequestId(null);

        // Compact handshake: if this turn was the summary we requested,
        // grab the assistant's reply, clear the session, and seed a
        // fresh session with the summary pinned as a system message.
        // The full transcript is still persisted on disk via the SDK,
        // so nothing is lost — only the IN-CONTEXT history is reset.
        if (pendingCompactRef.current) {
          pendingCompactRef.current = false;
          const msgs = stateRef.current.messages;
          // Find the last assistant message — that's the summary.
          let summary = "";
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m.type === "chat" && m.role === "assistant") {
              summary = m.content;
              break;
            }
          }
          // Reset session + reseed with the summary as a system message.
          // Setting sessionId to "" means the next user message starts a
          // fresh SDK session (no resume), so token usage drops back to
          // ~the size of the summary.
          setMessages(
            summary
              ? [
                  {
                    id: `compact_${Date.now()}`,
                    type: "system",
                    content:
                      "Conversation compacted. Starting fresh from this summary:\n\n" +
                      summary,
                    timestamp: Date.now(),
                  },
                ]
              : []
          );
          setSessionId("");
          forgetLastSession(persistCwd);
          setQueue([]);
          setTokenUsage({ inputTokens: 0, outputTokens: 0 });
          setIsCompacting(false);
          return;
        }

        // If the model touched files in this turn, soft-reload the
        // active tab so the user sees the change without clicking the
        // toolbar reload button. Dev servers usually HMR themselves,
        // but config edits, new files in static apps, and broken-HMR
        // states don't — this catches those without being noisy on
        // turns that only read code.
        const msgs = stateRef.current.messages;
        const start = Math.max(0, turnStartIndexRef.current);
        let didEdit = false;
        for (let i = start; i < msgs.length; i++) {
          const m = msgs[i];
          if (m.type === "tool" && m.toolName && FILE_EDIT_TOOLS.has(m.toolName)) {
            didEdit = true;
            break;
          }
        }
        if (didEdit) tabCtx?.reloadActiveTab();
      },
      onError: (error: string) => {
        addMessage({
          id: `err_${Date.now()}`,
          type: "error",
          content: error,
          timestamp: Date.now(),
        });
        setLoading(false);
        setCurrentRequestId(null);
      },
    }),
    [addMessage, appendToLastMessage, finalizeLastMessage, setSessionId, setLoading, setCurrentRequestId, setLastSeq, state.currentRequestId, abort, stateRef, tabCtx, workingDirectory, persistCwd, setMessages, restoreFromDisk]
  );

  /* ------------------------------------------------------------------
   * Auto-reattach to an in-flight server task on mount / reconnect.
   *
   * If localStorage hydration produced an active `taskId`, the SDK call
   * may still be running on the server (workspace closed mid-turn,
   * tab crashed, network blip during a stream). Reattach to the
   * registered task and resume from `lastSeq + 1` so we replay anything
   * missed.
   *
   * Guards:
   *   - Only fires once isConnected.
   *   - Only reattaches to `initialTaskIdRef.current` — the taskId
   *     captured at mount. Fresh sends in THIS session attach via
   *     send() internally and must not re-trigger this effect.
   *   - `reattachedRef` makes it idempotent across re-renders.
   * ------------------------------------------------------------------ */
  useEffect(() => {
    if (!isConnected) return;
    const tid = state.currentRequestId;
    if (!tid) return;
    if (tid !== initialTaskIdRef.current) return;
    if (reattachedRef.current === tid) return;
    reattachedRef.current = tid;

    // eslint-disable-next-line no-console
    console.info("[chat-panel] reattaching to persisted task:", {
      taskId: tid,
      fromSeq: state.lastSeq + 1,
    });

    // Show the typing bar while we replay buffered events and tail.
    // If the task already finished, attachToTask will replay any
    // remaining buffered events and onDone will clear loading. If the
    // task expired (404), onError clears state with a soft message.
    setLoading(true);

    // Minimal ChatRequest for the stream parser. permissionMode matters
    // for plan vs allow routing; the rest are inert on a GET attach.
    const request: ChatRequest = {
      message: "",
      requestId: tid,
      sessionId: state.sessionId ?? undefined,
      workingDirectory,
      permissionMode,
    };
    void attachToTask(tid, state.lastSeq + 1, request, streamCallbacks());
  }, [
    isConnected,
    state.currentRequestId,
    state.lastSeq,
    state.sessionId,
    workingDirectory,
    permissionMode,
    attachToTask,
    setLoading,
    streamCallbacks,
    stateRef,
  ]);

  // Actually pull a WhatsApp-originated task into this panel: render the
  // user's prompt as a "you" bubble (the task stream only carries
  // assistant/tool events, so without this the user's own message would
  // never appear) and attach to the task's event stream.
  const runWhatsAppAttach = useCallback(
    (taskId: string, userMessage?: string) => {
      const text = (userMessage ?? "").trim();
      if (text) addMessage(createUserMessage(text));
      setLoading(true);
      setCurrentRequestId(taskId);
      const req = {
        message: "",
        requestId: taskId,
        sessionId: stateRef.current.sessionId ?? undefined,
        workingDirectory,
        permissionMode,
      };
      void attachToTask(taskId, 0, req, streamCallbacks());
    },
    [workingDirectory, permissionMode, attachToTask, streamCallbacks, setLoading, setCurrentRequestId, stateRef, addMessage]
  );

  // Keep attachWhatsAppTaskRef current so the SSE handler below always
  // has fresh callbacks without recreating the EventSource.
  useEffect(() => {
    attachWhatsAppTaskRef.current = (taskId: string, userMessage?: string) => {
      if (seenWhatsAppTaskRef.current.has(taskId)) return; // de-dupe
      seenWhatsAppTaskRef.current.add(taskId);
      // If the panel is mid-stream, DEFER (don't drop) — attach when idle so
      // every turn of a back-to-back WhatsApp burst shows up, in order.
      if (stateRef.current.isLoading) {
        pendingWhatsAppRef.current.push({ taskId, userMessage });
        return;
      }
      runWhatsAppAttach(taskId, userMessage);
    };
  }, [runWhatsAppAttach, stateRef]);

  // Drain the deferred-WhatsApp queue whenever the panel goes idle: attach
  // the next queued turn (which flips isLoading back on), then the next when
  // that one finishes — so a burst replays into the panel one turn at a time.
  useEffect(() => {
    if (state.isLoading) return;
    if (pendingWhatsAppRef.current.length === 0) return;
    const next = pendingWhatsAppRef.current.shift();
    if (next) runWhatsAppAttach(next.taskId, next.userMessage);
  }, [state.isLoading, runWhatsAppAttach]);

  const fetchAndShowPorts = useCallback(async () => {
    const placeholderId = `sys_${Date.now()}`;
    addMessage({
      id: placeholderId,
      type: "system",
      content: "Scanning running web servers…",
      timestamp: Date.now(),
    });
    try {
      const res = await fetch(portScanUrl());
      const data = (await res.json()) as { ports: ScannedPort[] };
      const ports = data.ports ?? [];
      if (ports.length === 0) {
        addMessage({
          id: `sys_${Date.now()}_r`,
          type: "system",
          content: "No running web servers detected.",
          timestamp: Date.now(),
        });
        return;
      }
      const lines = ports.map((p) => {
        const name = p.title || p.appLabel || (p.processName ?? "").replace(/\.exe$/i, "") || "Server";
        return `- **${name}** → http://${INSTANCE_IP}:${p.port}`;
      });
      addMessage({
        id: `asst_${Date.now()}`,
        type: "chat",
        role: "assistant",
        content: `Found ${ports.length} running web server${ports.length === 1 ? "" : "s"}:\n\n${lines.join("\n")}`,
        timestamp: Date.now(),
      });
    } catch (err) {
      addMessage({
        id: `err_${Date.now()}`,
        type: "error",
        content: `Failed to scan ports: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      });
    }
  }, [addMessage]);

  const runSend = useCallback(
    (message: string, attachments: Attachment[]) => {
      const imageAttachments = attachments.filter((a) => a.kind === "image");
      const otherAttachments = attachments.filter((a) => a.kind !== "image");

      // Images travel as proper multimodal content blocks (base64) to the
      // SDK so Claude actually SEES them — not as file-path mentions, which
      // it would then try to Read off disk and fail. Non-image attachments
      // still get a text mention since we don't have a binary path for
      // them.
      let composed = message;
      if (otherAttachments.length > 0) {
        const lines = otherAttachments.map((a) =>
          `- file: ${a.name}${a.meta ? ` (${a.meta})` : ""}`
        );
        composed = [message, message ? "" : null, "[attached]", ...lines]
          .filter((s) => s !== null)
          .join("\n");
      }
      if (!composed.trim() && imageAttachments.length === 0) return;

      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // User-visible message in the chat history. Image attachments render
      // as inline thumbnails (data URLs collected from each Attachment's
      // preview), so the transcript stays clean — no "[1 image attached]"
      // / filename noise above the prompt text.
      const imagePreviewUrls = imageAttachments
        .map((a) => a.preview)
        .filter((p): p is string => !!p);
      // Snapshot the message count BEFORE appending the user msg so the
      // onDone scan starts at this turn's user message and skips every
      // prior tool call. (length-based, not id-based, so it works even
      // after a /clear or history restore.)
      turnStartIndexRef.current = stateRef.current.messages.length;
      const isFirstUserMsg = !stateRef.current.messages.some((m) => m.role === "user");
      addMessage(createUserMessage(composed, imagePreviewUrls));
      if (isFirstUserMsg && onFirstMessage && message.trim()) {
        onFirstMessage(message.trim());
      }

      setCurrentRequestId(requestId);
      // Reset stream seq cursor — this is a brand-new server task that
      // starts emitting events at seq 0. setLastSeq is monotonic-only,
      // so use the explicit reset path.
      resetSeqCursor();
      setLoading(true);
      setPermissionRequest(null);
      setPlanRequest(null);

      // Encode images as base64 before sending to the backend. Sequential
      // is fine — the files are typically one screenshot, and parallel
      // FileReader work doesn't usually beat sequential by much.
      void (async () => {
        const encoded = await Promise.all(
          imageAttachments.map(async (a) => {
            const { base64, mediaType } = await readFileAsBase64(a.file);
            return { name: a.name, base64, mediaType };
          })
        );
        send(
          {
            message: composed,
            requestId,
            sessionId: state.sessionId ?? undefined,
            workingDirectory,
            permissionMode,
            attachments: encoded.length > 0 ? encoded : undefined,
          },
          streamCallbacks()
        );
      })();
    },
    [
      state.sessionId,
      workingDirectory,
      permissionMode,
      send,
      addMessage,
      setCurrentRequestId,
      resetSeqCursor,
      setLoading,
      streamCallbacks,
      stateRef,
      onFirstMessage,
    ]
  );

  // Public send entry point. If a turn is already in flight, the message is
  // queued instead of dropped (the old behavior was a silent `return`); the
  // drain effect below sends it as soon as the current turn — and any
  // earlier queued messages — finish. Otherwise it sends immediately.
  const handleSend = useCallback(
    (message: string, attachments: Attachment[]) => {
      const hasContent = message.trim().length > 0 || attachments.length > 0;
      if (!hasContent) return;
      if (stateRef.current.isLoading) {
        setQueue((q) => [
          ...q,
          {
            id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            message,
            attachments,
          },
        ]);
        return;
      }
      runSend(message, attachments);
    },
    [runSend, stateRef]
  );

  const cancelQueued = useCallback((id: string) => {
    setQueue((q) => q.filter((item) => item.id !== id));
  }, []);

  // Drain the queue: when the panel goes idle (and no modal is blocking),
  // pop the next queued prompt and send it. Guarded against the compact
  // handshake and any open permission/question modal so a queued message
  // never races ahead of a decision the user still owes.
  useEffect(() => {
    if (state.isLoading) return;
    if (queue.length === 0) return;
    if (
      askQuestion ||
      permissionRequest ||
      planRequest ||
      isCompacting ||
      pendingCompactRef.current
    ) {
      return;
    }
    const next = queue[0];
    setQueue((q) => q.slice(1));
    runSend(next.message, next.attachments);
  }, [
    state.isLoading,
    queue,
    askQuestion,
    permissionRequest,
    planRequest,
    isCompacting,
    runSend,
  ]);

  // Expose handleSend through a ref so handleCompact (defined earlier
  // for ordering) can invoke it. Re-pointed on each handleSend
  // identity change — cheap, runs once per render.
  handleSendRef.current = handleSend;

  const handleAskUserQuestionSubmit = useCallback(
    (answers: Record<string, string>) => {
      const lines = Object.entries(answers).map(
        ([q, a]) => `- ${q}\n  → ${a}`
      );
      const message =
        `Here are my answers to your question${lines.length === 1 ? "" : "s"}:\n\n` +
        lines.join("\n") +
        `\n\nPlease continue.`;
      // eslint-disable-next-line no-console
      console.log("[askUserQuestion:submit]", {
        answers,
        messagePreview: message.slice(0, 200),
      });
      addMessage({
        id: `sys_${Date.now()}`,
        type: "system",
        content:
          `Submitting answer${lines.length === 1 ? "" : "s"} to Claude:\n` +
          lines.join("\n"),
        timestamp: Date.now(),
      });
      setAskQuestion(null);
      handleSend(message, []);
    },
    [handleSend, addMessage]
  );

  const handleAskUserQuestionCancel = useCallback(() => {
    // eslint-disable-next-line no-console
    console.log("[askUserQuestion:cancel]");
    addMessage({
      id: `sys_${Date.now()}`,
      type: "system",
      content: "Question modal cancelled. Send a follow-up message to continue.",
      timestamp: Date.now(),
    });
    setAskQuestion(null);
  }, [addMessage]);

  // Slugs we've recently notified the AI about — prevents a double-notify
  // when a pack is installed via the modal (which calls this directly) AND
  // arrives via SSE moments later. 30-second TTL is plenty.
  const recentlyNotifiedPacks = useRef<Map<string, number>>(new Map());

  const handlePackInstalled = useCallback(
    (pack: { name: string; slug: string; description?: string; hasInstall: boolean; installedAt: string }) => {
      const now = Date.now();
      const last = recentlyNotifiedPacks.current.get(pack.slug);
      if (last && now - last < 30_000) return;
      recentlyNotifiedPacks.current.set(pack.slug, now);

      addMessage({
        id: `sys_${now}`,
        type: "system",
        content: `Environment pack "${pack.name}" installed at ${pack.installedAt}.`,
        timestamp: now,
      });

      // The system prompt already directs the model to "follow packs
      // verbatim, don't substitute". This message ties THAT directive to
      // THIS specific newly-installed pack so the model can't claim it
      // didn't know.
      const desc = pack.description ? `\n\nPack description: ${pack.description}` : "";
      const installSteps = pack.hasInstall
        ? `\n\nThis pack includes an INSTALL.md. Read ~/.claude/skills/${pack.slug}/INSTALL.md and run the install steps it describes using your shell tools. Confirm with me before each command that modifies the system. After install completes, run a brief verification and summarize what was installed.`
        : `\n\nThis pack has no INSTALL.md, so no install steps are needed right now.`;

      const message =
        `[SYSTEM NOTIFICATION] A new environment pack "${pack.name}" was just installed at ~/.claude/skills/${pack.slug}/.${desc}` +
        installSteps +
        `\n\nFrom now on in our conversation: ` +
        `when *I* leave a tool choice open (e.g. "give me a database viewer"), ` +
        `default to this pack's recommendations instead of picking on your own. ` +
        `If you'd prefer something else over the pack's choice, tell me first ` +
        `and wait for my reply.` +
        `\n\nIf I explicitly ask for a different tool (e.g. "install pgweb"), ` +
        `just do what I asked — don't push the pack's choice. You can mention ` +
        `the conflict once after the fact, briefly, then drop it.` +
        `\n\nStart by calling list_environment_packs (and Read ~/.claude/skills/${pack.slug}/SKILL.md if you need detail) to confirm what was installed, then continue the current task — or, if no task is in flight, just acknowledge.`;
      handleSend(message, []);
    },
    [addMessage, handleSend]
  );

  // Listen for pack-install events from any path (CLI / API / modal).
  // The modal also calls handlePackInstalled directly for immediate UX,
  // but the de-dup map above prevents a double-message.
  useEffect(() => {
    // Only the active session reacts to global side-effect events. Inactive
    // panels stay mounted (their server task keeps streaming), but a single
    // pack-install / WhatsApp event must trigger exactly one panel — the one
    // the user is looking at — not N duplicate notifications/hijacks.
    if (!active) return;
    const es = new EventSource(eventsUrl());
    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data) as
          | { type: "pack_installed"; name: string; slug: string; description: string; hasInstall: boolean; installedAt: string }
          | { type: "task_started"; taskId: string; origin: string; userMessage?: string }
          | { type: string };
        if (evt.type === "pack_installed") {
          const p = evt as Extract<typeof evt, { type: "pack_installed" }>;
          handlePackInstalled({
            name: p.name,
            slug: p.slug,
            description: p.description,
            hasInstall: p.hasInstall,
            installedAt: p.installedAt,
          });
        } else if (evt.type === "task_started") {
          const t = evt as Extract<typeof evt, { type: "task_started" }>;
          if (t.origin === "whatsapp") {
            attachWhatsAppTaskRef.current(t.taskId, t.userMessage);
          }
        }
      } catch {
        // ignore malformed events
      }
    };
    return () => es.close();
  }, [handlePackInstalled, active]);

  const toggleMode = useCallback(() => {
    setPermissionMode((prev) =>
      prev === "default" ? "plan"
      : prev === "plan" ? "acceptEdits"
      : prev === "acceptEdits" ? "bypassPermissions"
      : "default"
    );
  }, []);

  const handlePermissionAllow = useCallback(
    async (persist: boolean) => {
      if (!permissionRequest) return;
      const req = permissionRequest;
      setPermissionRequest(null);

      // "Allow permanently" should mean "stop asking me for THIS TOOL for
      // the rest of the session" — what the user actually expects from the
      // label. The SDK's `suggestions` are intentionally narrow (specific
      // command patterns, specific paths, sometimes flagged for obfuscation
      // like the Bash "${VAR}" expansion gate). Passing those back as-is
      // only allows that one exact pattern — the next slightly-different
      // Bash command re-prompts, which feels broken.
      //
      // Instead, build a single broad `addRules` PermissionUpdate that
      // allows the whole tool with NO ruleContent (rule matches any input)
      // and merge whatever the SDK suggested on top for extra coverage.
      // Destination "session" keeps the scope local to this chat — won't
      // leak into the user's global ~/.claude config.
      const broadRule = {
        type: "addRules" as const,
        rules: [{ toolName: req.toolName }],
        behavior: "allow" as const,
        destination: "session" as const,
      };
      const body = persist
        ? {
            behavior: "allow" as const,
            updatedPermissions: [broadRule, ...(req.suggestions ?? [])],
          }
        : { behavior: "allow" as const };

      // eslint-disable-next-line no-console
      console.log("[permission:allow]", {
        id: req.id,
        tool: req.toolName,
        toolUseId: req.toolUseId,
        persist,
        broadAllow: persist,
        suggestionCount: req.suggestions?.length ?? 0,
      });
      addMessage({
        id: `sys_${Date.now()}`,
        type: "system",
        content:
          `Allowing ${req.displayName ?? req.toolName} ` +
          `${persist ? "for the rest of this session — won't ask again" : "for this turn"}.`,
        timestamp: Date.now(),
      });

      try {
        const res = await fetch(permissionDecisionUrl(req.id), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          addMessage({
            id: `err_${Date.now()}`,
            type: "error",
            content: `Failed to send permission decision (HTTP ${res.status}). The pending tool call may hang.`,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        addMessage({
          id: `err_${Date.now()}`,
          type: "error",
          content: `Failed to send permission decision: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
        });
      }
    },
    [permissionRequest, addMessage]
  );

  const handlePermissionDeny = useCallback(async () => {
    if (!permissionRequest) return;
    const req = permissionRequest;
    setPermissionRequest(null);

    // eslint-disable-next-line no-console
    console.log("[permission:deny]", {
      id: req.id,
      tool: req.toolName,
      toolUseId: req.toolUseId,
    });
    addMessage({
      id: `sys_${Date.now()}`,
      type: "system",
      content: `Denied ${req.displayName ?? req.toolName} — Claude will try a different approach.`,
      timestamp: Date.now(),
    });

    try {
      await fetch(permissionDecisionUrl(req.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ behavior: "deny", message: "Denied by user" }),
      });
    } catch (err) {
      addMessage({
        id: `err_${Date.now()}`,
        type: "error",
        content: `Failed to send deny decision: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: Date.now(),
      });
    }
  }, [permissionRequest, addMessage]);

  const handlePlanAcceptAuto = useCallback(() => {
    setPermissionMode("acceptEdits");
    setPlanRequest(null);
  }, []);

  const handlePlanAcceptManual = useCallback(() => {
    setPermissionMode("default");
    setPlanRequest(null);
  }, []);

  const handlePlanKeep = useCallback(() => {
    setPlanRequest(null);
  }, []);

  const handleHistorySelect = useCallback(
    async (sessionId: string, encodedProjectName: string) => {
      setShowHistory(false);
      setSessionId(sessionId);
      // Show a loading hint while we fetch
      setMessages([
        {
          id: `sys_load_${Date.now()}`,
          type: "system",
          content: `Loading conversation ${sessionId.slice(0, 8)}…`,
          timestamp: Date.now(),
        },
      ]);

      try {
        const res = await fetch(conversationUrl(encodedProjectName, sessionId));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: { messages?: unknown[] } = await res.json();
        const converted = convertHistoryMessages(data.messages ?? []);
        setMessages(converted);
      } catch (err) {
        setMessages([
          {
            id: `err_${Date.now()}`,
            type: "error",
            content:
              err instanceof Error
                ? `Failed to load history: ${err.message}`
                : "Failed to load history",
            timestamp: Date.now(),
          },
        ]);
      }
    },
    [setSessionId, setMessages]
  );

  const handleSlashCommand = useCallback(
    (cmd: SlashCommand) => {
      switch (cmd) {
        case "clear":
          setMessages([]);
          setSessionId("");
          forgetLastSession(persistCwd);
          setPermissionRequest(null);
          setPlanRequest(null);
          setQueue([]);
          setTokenUsage({ inputTokens: 0, outputTokens: 0 });
          break;
        case "history":
          setShowHistory(true);
          break;
        case "project":
          if (onChangeProject) setShowProjectPicker(true);
          break;
        case "ports":
          if (tabCtx) {
            tabCtx.openTab("aiide://ports", "Ports");
          } else {
            void fetchAndShowPorts();
          }
          break;
        case "account":
          setAccountModalFocus("account");
          setShowAccountModal(true);
          break;
        case "usage":
          setAccountModalFocus("usage");
          setShowAccountModal(true);
          break;
        case "logout":
          // Clear chat state first so the user doesn't see stale messages
          // flash through behind the ConnectScreen during the auth wipe.
          setMessages([]);
          setSessionId("");
          forgetLastSession(persistCwd);
          setPermissionRequest(null);
          setPlanRequest(null);
          setQueue([]);
          setTokenUsage({ inputTokens: 0, outputTokens: 0 });
          void connection.disconnect();
          break;
        case "help":
          // handled inline in ChatInput (inserts a prompt)
          break;
      }
    },
    [
      setMessages,
      setSessionId,
      onChangeProject,
      fetchAndShowPorts,
      tabCtx,
      connection,
      workingDirectory,
      persistCwd,
    ]
  );

  return (
    <aside className="chat-panel">
      <div className="chat-panel-title">
        <span className="chat-panel-heading">
          <MiniBot frozen />
          <span>CLAUDE</span>
          {workingDirectory && (
            <span className="chat-working-dir" title={workingDirectory}>
              {workingDirectory.split(/[/\\]/).filter(Boolean).pop()}
            </span>
          )}
        </span>
        <span className="chat-panel-actions">
          <CompactRing
            percent={tokenUsage.inputTokens / MODEL_CONTEXT_LIMIT}
            busy={isCompacting || state.isLoading}
            onClick={handleCompact}
          />
          {onChangeProject && (
            <button
              type="button"
              className="chat-header-btn"
              onClick={() => setShowProjectPicker(true)}
              title={workingDirectory ?? "Select working directory"}
              aria-label="Select project"
            >
              <IconFolder />
            </button>
          )}
          <button
            type="button"
            className="chat-header-btn"
            onClick={() => setShowHistory((s) => !s)}
            title="Session history"
            aria-label="Session history"
          >
            <IconHistory />
          </button>
          <button
            type="button"
            className="chat-header-btn"
            onClick={async () => {
              if (state.messages.length === 0) return;
              const ok = await confirm({
                title: "Delete chat history",
                message:
                  "Delete the current chat history? This can't be undone.",
                confirmLabel: "Delete",
                danger: true,
              });
              if (!ok) return;
              setMessages([]);
              setSessionId("");
              forgetLastSession(persistCwd);
              setPermissionRequest(null);
              setPlanRequest(null);
              setQueue([]);
              setTokenUsage({ inputTokens: 0, outputTokens: 0 });
            }}
            disabled={state.messages.length === 0}
            title="Clear chat history"
            aria-label="Clear chat history"
          >
            <IconTrash />
          </button>
          <button
            type="button"
            className="chat-header-btn"
            onClick={() => setShowWhatsAppModal(true)}
            title="Link WhatsApp"
            aria-label="Link WhatsApp"
          >
            <IconWhatsApp />
          </button>
          <button
            type="button"
            className="chat-header-btn"
            onClick={() => {
              setMessages([]);
              setSessionId("");
              forgetLastSession(persistCwd);
              setQueue([]);
              setTokenUsage({ inputTokens: 0, outputTokens: 0 });
            }}
            title="New chat"
            aria-label="New chat"
          >
            <IconPlus />
          </button>
        </span>
      </div>

      {connection.isInitialCheck ? (
        <ConnectionCheckLoader />
      ) : !isConnected ? (
        <ConnectScreen connection={connection} />
      ) : (
        <>
      {showHistory && (
        <HistoryView
          workingDirectory={workingDirectory}
          onSelect={handleHistorySelect}
          onClose={() => setShowHistory(false)}
        />
      )}

      <EnvironmentPackModal
        open={showPackModal}
        onClose={() => setShowPackModal(false)}
        onInstalled={handlePackInstalled}
        onCreateRequest={(message) => handleSend(message, [])}
      />

      <AskUserQuestionModal
        request={askQuestion}
        onCancel={handleAskUserQuestionCancel}
        onSubmit={handleAskUserQuestionSubmit}
      />

      <WhatsAppLinkModal
        open={showWhatsAppModal}
        onClose={() => setShowWhatsAppModal(false)}
      />

      {showProjectPicker && onChangeProject && (
        <div className="project-overlay" onClick={() => setShowProjectPicker(false)}>
          <div onClick={(e) => e.stopPropagation()}>
            <ProjectSelector
              currentPath={workingDirectory}
              onSelect={(path) => {
                onChangeProject(path);
                setShowProjectPicker(false);
              }}
              onClose={() => setShowProjectPicker(false)}
            />
          </div>
        </div>
      )}

      <ChatMessages
        messages={state.messages}
        onReuse={handleReuseMessage}
        showToolDetails={showToolDetails}
      />

      {intentGuardRequest && (
        <IntentGuardPanel
          request={intentGuardRequest}
          onResolved={() => setIntentGuardRequest(null)}
        />
      )}

      {permissionRequest && (
        <PermissionInputPanel
          request={permissionRequest}
          onAllow={handlePermissionAllow}
          onDeny={handlePermissionDeny}
        />
      )}

      {planRequest && (
        <PlanPermissionInputPanel
          onAcceptWithAutoEdits={handlePlanAcceptAuto}
          onAcceptManual={handlePlanAcceptManual}
          onKeepPlanning={handlePlanKeep}
        />
      )}

      {anomalyAlert && (
        <AnomalyAlertBanner
          alert={anomalyAlert}
          onDismiss={() => setAnomalyAlert(null)}
        />
      )}

      {state.isLoading && (
        <div className="typing-bar">
          <TypingIndicator messages={state.messages} />
        </div>
      )}

      {queue.length > 0 && (
        <div className="chat-queue" aria-label="Queued messages">
          <span className="chat-queue-label">
            Queued · auto-sends next ({queue.length})
          </span>
          {queue.map((item, i) => (
            <div className="chat-queue-item" key={item.id}>
              <span className="chat-queue-num">{i + 1}</span>
              <span className="chat-queue-text" title={item.message}>
                {item.message.trim() ||
                  (item.attachments.length > 0
                    ? `[${item.attachments.length} attachment${
                        item.attachments.length === 1 ? "" : "s"
                      }]`
                    : "(empty)")}
              </span>
              <button
                type="button"
                className="chat-queue-cancel"
                onClick={() => cancelQueued(item.id)}
                title="Remove from queue"
                aria-label="Remove queued message"
              >
                <svg viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      <ChatInput
        ref={setChatInputRef}
        onSend={handleSend}
        onStop={handleStop}
        onSlashCommand={handleSlashCommand}
        onAddEnvironmentPack={() => setShowPackModal(true)}
        isLoading={state.isLoading}
        permissionMode={permissionMode}
        onToggleMode={toggleMode}
        showToolDetails={showToolDetails}
        onToggleToolDetails={() => setShowToolDetails((v) => !v)}
      />
        </>
      )}

      {/* Themed confirm dialog — scoped to the chat panel so it overlays the
          panel (never occluded by the Electron tab views over the editor). */}
      <ConfirmDialog request={confirmRequest} onResolve={resolveConfirm} />

      {/* /account + /usage panel — signed-in account and session token usage. */}
      <AccountUsageModal
        open={showAccountModal}
        onClose={() => setShowAccountModal(false)}
        focus={accountModalFocus}
        connected={isConnected}
        authMethod={connection.status === "connected" ? connection.authMethod ?? null : null}
        apiKeyMasked={connection.status === "connected" ? connection.apiKeyMasked : null}
        version={connection.status === "connected" ? connection.version : undefined}
        workingDirectory={workingDirectory}
        inputTokens={tokenUsage.inputTokens}
        outputTokens={tokenUsage.outputTokens}
        contextLimit={MODEL_CONTEXT_LIMIT}
      />
    </aside>
  );
}

/* ===== Inline icons (Codicon-inspired) ===== */

function IconFolder() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.5 3.5h4l1.5 1.5h7.5v8.5a.5.5 0 0 1-.5.5H1.5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconHistory() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 3a5 5 0 1 1-4.546 2.916M3 3v3h3M8 5v3l2 1.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 3v10M3 8h10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.6 8a1.5 1.5 0 0 0 1.5 1.4h2.8a1.5 1.5 0 0 0 1.5-1.4l.6-8M7 7v4M9 7v4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconWhatsApp() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.359.101 11.892c0 2.096.547 4.142 1.588 5.945L0 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.582 0 11.94-5.359 11.943-11.893a11.821 11.821 0 00-3.495-8.453z" />
    </svg>
  );
}

function IconPower() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M5.5 4a4.5 4.5 0 1 0 5 0M8 2v6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Circular progress button — fills based on `percent` (0..1). Click
 * to compact. Color shifts from accent blue → amber at ~70% → red at
 * 90% so the user gets a passive warning that they're approaching the
 * limit before anything bad happens. Auto-compact is OFF; this button
 * is the ONLY way to compact.
 */
function CompactRing({
  percent,
  busy,
  onClick,
}: {
  percent: number;
  busy: boolean;
  onClick: () => void;
}) {
  const clamped = Math.max(0, Math.min(1, percent));
  // SVG geometry: circle radius 6 in a 16x16 viewBox → circumference 2πr ≈ 37.7
  const r = 6;
  const c = 2 * Math.PI * r;
  const dashOffset = c * (1 - clamped);
  const color =
    clamped >= 0.9 ? "var(--vsc-error)"
    : clamped >= 0.7 ? "var(--vsc-warning, #d7a55f)"
    : "var(--vsc-accent)";
  const pct = Math.round(clamped * 100);
  return (
    <button
      type="button"
      className="chat-header-btn compact-ring-btn"
      onClick={onClick}
      disabled={busy}
      title={
        busy
          ? "Compacting…"
          : `Context: ${pct}% used — click to compact (manual only, auto-compact is off)`
      }
      aria-label={`Compact context (${pct}% used)`}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
        {/* Track ring (faint) */}
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeWidth="1.8"
        />
        {/* Progress arc — rotated so 0% sits at the top, fills clockwise */}
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={dashOffset}
          transform="rotate(-90 8 8)"
          style={{ transition: "stroke-dashoffset 0.3s ease, stroke 0.3s ease" }}
        />
      </svg>
    </button>
  );
}

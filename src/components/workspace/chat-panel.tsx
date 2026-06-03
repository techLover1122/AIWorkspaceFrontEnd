"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AskUserQuestionRequest,
  ChatMessage,
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
import { HistoryView } from "../chat/HistoryView";
import { EnvironmentPackModal, type InstalledPack } from "../chat/EnvironmentPackModal";
import { AskUserQuestionModal } from "../chat/AskUserQuestionModal";
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
};

export function ChatPanel({ workingDirectory, onChangeProject, chatInputRef: externalChatInputRef }: ChatPanelProps) {
  const tabCtx = useWorkspaceTab();
  const {
    state,
    addMessage,
    appendToLastMessage,
    finalizeLastMessage,
    setSessionId,
    setLoading,
    setCurrentRequestId,
    setMessages,
    stateRef,
  } = useChatState();
  const { send, abort } = useClaudeStreaming();

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
  const [showHistory, setShowHistory] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [showPackModal, setShowPackModal] = useState(false);
  const [askQuestion, setAskQuestion] = useState<AskUserQuestionRequest | null>(null);
  // Tool-call internals (TodoWrite payloads, tool_result blobs, thinking
  // blocks) stay hidden by default — the user explicitly toggles them on
  // via the eye icon in the composer when they want to debug a turn.
  const [showToolDetails, setShowToolDetails] = useState(false);
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
    if (state.sessionId) rememberLastSession(workingDirectory, state.sessionId);
  }, [state.sessionId, workingDirectory]);

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
    if (!isConnected || !workingDirectory) return;
    if (restoredForRef.current === workingDirectory) return;
    restoredForRef.current = workingDirectory;

    const lastSessionId = loadLastSessionMap()[workingDirectory];
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
          forgetLastSession(workingDirectory);
          return;
        }
        const convRes = await fetch(
          conversationUrl(project.encodedName, lastSessionId)
        );
        if (!convRes.ok) {
          // 404 means the on-disk transcript is gone (deleted/rotated);
          // anything else is transient and worth keeping for next try.
          if (convRes.status === 404) forgetLastSession(workingDirectory);
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
  }, [isConnected, workingDirectory, setSessionId, setMessages, stateRef]);

  const handleReuseMessage = useCallback((text: string) => {
    chatInputRef.current?.setDraft(text);
  }, []);

  const handleStop = useCallback(() => {
    if (state.currentRequestId) {
      abort(state.currentRequestId);
      setLoading(false);
      setCurrentRequestId(null);
    }
  }, [state.currentRequestId, abort, setLoading, setCurrentRequestId]);

  const streamCallbacks = useCallback(
    () => ({
      onMessage: (msg: ChatMessage) => addMessage(msg),
      onAppend: (chunk: string) => appendToLastMessage(chunk),
      onFinalize: () => finalizeLastMessage(),
      onSessionId: (id: string) => setSessionId(id),
      onPermissionRequest: (req: PermissionRequest) => {
        if (req.isPlanMode) {
          setPlanRequest(req);
        } else {
          setPermissionRequest(req);
        }
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
    [addMessage, appendToLastMessage, finalizeLastMessage, setSessionId, setLoading, setCurrentRequestId, state.currentRequestId, abort, stateRef, tabCtx]
  );

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

  const handleSend = useCallback(
    (message: string, attachments: Attachment[]) => {
      if (state.isLoading) return;

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
      addMessage(createUserMessage(composed, imagePreviewUrls));

      setCurrentRequestId(requestId);
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
      state.isLoading,
      state.sessionId,
      workingDirectory,
      permissionMode,
      send,
      addMessage,
      streamCallbacks,
      fetchAndShowPorts,
      tabCtx,
    ]
  );

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
    const es = new EventSource(eventsUrl());
    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data) as
          | { type: "pack_installed"; name: string; slug: string; description: string; hasInstall: boolean; installedAt: string }
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
        }
      } catch {
        // ignore malformed events
      }
    };
    return () => es.close();
  }, [handlePackInstalled]);

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
          forgetLastSession(workingDirectory);
          setPermissionRequest(null);
          setPlanRequest(null);
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
        case "logout":
          // Clear chat state first so the user doesn't see stale messages
          // flash through behind the ConnectScreen during the auth wipe.
          setMessages([]);
          setSessionId("");
          forgetLastSession(workingDirectory);
          setPermissionRequest(null);
          setPlanRequest(null);
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
            onClick={() => {
              if (state.messages.length === 0) return;
              const ok = window.confirm(
                "Delete the current chat history? This can't be undone."
              );
              if (!ok) return;
              setMessages([]);
              setSessionId("");
              forgetLastSession(workingDirectory);
              setPermissionRequest(null);
              setPlanRequest(null);
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
            onClick={() => {
              setMessages([]);
              setSessionId("");
              forgetLastSession(workingDirectory);
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

      {state.isLoading && (
        <div className="typing-bar">
          <TypingIndicator messages={state.messages} />
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

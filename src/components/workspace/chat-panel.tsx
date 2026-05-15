"use client";

import { useCallback, useRef, useState } from "react";
import type { ChatMessage, PermissionMode, PermissionRequest } from "../../types/types";
import { useClaudeStreaming } from "../../hooks/useClaudeStreaming";
import { useChatState, createUserMessage } from "../../hooks/useChatState";
import { conversationUrl } from "../../constant/api";
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
import { MiniBot } from "../chat/MiniBot";
import { TypingIndicator } from "../chat/AnimatedAIBot";
import { ConnectScreen } from "../chat/ConnectScreen";
import { ConnectionCheckLoader } from "../chat/ConnectionCheckLoader";
import { ProjectSelector } from "../project/ProjectSelector";
import { useConnectionStatus } from "../../hooks/useConnectionStatus";

type ChatPanelProps = {
  workingDirectory?: string;
  onChangeProject?: (path: string) => void;
};

export function ChatPanel({ workingDirectory, onChangeProject }: ChatPanelProps) {
  const {
    state,
    addMessage,
    appendToLastMessage,
    finalizeLastMessage,
    setSessionId,
    setLoading,
    setCurrentRequestId,
    setMessages,
  } = useChatState();
  const { send, abort } = useClaudeStreaming();

  const [permissionMode, setPermissionMode] = useState<PermissionMode>("default");
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [planRequest, setPlanRequest] = useState<PermissionRequest | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const chatInputRef = useRef<ChatInputHandle>(null);

  const connection = useConnectionStatus();
  const isConnected = connection.status === "connected";

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

  const handleSend = useCallback(
    (message: string, attachments: Attachment[]) => {
      if (state.isLoading) return;

      // Compose the prompt — append a note describing any attachments. (Image
      // bytes aren't yet forwarded to the SDK; the model will only see the
      // filenames.)
      let composed = message;
      if (attachments.length > 0) {
        const lines = attachments.map((a) =>
          `- ${a.kind === "image" ? "image" : "file"}: ${a.name}${a.meta ? ` (${a.meta})` : ""}`
        );
        composed = [
          message,
          message ? "" : null,
          "[attached]",
          ...lines,
        ]
          .filter((s) => s !== null)
          .join("\n");
      }
      if (!composed.trim()) return;

      const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // Only the user message is added eagerly. The assistant message is
      // created lazily by the streaming hook as soon as the first text
      // chunk arrives — that way system "init"/"result" metadata messages
      // get rendered in the natural order (init first, then assistant).
      addMessage(createUserMessage(composed));

      setCurrentRequestId(requestId);
      setLoading(true);
      setPermissionRequest(null);
      setPlanRequest(null);

      send(
        {
          message: composed,
          requestId,
          sessionId: state.sessionId ?? undefined,
          allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
          workingDirectory,
          permissionMode,
        },
        {
          onMessage: (msg: ChatMessage) => addMessage(msg),
          onAppend: (chunk: string) => appendToLastMessage(chunk),
          onFinalize: () => finalizeLastMessage(),
          onSessionId: (id: string) => setSessionId(id),
          onPermissionError: (req: PermissionRequest) => {
            if (req.isPlanMode) {
              setPlanRequest(req);
            } else {
              setPermissionRequest(req);
            }
          },
          onDone: () => {
            setLoading(false);
            setCurrentRequestId(null);
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
        }
      );
    },
    [
      state.isLoading,
      state.sessionId,
      allowedTools,
      workingDirectory,
      permissionMode,
      send,
      addMessage,
      appendToLastMessage,
      finalizeLastMessage,
      setSessionId,
      setLoading,
      setCurrentRequestId,
    ]
  );

  const toggleMode = useCallback(() => {
    setPermissionMode((prev) =>
      prev === "default" ? "plan" : prev === "plan" ? "acceptEdits" : "default"
    );
  }, []);

  const handlePermissionAllow = useCallback(
    (persist: boolean) => {
      if (permissionRequest) {
        if (persist) {
          setAllowedTools((prev) => [...prev, permissionRequest.toolName]);
        }
        setPermissionRequest(null);
      }
    },
    [permissionRequest]
  );

  const handlePermissionDeny = useCallback(() => {
    setPermissionRequest(null);
    addMessage({
      id: `sys_${Date.now()}`,
      type: "system",
      content: "Permission denied by user",
      timestamp: Date.now(),
    });
  }, [addMessage]);

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
          setPermissionRequest(null);
          setPlanRequest(null);
          break;
        case "history":
          setShowHistory(true);
          break;
        case "project":
          if (onChangeProject) setShowProjectPicker(true);
          break;
        case "help":
          // handled inline in ChatInput (inserts a prompt)
          break;
      }
    },
    [setMessages, setSessionId, onChangeProject]
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
          {isConnected &&
            connection.status === "connected" &&
            connection.authMethod === "api_key" &&
            connection.apiKeyMasked && (
              <span
                className="chat-auth-chip"
                title="Connected via Anthropic API key"
              >
                <span className="chat-auth-chip-dot" aria-hidden />
                <span className="chat-auth-chip-label">
                  {connection.apiKeyMasked}
                </span>
                <button
                  type="button"
                  className="chat-auth-chip-disconnect"
                  onClick={() => void connection.disconnect()}
                  title="Disconnect API key"
                  aria-label="Disconnect API key"
                >
                  <svg
                    viewBox="0 0 16 16"
                    width="10"
                    height="10"
                    fill="none"
                    aria-hidden
                  >
                    <path
                      d="M4 4l8 8M12 4l-8 8"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </span>
            )}
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
              setMessages([]);
              setSessionId("");
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
          onSelect={handleHistorySelect}
          onClose={() => setShowHistory(false)}
        />
      )}

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

      <ChatMessages messages={state.messages} onReuse={handleReuseMessage} />

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
          <TypingIndicator />
        </div>
      )}

      <ChatInput
        ref={chatInputRef}
        onSend={handleSend}
        onStop={handleStop}
        onSlashCommand={handleSlashCommand}
        isLoading={state.isLoading}
        permissionMode={permissionMode}
        onToggleMode={toggleMode}
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

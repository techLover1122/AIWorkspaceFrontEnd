"use client";

import { memo, useEffect, useRef, useState, useCallback } from "react";
import type { ChatMessage } from "../../types/types";
import { INSTANCE_IP } from "../../constant/api";
import { useWorkspaceTab } from "../../contexts/WorkspaceTabContext";
import { AnimatedAIBot } from "./AnimatedAIBot";
import { MarkdownContent } from "./MarkdownContent";
import {
  displayToolName,
  formatToolArguments,
  prettyToolInput,
} from "../../utils/toolUtils";

/** Extract unique localhost URLs from Claude's text response.
 *  The regex still matches the literal "localhost" because that's what
 *  dev servers print — but the URL we emit for the click chip is
 *  rewritten to use INSTANCE_IP so the link actually works when the
 *  user's browser isn't on the same machine as the dev server. */
function extractLocalhostUrls(text: string): { url: string; port: string }[] {
  const regex = /https?:\/\/localhost:(\d{2,5})(?:\/[^\s)>\]"']*)?/g;
  const seen = new Set<string>();
  const results: { url: string; port: string }[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const base = `http://${INSTANCE_IP}:${match[1]}`;
    if (!seen.has(base)) {
      seen.add(base);
      results.push({ url: base, port: match[1] });
    }
  }
  return results;
}

/** Detect if text contains a "server is now running" signal. */
function isServerStartSignal(text: string): boolean {
  const lower = text.toLowerCase();
  const signals = [
    "local:   http://localhost",   // Vite
    "ready on http://localhost",   // Next.js
    "ready started server on",     // Next.js
    "server running at http",
    "listening on http://localhost",
    "listening on port",
    "server is running",
    "app running at",
    "dev server running",
    "started server",
    "> local:",
  ];
  return signals.some((s) => lower.includes(s));
}

function OpenTabChips({ content, autoOpen }: { content: string; autoOpen?: boolean }) {
  const ctx = useWorkspaceTab();
  const autoOpenedRef = useRef(false);

  useEffect(() => {
    if (!ctx || !autoOpen || autoOpenedRef.current) return;
    if (!isServerStartSignal(content)) return;
    const urls = extractLocalhostUrls(content);
    if (urls.length === 0) return;
    autoOpenedRef.current = true;
    ctx.openTab(urls[0].url, `localhost:${urls[0].port}`);
  }, [content, autoOpen, ctx]);

  if (!ctx) return null;
  const urls = extractLocalhostUrls(content);
  if (urls.length === 0) return null;
  return (
    <div className="msg-open-tab-chips">
      {urls.map(({ url, port }) => (
        <button
          key={url}
          type="button"
          className="msg-open-tab-chip"
          onClick={() => ctx.openTab(url, `localhost:${port}`)}
          title={`Open ${url} in a new tab`}
        >
          <svg viewBox="0 0 14 14" width="12" height="12" fill="none" aria-hidden>
            <rect x="1" y="3" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M6 1h7v7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M8 1l5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          Open :{port}
        </button>
      ))}
    </div>
  );
}

type ChatMessagesProps = {
  messages: ChatMessage[];
  /** Push a previous user message back into the composer for editing/resending. */
  onReuse?: (text: string) => void;
  /** When false (default), hide tool calls / tool results / thinking blocks so
   *  the conversation reads as just the user prompt + the assistant's reply.
   *  Toggled from the composer's eye icon. */
  showToolDetails?: boolean;
};

export function ChatMessages({
  messages,
  onReuse,
  showToolDetails = false,
}: ChatMessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastScrolledUserIdRef = useRef<string | null>(null);

  // Anchor the latest user message to the top of the scroll viewport whenever
  // the user submits a new message. We deliberately do NOT scroll while the
  // assistant streams its reply — that lets the user message stay pinned at
  // the top, matching the Claude.ai / ChatGPT reading pattern instead of the
  // old "always glued to the bottom" behavior.
  const latestUserMsgId = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.type === "chat" && m.role === "user") return m.id;
    }
    return null;
  })();

  useEffect(() => {
    if (!latestUserMsgId) return;
    if (lastScrolledUserIdRef.current === latestUserMsgId) return;
    lastScrolledUserIdRef.current = latestUserMsgId;
    // Defer to next frame so the new <UserMessage> is mounted before we
    // try to scroll to it.
    requestAnimationFrame(() => {
      const el = document.querySelector(
        `[data-msg-id="${CSS.escape(latestUserMsgId)}"]`
      );
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [latestUserMsgId]);

  if (messages.length === 0) {
    return (
      <div className="chat-list chat-list-empty" role="log" aria-live="polite">
        <AnimatedAIBot />
        <div ref={bottomRef} />
      </div>
    );
  }

  return (
    <div className="chat-list" role="log" aria-live="polite">
      {messages.map((msg) => (
        <Message
          key={msg.id}
          message={msg}
          onReuse={onReuse}
          showToolDetails={showToolDetails}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

type MessageProps = {
  message: ChatMessage;
  onReuse?: (text: string) => void;
  showToolDetails: boolean;
};

/**
 * Wrap Message in React.memo so non-streaming messages skip render when the
 * messages array gets a new reference (which happens on every streaming
 * chunk). useChatState.appendToLastMessage only replaces the streaming
 * message object — every other entry keeps its identity, so shallow
 * equality on `message` correctly short-circuits them.
 *
 * Without this, a 200-message chat re-ran ReactMarkdown for all 200 on
 * every text chunk arriving from the SDK — which is what made typing
 * feel glacial in long sessions.
 */
const Message = memo(MessageImpl);

function MessageImpl({
  message,
  onReuse,
  showToolDetails,
}: MessageProps) {
  // Internal AI traces — only shown when the user explicitly enables the
  // detail view from the composer. Default is hidden so the chat reads like
  // a normal conversation instead of dumping TodoWrite/tool JSON in-line.
  if (
    !showToolDetails &&
    (message.type === "tool" ||
      message.type === "tool_result" ||
      message.type === "thinking")
  ) {
    return null;
  }

  switch (message.type) {
    case "chat":
      if (message.role === "user") {
        return (
          <UserMessage
            messageId={message.id}
            content={message.content}
            imageUrls={message.imageUrls}
            onReuse={onReuse}
          />
        );
      }
      // While streaming with no text yet, nothing renders here — the
      // typing indicator above the composer handles the "busy" state.
      if (message.isStreaming && !message.content) {
        return null;
      }
      return (
        <div className="msg-assistant">
          <MarkdownContent
            content={message.content}
            streaming={message.isStreaming}
          />
          {!message.isStreaming && (
            <OpenTabChips content={message.content} autoOpen />
          )}
        </div>
      );

    case "tool": {
      const argSummary = formatToolArguments(message.toolInput);
      const hasDetails = !!message.toolInput && Object.keys(message.toolInput).length > 0;
      return (
        <details className="msg-tool">
          <summary>
            <span className="msg-tool-glyph" aria-hidden>
              ⏵
            </span>
            <span className="msg-tool-name">
              {displayToolName(message.toolName)}
            </span>
            {argSummary && <span className="msg-tool-args">· {argSummary}</span>}
          </summary>
          {hasDetails && (
            <pre className="msg-tool-input">{prettyToolInput(message.toolInput)}</pre>
          )}
        </details>
      );
    }

    case "tool_result": {
      const isError = message.toolUseResult?.isError;
      return (
        <details className={`msg-tool-result ${isError ? "error" : ""}`}>
          <summary>
            <span className="msg-tool-result-status" aria-hidden>
              {isError ? "✗" : "✓"}
            </span>
            <span>{isError ? "Error" : "Result"}</span>
          </summary>
          {message.content && (
            <pre className="msg-tool-result-text">{message.content}</pre>
          )}
        </details>
      );
    }

    case "thinking":
      return (
        <div className="msg-thinking">
          <span className="msg-thinking-glyph" aria-hidden>
            ◐
          </span>
          <span>{message.content}</span>
        </div>
      );

    case "system":
      return <div className="msg-system">{message.content}</div>;

    case "error":
      return (
        <div className="msg-error">
          <span className="msg-error-label">Error:</span>
          {message.content}
        </div>
      );

    default:
      return null;
  }
}

/* ============================================================
   User message card — avatar + "You" label + copy button
   ============================================================ */

type UserMessageProps = {
  messageId: string;
  content: string;
  imageUrls?: string[];
  onReuse?: (text: string) => void;
};

const UserMessage = memo(UserMessageImpl);

function UserMessageImpl({
  messageId,
  content,
  imageUrls,
  onReuse,
}: UserMessageProps) {
  const [copied, setCopied] = useState(false);
  const [zoomedUrl, setZoomedUrl] = useState<string | null>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  const handleReuse = () => onReuse?.(content);

  return (
    <div className="msg-user" data-msg-id={messageId}>
      <div className="msg-user-card">
        <div className="msg-user-meta">
          <span className="msg-user-badge" aria-hidden>
            <svg viewBox="0 0 16 16" fill="none">
              <circle
                cx="8"
                cy="6"
                r="2.6"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <path
                d="M2.8 14c.4-2.4 2.6-3.6 5.2-3.6s4.8 1.2 5.2 3.6"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span className="msg-user-label">You</span>
          <span className="msg-user-actions">
            {onReuse && (
              <button
                type="button"
                className="msg-user-action"
                onClick={handleReuse}
                aria-label="Edit / resend"
                title="Edit / resend"
              >
                <svg viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path
                    d="M11.5 2.5l2 2-7 7-2.5.5.5-2.5 7-7z"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M10 4l2 2"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}
            <button
              type="button"
              className="msg-user-action"
              onClick={handleCopy}
              aria-label="Copy message"
              title={copied ? "Copied" : "Copy"}
            >
            {copied ? (
              <svg viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M3 8.5l3 3 7-7"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" fill="none" aria-hidden>
                <rect
                  x="5"
                  y="5"
                  width="8"
                  height="9"
                  rx="1.2"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
                <path
                  d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
            )}
            </button>
          </span>
        </div>
        {content && <div className="msg-user-text">{content}</div>}
        {imageUrls && imageUrls.length > 0 && (
          <div className="msg-user-images">
            {imageUrls.map((url, i) => (
              <button
                key={i}
                type="button"
                className="msg-user-image-thumb"
                onClick={() => setZoomedUrl(url)}
                title="Click to enlarge"
                aria-label="View attached image"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="attachment" />
              </button>
            ))}
          </div>
        )}
      </div>
      {zoomedUrl && (
        <div
          className="msg-user-image-zoom"
          onClick={() => setZoomedUrl(null)}
          role="dialog"
          aria-modal="true"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoomedUrl} alt="attachment full size" />
        </div>
      )}
    </div>
  );
}

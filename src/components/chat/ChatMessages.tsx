"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../types/types";
import { AnimatedAIBot } from "./AnimatedAIBot";
import { MarkdownContent } from "./MarkdownContent";
import {
  displayToolName,
  formatToolArguments,
  prettyToolInput,
} from "../../utils/toolUtils";

type ChatMessagesProps = {
  messages: ChatMessage[];
  /** Push a previous user message back into the composer for editing/resending. */
  onReuse?: (text: string) => void;
};

export function ChatMessages({ messages, onReuse }: ChatMessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

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
        <Message key={msg.id} message={msg} onReuse={onReuse} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function Message({
  message,
  onReuse,
}: {
  message: ChatMessage;
  onReuse?: (text: string) => void;
}) {
  switch (message.type) {
    case "chat":
      if (message.role === "user") {
        return <UserMessage content={message.content} onReuse={onReuse} />;
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

function UserMessage({
  content,
  onReuse,
}: {
  content: string;
  onReuse?: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);

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
    <div className="msg-user">
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
        <div className="msg-user-text">{content}</div>
      </div>
    </div>
  );
}

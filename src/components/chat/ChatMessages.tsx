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

/* ------------------------------------------------------------------
 * TodoWrite live progress card
 *
 * The model uses TodoWrite to track multi-step plans (e.g. "1. add
 * route, 2. add handler, 3. run tests"). Previously these calls were
 * collapsed behind the eye-icon tool details toggle, so the user had
 * no idea which step was in flight. Now we render the latest snapshot
 * as a structured card that's always visible — completed steps get a
 * check, the in-progress step gets a spinner glyph + its activeForm
 * label ("Running tests"), and pending steps show as outlines.
 * ------------------------------------------------------------------ */
type TodoItem = {
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
};

function extractTodos(
  input: Record<string, unknown> | undefined
): TodoItem[] | null {
  const todos = input?.todos;
  if (!Array.isArray(todos)) return null;
  const valid = todos.filter((t): t is TodoItem => {
    if (!t || typeof t !== "object") return false;
    const obj = t as Record<string, unknown>;
    if (typeof obj.content !== "string") return false;
    if (typeof obj.activeForm !== "string") return false;
    return (
      obj.status === "pending" ||
      obj.status === "in_progress" ||
      obj.status === "completed"
    );
  });
  return valid.length > 0 ? valid : null;
}

function TodoListCard({ todos }: { todos: TodoItem[] }) {
  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const active = todos.find((t) => t.status === "in_progress");
  const allDone = completed === total;
  const headerLabel = allDone
    ? "All tasks complete"
    : active
    ? active.activeForm
    : "Plan";

  return (
    <div
      className={`msg-todo-card${allDone ? " all-done" : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className="msg-todo-header">
        <span className="msg-todo-glyph" aria-hidden>
          {allDone ? "✓" : active ? "◐" : "▸"}
        </span>
        <span className="msg-todo-title">{headerLabel}</span>
        <span className="msg-todo-progress" aria-label={`${completed} of ${total} complete`}>
          {completed} / {total}
        </span>
      </div>
      <ul className="msg-todo-list">
        {todos.map((t, i) => (
          <li key={i} className={`msg-todo-item status-${t.status}`}>
            <span className="msg-todo-status" aria-hidden>
              {t.status === "completed"
                ? "✓"
                : t.status === "in_progress"
                ? "◐"
                : "○"}
            </span>
            <span className="msg-todo-text">
              {t.status === "in_progress" ? t.activeForm : t.content}
            </span>
          </li>
        ))}
      </ul>
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
  const scrollRef = useRef<HTMLDivElement>(null);
  // Stick-to-bottom is the "follow streaming text down" mode — engaged
  // when the user is near the bottom, disengaged when they scroll up.
  // Combined with CSS `position: sticky` on `.msg-user`, this gives
  // the Claude.ai pattern: response auto-follows the bottom; once the
  // user's prompt would scroll off the top, sticky glues it to the
  // viewport top so it stays visible throughout the turn.
  const stickToBottomRef = useRef(true);
  const lastUserMsgIdRef = useRef<string | null>(null);

  // Latest user msg + whether it's the very last message in the chat.
  // isLast distinguishes a fresh send (true — reply hasn't started yet)
  // from history restored on page refresh (false — the assistant reply
  // is already present after it). We only want to pin for fresh sends;
  // restored chats should drop you at the latest content.
  const userMsgScan = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.type === "chat" && m.role === "user") {
        return { id: m.id, isLast: i === messages.length - 1 };
      }
    }
    return null;
  })();
  const latestUserMsgId = userMsgScan?.id ?? null;
  const latestUserMsgIsLast = userMsgScan?.isLast ?? false;

  // Find the most recent TodoWrite call. The model often calls TodoWrite
  // many times to update step status — we only render the latest as the
  // live progress card. Older snapshots stay hidden unless the user
  // explicitly turns on tool details to replay how the plan evolved.
  const latestTodoWriteId = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.type === "tool" && m.toolName === "TodoWrite") return m.id;
    }
    return null;
  })();

  // Track whether the user is near the bottom — drives stick-to-bottom.
  // If they scroll up more than 80px from the bottom we stop following
  // streaming chunks so they can read older content in peace. The CSS
  // sticky on .msg-user makes sure their current prompt stays visible
  // at the top of the viewport while they do that.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const STICK_THRESHOLD = 80;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distance < STICK_THRESHOLD;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Bottom-follow: when content changes (stream chunk, tool call), pull
  // the viewport to the bottom if the user is near it. CSS `position:
  // sticky` on `.msg-user` (in globals.css) handles the other half of
  // the Claude.ai pattern — once the bottom-follow scrolls past the
  // user's prompt, sticky glues the prompt to the top of the viewport
  // so the user can always see what turn they're in.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages]);

  // On a new send (not a restore), force-re-engage stick and smooth-
  // scroll to bottom — sending is a strong "I want to watch what
  // happens next" signal.
  useEffect(() => {
    if (!latestUserMsgId) return;
    if (lastUserMsgIdRef.current === latestUserMsgId) return;
    lastUserMsgIdRef.current = latestUserMsgId;
    if (!latestUserMsgIsLast) return; // skip restored history
    stickToBottomRef.current = true;
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
  }, [latestUserMsgId, latestUserMsgIsLast]);

  if (messages.length === 0) {
    return (
      <div
        ref={scrollRef}
        className="chat-list chat-list-empty"
        role="log"
        aria-live="polite"
      >
        <AnimatedAIBot />
      </div>
    );
  }

  // Group messages into turns so each user prompt + the assistant's
  // reply that follows it live in their own `.msg-turn` container.
  // Each container is the sticky scope for its user message, which
  // means as you scroll backwards through the chat, each turn's user
  // prompt sticks to the top while you're reading that turn's content
  // — then unsticks as the next turn enters view. (Without scoping,
  // all sticky user msgs share the chat-list as their scope and stack
  // on top of each other instead of replacing one another.)
  const turns = groupIntoTurns(messages);

  return (
    <div ref={scrollRef} className="chat-list" role="log" aria-live="polite">
      {turns.map((turn, turnIdx) => (
        <div key={turn[0]?.id ?? turnIdx} className="msg-turn">
          {turn.map((msg) => (
            <Message
              key={msg.id}
              message={msg}
              onReuse={onReuse}
              showToolDetails={showToolDetails}
              isLatestTodoWrite={msg.id === latestTodoWriteId}
              isLatestUserMsg={msg.id === latestUserMsgId}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Split a flat message list into turns. A turn starts at each user
 *  message and runs until (but not including) the next one. Any
 *  messages BEFORE the first user message (compact-summary system
 *  messages, restored-history preamble) become a turn of their own at
 *  the front so they render in document order without being silently
 *  attached to turn 1's sticky scope. */
function groupIntoTurns(messages: ChatMessage[]): ChatMessage[][] {
  if (messages.length === 0) return [];
  const turns: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  for (const msg of messages) {
    const isUserMsg = msg.type === "chat" && msg.role === "user";
    if (isUserMsg) {
      if (current.length > 0) turns.push(current);
      current = [msg];
    } else {
      current.push(msg);
    }
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

type MessageProps = {
  message: ChatMessage;
  onReuse?: (text: string) => void;
  showToolDetails: boolean;
  /** True for the most-recent TodoWrite call. Only the latest snapshot
   *  renders as the live plan card; older ones stay hidden unless the
   *  user opts into showToolDetails. */
  isLatestTodoWrite?: boolean;
  /** True for the most-recent user message. Only this one gets the
   *  sticky-to-top treatment — older user messages scroll normally so
   *  multiple sticky elements don't stack on top of each other when
   *  the user scrolls back through history. */
  isLatestUserMsg?: boolean;
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
  isLatestTodoWrite,
  isLatestUserMsg,
}: MessageProps) {
  // TodoWrite gets its own structured live card so the user can always
  // see "what step the AI is on" — this is the single most-asked-about
  // piece of state during multi-step prompts. We only render the LATEST
  // TodoWrite as the card (older ones would just be stale plans). With
  // showToolDetails ON, older TodoWrite calls render too so you can
  // replay how the plan evolved over the turn.
  if (message.type === "tool" && message.toolName === "TodoWrite") {
    const todos = extractTodos(message.toolInput);
    if (!todos) return null;
    if (!showToolDetails && !isLatestTodoWrite) return null;
    return <TodoListCard todos={todos} />;
  }

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
            isLatest={isLatestUserMsg ?? false}
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
  /** Most-recent user msg gets the sticky-to-top class. Older user
   *  msgs scroll normally to avoid the stack-on-top overlap. */
  isLatest: boolean;
};

const UserMessage = memo(UserMessageImpl);

// Long-prompt collapse threshold. Anything beyond this char count gets
// clamped to 2 lines (see `.msg-user-text.collapsed` in globals.css)
// with a "Show more" toggle that appears on hover. 80 chars is a
// rough conservative estimate for what fits in 2 lines at the chat
// panel width + 13px font — a short one-liner still renders untouched.
// Also force the collapse if the content contains a newline, since a
// 2-line clamp shouldn't be defeated by a one-character `\n` getting
// under the char threshold.
const USER_MSG_COLLAPSE_THRESHOLD = 80;

function UserMessageImpl({
  messageId,
  content,
  imageUrls,
  onReuse,
  isLatest,
}: UserMessageProps) {
  const [copied, setCopied] = useState(false);
  const [zoomedUrl, setZoomedUrl] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const isLong =
    content.length > USER_MSG_COLLAPSE_THRESHOLD || content.includes("\n");
  const showCollapsed = isLong && !expanded;

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
    <div
      className={`msg-user${isLatest ? " msg-user-latest" : ""}`}
      data-msg-id={messageId}
    >
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
        {content && (
          // Wrapper exists purely so the absolutely-positioned
          // "Show more" button anchors to the text — not to the whole
          // card. That way image attachments below don't get
          // overlapped by the button, and a hidden button costs zero
          // vertical layout space.
          <div className="msg-user-text-wrap">
            <div
              className={`msg-user-text${showCollapsed ? " collapsed" : ""}`}
            >
              {content}
            </div>
            {isLong && (
              <button
                type="button"
                className="msg-user-expand"
                onClick={() => setExpanded((e) => !e)}
                aria-expanded={expanded}
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
          </div>
        )}
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

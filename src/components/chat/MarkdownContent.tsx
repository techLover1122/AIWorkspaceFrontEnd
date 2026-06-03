"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useWorkspaceTab } from "../../contexts/WorkspaceTabContext";

type MarkdownContentProps = {
  content: string;
  /** Trailing block cursor while the message is still streaming. */
  streaming?: boolean;
};

/**
 * Render Claude's assistant text as Markdown with GitHub-flavoured features
 * (tables, task lists, autolinks). Code blocks get a monospace pre with a
 * subtle background; inline code is highlighted.
 *
 * Links are not regular <a> tags — they render as buttons that open the
 * URL as a workspace tab via openTab. The agent should never hand the
 * user a raw URL to click; every URL becomes a one-click "open this in
 * a new tab" action so it lands inside the iframe rail instead of
 * popping a browser tab (which loses CORS context, breaks cookies, etc).
 *
 * Wrapped in React.memo: parsing markdown for finalized messages is
 * expensive (long chats had ~N markdown re-parses per streaming chunk
 * before this). With memo, only the actively streaming bubble re-parses.
 */
function MarkdownContentImpl({ content, streaming }: MarkdownContentProps) {
  const tabCtx = useWorkspaceTab();

  return (
    <div className={`md-content ${streaming ? "streaming" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, title }) => {
            const url = typeof href === "string" ? href : "";
            // Anchor links (#section) and mailto:/tel: aren't tab-openable;
            // fall back to a plain inert button so the chat doesn't crash
            // on click and the user sees the text.
            const isTabOpenable = /^https?:\/\//i.test(url);
            const label =
              typeof children === "string"
                ? children
                : Array.isArray(children)
                ? children.map((c) => (typeof c === "string" ? c : "")).join("")
                : "";
            const displayLabel = label.trim() || url;

            return (
              <button
                type="button"
                className={`md-link-btn${isTabOpenable ? "" : " disabled"}`}
                onClick={() => {
                  if (!isTabOpenable || !tabCtx) return;
                  tabCtx.openTab(url, displayLabel.slice(0, 80));
                }}
                title={title || url}
                disabled={!isTabOpenable}
              >
                <svg
                  viewBox="0 0 16 16"
                  width="11"
                  height="11"
                  fill="none"
                  aria-hidden
                  className="md-link-btn-icon"
                >
                  <path
                    d="M10 3h3v3M13 3l-6 6M6.5 4H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V9.5"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="md-link-btn-label">{children}</span>
              </button>
            );
          },
          code: ({ className, children, ...rest }) => {
            const isInline = !className?.startsWith("language-");
            if (isInline) {
              return (
                <code className="md-inline-code" {...rest}>
                  {children}
                </code>
              );
            }
            const lang = className?.replace("language-", "") ?? "";
            return (
              <code className={`md-code-block language-${lang}`} {...rest}>
                {children}
              </code>
            );
          },
          pre: ({ children, ...rest }) => (
            <pre className="md-pre" {...rest}>
              {children}
            </pre>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownContent = memo(MarkdownContentImpl);

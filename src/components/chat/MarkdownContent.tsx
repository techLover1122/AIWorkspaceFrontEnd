"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type MarkdownContentProps = {
  content: string;
  /** Trailing block cursor while the message is still streaming. */
  streaming?: boolean;
};

/**
 * Render Claude's assistant text as Markdown with GitHub-flavoured features
 * (tables, task lists, autolinks). Code blocks get a monospace pre with a
 * subtle background; inline code is highlighted. Links open in a new tab.
 */
export function MarkdownContent({ content, streaming }: MarkdownContentProps) {
  return (
    <div className={`md-content ${streaming ? "streaming" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...rest }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
              {children}
            </a>
          ),
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

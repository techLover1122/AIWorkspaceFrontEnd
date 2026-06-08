"use client";

import { useEffect, useRef } from "react";

export type ConfirmRequest = {
  /** Bold heading line. Optional — omit for a message-only dialog. */
  title?: string;
  /** Body text. Newlines are preserved (rendered with pre-wrap). */
  message: string;
  /** Primary button label. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Secondary button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Red, destructive styling for the primary action (delete etc.). */
  danger?: boolean;
};

type Props = {
  /** The active request, or null when no dialog is open. */
  request: ConfirmRequest | null;
  /** Resolve the dialog — true = confirmed, false = cancelled. */
  onResolve: (ok: boolean) => void;
};

/**
 * Themed replacement for window.confirm(). Rendered inside the chat panel
 * (which is position:relative) so it overlays the panel area and is never
 * occluded by the Electron WebContentsView tabs that composite over the
 * editor. Enter confirms, Escape / backdrop click cancels.
 */
export function ConfirmDialog({ request, onResolve }: Props) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    // Focus the primary action so Enter works immediately.
    confirmBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onResolve(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        onResolve(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [request, onResolve]);

  if (!request) return null;

  const { title, message, confirmLabel, cancelLabel, danger } = request;

  return (
    <div
      className="confirm-overlay"
      role="dialog"
      aria-modal="true"
      onClick={() => onResolve(false)}
    >
      <div
        className={`confirm-card${danger ? " danger" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-head">
          <span className={`confirm-icon${danger ? " danger" : ""}`} aria-hidden>
            {danger ? (
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="M12 3.5 1.8 21h20.4L12 3.5Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
                <path
                  d="M12 10v4.5"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
                <circle cx="12" cy="17.6" r="1.05" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
                <path
                  d="M12 11v5"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
                <circle cx="12" cy="7.8" r="1.05" fill="currentColor" />
              </svg>
            )}
          </span>
          <div className="confirm-text">
            {title && <div className="confirm-title">{title}</div>}
            <div className="confirm-message">{message}</div>
          </div>
        </div>

        <div className="confirm-actions">
          <button
            type="button"
            className="confirm-btn confirm-cancel"
            onClick={() => onResolve(false)}
          >
            {cancelLabel ?? "Cancel"}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            className={`confirm-btn confirm-ok${danger ? " danger" : ""}`}
            onClick={() => onResolve(true)}
          >
            {confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

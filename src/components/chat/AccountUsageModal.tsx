"use client";

import { useEffect } from "react";
import type { AuthMethod } from "../../hooks/useConnectionStatus";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Highlight the section the user asked for (/account vs /usage). Both
   *  sections always render; this only scrolls/accents the requested one. */
  focus?: "account" | "usage";
  connected: boolean;
  authMethod: AuthMethod;
  apiKeyMasked?: string | null;
  version?: string;
  workingDirectory?: string;
  inputTokens: number;
  outputTokens: number;
  /** Model context window in tokens (e.g. 200_000) for the usage bar. */
  contextLimit: number;
};

const fmt = (n: number) => n.toLocaleString();

/**
 * Account + usage panel — the in-app equivalent of Claude Code's /account
 * and /usage. Shows which account the chat is signed in with and how much of
 * the context window the current session has consumed. Scoped to the chat
 * panel (position:relative parent) so it overlays the panel and is never
 * occluded by the Electron tab views over the editor.
 */
export function AccountUsageModal({
  open,
  onClose,
  focus,
  connected,
  authMethod,
  apiKeyMasked,
  version,
  inputTokens,
  outputTokens,
  contextLimit,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const totalTokens = inputTokens + outputTokens;
  const pct = contextLimit > 0 ? Math.min(1, inputTokens / contextLimit) : 0;
  const pctLabel = (pct * 100).toFixed(pct >= 0.1 ? 0 : 1);
  const barColor =
    pct >= 0.9
      ? "var(--vsc-error)"
      : pct >= 0.7
        ? "var(--vsc-warning)"
        : "var(--bot-accent)";

  const authLabel =
    authMethod === "api_key"
      ? "API key"
      : authMethod === "subscription"
        ? "Claude subscription"
        : connected
          ? "Connected"
          : "Not signed in";

  const authValue =
    authMethod === "api_key"
      ? apiKeyMasked || "•••• key set"
      : authMethod === "subscription"
        ? "Signed in via claude.ai"
        : connected
          ? "—"
          : "Sign in from the chat panel";

  return (
    <div
      className="acct-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Account and usage"
      onClick={onClose}
    >
      <div className="acct-card" onClick={(e) => e.stopPropagation()}>
        <div className="acct-header">
          <strong>Account &amp; usage</strong>
          <button
            type="button"
            className="acct-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* ---- Account ---- */}
        <div className={`acct-section${focus === "account" ? " focus" : ""}`}>
          <div className="acct-section-title">
            <span
              className={`acct-dot ${connected ? "ok" : "off"}`}
              aria-hidden
            />
            Account
          </div>
          <dl className="acct-rows">
            <div className="acct-row">
              <dt>{authLabel}</dt>
              <dd className="acct-mono">{authValue}</dd>
            </div>
            {version && (
              <div className="acct-row">
                <dt>Claude CLI</dt>
                <dd className="acct-mono">v{version}</dd>
              </div>
            )}
          </dl>
        </div>

        {/* ---- Usage (this session) ---- */}
        <div className={`acct-section${focus === "usage" ? " focus" : ""}`}>
          <div className="acct-section-title">Usage · this session</div>

          <div className="acct-bar-wrap">
            <div className="acct-bar-head">
              <span>Context window</span>
              <span className="acct-mono">
                {fmt(inputTokens)} / {fmt(contextLimit)} ({pctLabel}%)
              </span>
            </div>
            <div className="acct-bar-track">
              <div
                className="acct-bar-fill"
                style={{ width: `${Math.max(2, pct * 100)}%`, background: barColor }}
              />
            </div>
          </div>

          <dl className="acct-rows">
            <div className="acct-row">
              <dt>Input tokens</dt>
              <dd className="acct-mono">{fmt(inputTokens)}</dd>
            </div>
            <div className="acct-row">
              <dt>Output tokens</dt>
              <dd className="acct-mono">{fmt(outputTokens)}</dd>
            </div>
            <div className="acct-row acct-row-total">
              <dt>Total</dt>
              <dd className="acct-mono">{fmt(totalTokens)}</dd>
            </div>
          </dl>
          <p className="acct-note">
            Counts cover the active session’s in-context tokens. Compact or
            start a new chat to reset them.
          </p>
        </div>
      </div>
    </div>
  );
}

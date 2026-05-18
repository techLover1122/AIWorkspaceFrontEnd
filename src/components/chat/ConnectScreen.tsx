"use client";

import { useEffect, useState } from "react";
import { AnimatedAIBot } from "./AnimatedAIBot";
import type {
  ConnectionStatus,
  SubscriptionPhase,
} from "../../hooks/useConnectionStatus";

type ConnectScreenProps = {
  connection: ConnectionStatus;
};

type Modal = "subscription" | "api_key" | "cloud" | null;

/**
 * Initial / "logged-out" view of the chat panel. Mirrors the official
 * Claude Code CLI login screen with three options:
 *   - Claude.ai Subscription  (Pro / Team / Enterprise)  — uses `claude login`
 *   - Anthropic Console       (API key)                   — paste sk-ant-…
 *   - Cloud Provider          (Bedrock / Vertex / etc.)  — env-var config
 */
export function ConnectScreen({ connection }: ConnectScreenProps) {
  const [modal, setModal] = useState<Modal>(null);
  const closeModal = () => setModal(null);

  const isBusy = connection.status === "checking";
  const isError = connection.status === "error";

  return (
    <div className="connect-screen">
      <div className="connect-screen-bot">
        <AnimatedAIBot />
      </div>

      <div className="connect-screen-body">
        <h2 className="connect-screen-title">Connect to Claude</h2>
        <p className="connect-screen-subtitle">
          Claude Code can be used with your Claude subscription or billed
          based on API usage. How do you want to log in?
        </p>

        <div className="connect-options">
          <button
            type="button"
            className="connect-option"
            onClick={() => setModal("subscription")}
            disabled={isBusy}
          >
            Claude.ai Subscription
          </button>
          <p className="connect-option-hint">
            Use your Claude Pro, Team, or Enterprise subscription
          </p>

          <button
            type="button"
            className="connect-option"
            onClick={() => setModal("api_key")}
            disabled={isBusy}
          >
            Anthropic Console
          </button>
          <p className="connect-option-hint">
            Pay for API usage through your Console account
          </p>

          <button
            type="button"
            className="connect-option"
            onClick={() => setModal("cloud")}
            disabled={isBusy}
          >
            Bedrock, Foundry, or Vertex <span aria-hidden>↗</span>
          </button>
          <p className="connect-option-hint">
            Instructions on how to use API keys or third-party providers
          </p>
        </div>

        {isBusy && (
          <p className="connect-screen-busy">
            <span className="connect-spinner" aria-hidden /> Checking…
          </p>
        )}

        {isError && !modal && (
          <p className="connect-screen-error-inline">
            ⚠ {connection.message}
          </p>
        )}
      </div>

      {modal === "subscription" && (
        <SubscriptionModal connection={connection} onClose={closeModal} />
      )}
      {modal === "api_key" && (
        <ApiKeyModal connection={connection} onClose={closeModal} />
      )}
      {modal === "cloud" && <CloudModal onClose={closeModal} />}
    </div>
  );
}

/* ------------------------------------------------------------------
   Subscription modal — user runs `claude login` in a terminal, then
   clicks "I'm logged in" to re-verify backend status.
   ------------------------------------------------------------------ */

/**
 * Subscription sign-in via direct OAuth.
 *
 * The backend implements the same OAuth 2.0 PKCE flow the Claude CLI does
 * (extracted from @anthropic-ai/claude-code's cli.js): generate verifier +
 * challenge + state, build the authorize URL, exchange the pasted code for
 * tokens via /v1/oauth/token, and write ~/.claude/.credentials.json. No PTY
 * scripting, no Win32 Input Mode interference — pure HTTP.
 */
function SubscriptionModal({
  connection,
  onClose,
}: {
  connection: ConnectionStatus;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<SubscriptionPhase>("idle");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const handleStart = async () => {
    setError(null);
    setCodeError(null);
    setCode("");
    const s = await connection.startSubscriptionLogin();
    setPhase(s.phase);
    setUrl(s.url);
    setError(s.error ?? null);
  };

  // After the modal opens, poll backend in case phase changes while we sit
  // on browser_opened (e.g. user pastes through another tab) or to pick up
  // a phase transition initiated by /submit-code.
  useEffect(() => {
    if (phase !== "browser_opened" && phase !== "verifying") return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const s = await connection.pollSubscriptionStatus();
      if (cancelled) return;
      setPhase(s.phase);
      setUrl(s.url);
      setError(s.error ?? null);
      if (s.phase === "success") {
        void connection.connect();
      }
    };
    const id = window.setInterval(tick, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [phase, connection]);

  const handleVerify = async () => {
    setCodeError(null);
    setVerifying(true);
    const result = await connection.submitSubscriptionCode(code.trim());
    setVerifying(false);
    if (!result.ok) {
      setCodeError(result.error ?? "Failed to verify code.");
      return;
    }
    // Phase transitions are driven by the polling effect above.
  };

  const handleCopy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard may be unavailable in some webviews */
    }
  };

  const handleCancel = async () => {
    await connection.cancelSubscriptionLogin();
    setPhase("cancelled");
    setUrl(null);
  };

  const showIdle = phase === "idle" || phase === "cancelled";
  const showUrlReady = phase === "browser_opened";
  const showVerifying = phase === "verifying";
  const showSuccess = phase === "success";
  const showNoSubscription = phase === "no_subscription";
  const showError = phase === "error";

  return (
    <ModalShell title="Sign in with Claude.ai" onClose={onClose}>
      {showIdle && (
        <>
          <p>
            We&apos;ll generate a sign-in URL — open it in your browser, sign
            in with your Claude account, and paste the code shown on
            platform.claude.com back here. Make sure your account has a
            Claude Pro / Max / Team plan attached.
          </p>
          <button
            type="button"
            className="connect-modal-primary"
            onClick={() => void handleStart()}
          >
            Start sign-in
          </button>
        </>
      )}

      {showUrlReady && url && (
        <div className="sub-flow">
          <div className="sub-url-block">
            <p className="sub-url-label">
              Copy this URL and open it in your browser:
            </p>
            <div className="sub-url-row">
              <input
                type="text"
                readOnly
                className="connect-modal-input sub-url-input"
                value={url}
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
              <button
                type="button"
                className="sub-url-copy"
                onClick={() => void handleCopy()}
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>

          <div className="sub-code-block">
            <p className="sub-url-label">
              After signing in, paste the code shown on platform.claude.com:
            </p>
            <div className="sub-url-row">
              <input
                type="text"
                className="connect-modal-input sub-url-input"
                placeholder="Paste authorization code…"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setCodeError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleVerify();
                }}
                spellCheck={false}
                autoComplete="off"
                disabled={verifying}
              />
              <button
                type="button"
                className="connect-modal-primary sub-verify-btn"
                onClick={() => void handleVerify()}
                disabled={verifying || !code.trim()}
              >
                {verifying ? (
                  <>
                    <span className="connect-spinner" aria-hidden /> Verifying…
                  </>
                ) : (
                  "Verify"
                )}
              </button>
            </div>
            {codeError && (
              <p className="connect-modal-error sub-code-error">{codeError}</p>
            )}
            {error && !codeError && (
              <p className="connect-modal-error sub-code-error">{error}</p>
            )}
          </div>

          <button
            type="button"
            className="connect-modal-cancel"
            onClick={() => void handleCancel()}
          >
            Cancel
          </button>
        </div>
      )}

      {showVerifying && (
        <div className="sub-progress">
          <span className="connect-spinner" aria-hidden />
          <span>Exchanging code with Anthropic…</span>
        </div>
      )}

      {showSuccess && (
        <>
          <p className="sub-success">✓ Claude connected successfully</p>
          <button
            type="button"
            className="connect-modal-primary"
            onClick={() => {
              void connection.connect();
              onClose();
            }}
          >
            Continue
          </button>
        </>
      )}

      {showNoSubscription && (
        <>
          <div className="sub-no-subscription">
            <p className="sub-no-subscription-title">
              You don&apos;t have an active subscription yet
            </p>
            <p className="sub-no-subscription-body">
              Sign-in worked, but this Claude account doesn&apos;t have a
              <strong> Pro</strong>, <strong>Max</strong>, or
              <strong> Team</strong> plan attached — which is required to use
              Claude Code through your subscription.
            </p>
            <p className="sub-no-subscription-body">
              You can either upgrade your account, or sign in with an{" "}
              <strong>API key</strong> from console.anthropic.com instead.
            </p>
          </div>
          <div className="sub-error-actions">
            <a
              href="https://claude.ai/upgrade"
              target="_blank"
              rel="noopener noreferrer"
              className="connect-modal-primary"
            >
              Upgrade plan ↗
            </a>
            <button
              type="button"
              className="connect-modal-secondary"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </>
      )}

      {showError && (
        <>
          <p className="connect-modal-error">{error ?? "Sign-in failed."}</p>
          <div className="sub-error-actions">
            <button
              type="button"
              className="connect-modal-primary"
              onClick={() => void handleStart()}
            >
              Try again
            </button>
            <button
              type="button"
              className="connect-modal-secondary"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}

/* ------------------------------------------------------------------
   API key modal — user pastes a sk-ant-… key from console.anthropic.com.
   The key is validated against Anthropic's /v1/models endpoint before
   being stored, so the user gets immediate feedback if it's wrong.
   ------------------------------------------------------------------ */

import type { ApiKeyErrorCode } from "../../hooks/useConnectionStatus";

function ApiKeyModal({
  connection,
  onClose,
}: {
  connection: ConnectionStatus;
  onClose: () => void;
}) {
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [localError, setLocalError] = useState<{
    code?: ApiKeyErrorCode;
    msg: string;
  } | null>(null);
  const [pasteHint, setPasteHint] = useState<string | null>(null);
  const isChecking = connection.status === "checking";

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const candidate = text.trim();
      if (!candidate) {
        setPasteHint("Clipboard is empty.");
        return;
      }
      setKey(candidate);
      setPasteHint(null);
      setLocalError(null);
    } catch {
      setPasteHint(
        "Couldn't read clipboard — paste manually with Ctrl/Cmd + V."
      );
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setPasteHint(null);
    const trimmed = key.trim();
    if (!trimmed) {
      setLocalError({ code: "missing", msg: "Paste your API key first." });
      return;
    }
    const result = await connection.submitApiKey(trimmed);
    if (!result.ok) {
      setLocalError({
        code: result.code,
        msg: result.error,
      });
    } else {
      onClose();
    }
  };

  return (
    <ModalShell title="Sign in with API key" onClose={onClose}>
      <p>
        Get an API key from{" "}
        <a
          href="https://console.anthropic.com/settings/keys"
          target="_blank"
          rel="noopener noreferrer"
        >
          console.anthropic.com
        </a>
        . You&apos;ll be charged per token; subscription benefits do not apply.
      </p>

      <form className="connect-modal-form" onSubmit={handleSubmit}>
        <label className="connect-modal-label" htmlFor="api-key-input">
          API key
        </label>
        <div className="api-key-input-wrap">
          <input
            id="api-key-input"
            type={reveal ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            className="connect-modal-input api-key-input"
            placeholder="sk-ant-…"
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              if (localError) setLocalError(null);
            }}
            disabled={isChecking}
          />
          <button
            type="button"
            className="api-key-eye"
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal ? "Hide key" : "Show key"}
            disabled={isChecking}
            title={reveal ? "Hide" : "Show"}
          >
            {reveal ? <EyeOffIcon /> : <EyeIcon />}
          </button>
          <button
            type="button"
            className="api-key-paste"
            onClick={() => void handlePaste()}
            disabled={isChecking}
            title="Paste from clipboard"
          >
            Paste
          </button>
        </div>
        {pasteHint && <p className="connect-modal-foot">{pasteHint}</p>}

        <button
          type="submit"
          className="connect-modal-primary"
          disabled={isChecking || !key.trim()}
        >
          {isChecking ? (
            <>
              <span className="connect-spinner" aria-hidden /> Validating…
            </>
          ) : (
            "Save & connect"
          )}
        </button>
      </form>

      {localError && (
        <div className="connect-modal-error api-key-error">
          <span className="api-key-error-icon" aria-hidden>!</span>
          <span>{localError.msg}</span>
          {localError.code === "invalid" && (
            <a
              className="api-key-error-link"
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
            >
              Manage keys ↗
            </a>
          )}
        </div>
      )}

      <p className="connect-modal-foot">
        Validated against Anthropic before saving. Stored in backend memory
        only — never written to disk.
      </p>
    </ModalShell>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
      <path
        d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
      <path
        d="M2 8s2.5-4.5 6.5-4.5c1.2 0 2.3.4 3.2.95M14 8s-.5.9-1.5 1.95M8 12.5c-4 0-6.5-4.5-6.5-4.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M2 2l12 12"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------
   Cloud provider modal — instructions for env-var-based config.
   No form yet; user sets env vars before starting the backend.
   ------------------------------------------------------------------ */

function CloudModal({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell title="Cloud Providers" onClose={onClose}>
      <p>
        Claude Code can route requests through{" "}
        <strong>AWS Bedrock</strong>, <strong>Google Vertex AI</strong>, or{" "}
        <strong>Azure Foundry</strong>. Set the appropriate environment
        variables before starting the backend:
      </p>

      <section className="connect-modal-section">
        <h4>AWS Bedrock</h4>
        <pre className="connect-modal-code">
{`CLAUDE_CODE_USE_BEDROCK=1
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=…
AWS_SECRET_ACCESS_KEY=…`}
        </pre>
      </section>

      <section className="connect-modal-section">
        <h4>Google Vertex AI</h4>
        <pre className="connect-modal-code">
{`CLAUDE_CODE_USE_VERTEX=1
CLOUD_ML_REGION=us-east5
ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project
GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json`}
        </pre>
      </section>

      <p className="connect-modal-foot">
        Full docs:{" "}
        <a
          href="https://docs.anthropic.com/claude/docs/claude-code"
          target="_blank"
          rel="noopener noreferrer"
        >
          docs.anthropic.com/claude-code
        </a>
        . Restart the backend after setting env vars, then return here.
      </p>

      <button type="button" className="connect-modal-primary" onClick={onClose}>
        Got it
      </button>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------
   Shared modal frame
   ------------------------------------------------------------------ */

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="connect-modal-overlay" onClick={onClose}>
      <div
        className="connect-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="connect-modal-header">
          <h3>{title}</h3>
          <button
            type="button"
            className="connect-modal-close"
            onClick={onClose}
            aria-label="Close"
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
        <div className="connect-modal-body">{children}</div>
      </div>
    </div>
  );
}

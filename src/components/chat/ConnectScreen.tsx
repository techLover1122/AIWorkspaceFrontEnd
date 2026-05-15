"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatedAIBot } from "./AnimatedAIBot";
import type {
  ConnectionStatus,
  SubscriptionPhase,
  SubscriptionStatus,
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

function SubscriptionModal({
  connection,
  onClose,
}: {
  connection: ConnectionStatus;
  onClose: () => void;
}) {
  const [sub, setSub] = useState<SubscriptionStatus>({
    phase: "idle",
    url: null,
    urls: [],
    error: null,
  });
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const pollIntervalRef = useRef<number | null>(null);
  const isTerminal = (p: SubscriptionPhase): boolean =>
    p === "idle" ||
    p === "success" ||
    p === "no_subscription" ||
    p === "error" ||
    p === "cancelled";

  // Poll while a login is in progress. Faster cadence (500ms) before the URL
  // arrives so the UI feels responsive through the two-menu flow. Once the
  // browser is opened, slow down to 1500ms — we're just waiting on the user.
  useEffect(() => {
    if (isTerminal(sub.phase)) return;

    let consecutiveNetworkErrors = 0;

    const tick = async () => {
      const s = await connection.pollSubscriptionStatus();
      // Swallow transient network errors (backend restarting, etc.) so the
      // modal doesn't bounce to an error state. After 6 consecutive failures
      // (~6-18s) surface the error.
      const isNetworkErr =
        s.phase === "error" && /network|fetch|refused/i.test(s.error ?? "");
      if (isNetworkErr) {
        consecutiveNetworkErrors += 1;
        if (consecutiveNetworkErrors < 6) return;
      } else {
        consecutiveNetworkErrors = 0;
      }
      setSub(s);
      // When CLI succeeds, re-check overall /api/status so the panel can swap
      // to chat mode.
      if (s.phase === "success") {
        void connection.connect();
      }
    };

    const interval =
      sub.phase === "browser_opened" ? 1500 : 500;
    pollIntervalRef.current = window.setInterval(tick, interval);
    return () => {
      if (pollIntervalRef.current !== null) {
        window.clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [sub.phase, connection]);

  const handleStart = async () => {
    setSub({ phase: "spawning", url: null, urls: [], error: null });
    const s = await connection.startSubscriptionLogin();
    setSub(s);
  };

  const handleCancel = async () => {
    await connection.cancelSubscriptionLogin();
    setSub({ phase: "cancelled", url: null, urls: [], error: null });
  };

  const handleCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* ignore */
    }
  };

  const [verifying, setVerifying] = useState(false);
  const [codeSubmitted, setCodeSubmitted] = useState(false);

  const handleVerify = async () => {
    setCodeError(null);
    const trimmed = code.trim();
    if (!trimmed) {
      setCodeError("Paste the code from the sign-in page first.");
      return;
    }
    setVerifying(true);
    const result = await connection.submitSubscriptionCode(trimmed);
    setVerifying(false);
    if (!result.ok) {
      setCodeError(result.error ?? "Failed to submit code.");
    } else {
      setCodeSubmitted(true);
    }
  };

  const showStartButton = sub.phase === "idle";
  const showSpinner = sub.phase === "spawning" || sub.phase === "waiting_url";
  const showUrlReady = sub.phase === "browser_opened";
  const showSuccess = sub.phase === "success";
  const showNoSubscription = sub.phase === "no_subscription";
  const showError = sub.phase === "error" || sub.phase === "cancelled";

  const spinnerLabel =
    sub.phase === "spawning" ? "Starting Claude CLI…" : "Generating sign-in URL…";

  // Which URLs to display — all captured ones (last = key-returning URL)
  const urlList =
    sub.urls && sub.urls.length > 0 ? sub.urls : sub.url ? [sub.url] : [];

  return (
    <ModalShell title="Sign in with Claude.ai" onClose={onClose}>
      {showStartButton && (
        <>
          <p>
            We&apos;ll run <code>claude login</code> on the backend and
            generate a sign-in URL for you. Make sure you have a Claude
            Pro / Max / Team subscription on the account you sign in with.
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

      {/* Step 1 — waiting for URL */}
      {showSpinner && (
        <div className="sub-progress">
          <span className="connect-spinner" aria-hidden />
          <span>{spinnerLabel}</span>
        </div>
      )}

      {/* Step 2 — URL ready: show copy field + code entry */}
      {showUrlReady && (
        <div className="sub-flow">
          {/* URL fields */}
          {urlList.map((u, i) => {
            const isLast = i === urlList.length - 1;
            return (
              <div key={u} className="sub-url-block">
                <p className="sub-url-label">
                  {urlList.length > 1
                    ? (isLast ? "Copy this URL and open in browser:" : `URL ${i + 1}:`)
                    : "Copy this URL and open in your browser:"}
                </p>
                <div className="sub-url-row">
                  <input
                    type="text"
                    readOnly
                    className="connect-modal-input sub-url-input"
                    value={u}
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                  <button
                    type="button"
                    className="sub-url-copy"
                    onClick={() => void handleCopy(u)}
                  >
                    {copied === u ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>
            );
          })}

          {/* Code entry */}
          <div className="sub-code-block">
            <p className="sub-url-label">
              After authorizing, paste the code shown on platform.claude.com:
            </p>
            <div className="sub-url-row">
              <input
                type="text"
                className="connect-modal-input sub-url-input"
                placeholder="Paste authorization code…"
                value={code}
                onChange={(e) => { setCode(e.target.value); setCodeError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") void handleVerify(); }}
                spellCheck={false}
                autoComplete="off"
                disabled={verifying}
              />
              <button
                type="button"
                className="connect-modal-primary sub-verify-btn"
                onClick={() => void handleVerify()}
                disabled={!code.trim() || verifying}
              >
                {verifying ? <><span className="connect-spinner" aria-hidden /> Verifying…</> : "Verify"}
              </button>
            </div>
            {codeError && (
              <p className="connect-modal-error sub-code-error">{codeError}</p>
            )}
            {codeSubmitted && !codeError && (
              <div className="sub-progress" style={{ marginTop: 8 }}>
                <span className="connect-spinner" aria-hidden />
                <span>Code received — completing sign-in…</span>
              </div>
            )}
          </div>

          {!codeSubmitted && (
            <p className="connect-modal-foot sub-waiting-note">
              Or just sign in via the browser — this screen will update automatically.
            </p>
          )}
          <button
            type="button"
            className="connect-modal-cancel"
            onClick={() => void handleCancel()}
          >
            Cancel
          </button>
        </div>
      )}

      {showSuccess && (
        <>
          <p className="sub-success">✓ Logged in successfully</p>
          <button
            type="button"
            className="connect-modal-primary"
            onClick={onClose}
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
              <strong>API key</strong> from console.anthropic.com instead
              (pay-per-use).
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
          {sub.output && (
            <details className="sub-output-details">
              <summary>Show CLI output</summary>
              <pre className="sub-output-pre">{sub.output}</pre>
            </details>
          )}
        </>
      )}

      {showError && (
        <>
          <p className="connect-modal-error">
            {sub.error ?? (sub.phase === "cancelled" ? "Cancelled" : "Login failed")}
          </p>
          {sub.output && (
            <details className="sub-output-details">
              <summary>Show CLI output</summary>
              <pre className="sub-output-pre">{sub.output}</pre>
            </details>
          )}
          <p className="connect-modal-foot">
            You can retry, or run <code>claude login</code> manually in a
            terminal and then click <em>Retry connection</em> from the main
            screen.
          </p>
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

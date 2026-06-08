"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  whatsappForwardingUrl,
  whatsappPairPhoneUrl,
  whatsappQrUrl,
  whatsappRecipientUrl,
  whatsappStatusUrl,
  whatsappUnlinkUrl,
} from "../../constant/api";
import { getElectronTabs } from "../../utils/electronTabs";

/**
 * WhatsApp link modal — pair the workspace's ai-ide-whatsapp sidecar
 * with the user's WhatsApp account so the agent can ping them when a
 * task completes / needs a permission / asks a question, AND so they
 * can drive the agent by texting from their phone.
 *
 * Two visually distinct states:
 *  - DISCONNECTED: a pairing flow (Scan QR / Phone number) with a big
 *    QR card or an 8-char pairing code. Polls /qr every 2s.
 *  - CONNECTED: a green "hero" card with the linked number + live
 *    connection dot, a Recipient card, a Forwarding toggle, and a
 *    clearly-separated Danger zone with a proper Unlink button.
 *
 * Status polling (/api/whatsapp/status, 2.5s) drives the switch — when
 * pairing completes mid-session the UI flips to CONNECTED automatically.
 */

type Status = {
  configured?: boolean;
  paired?: boolean;
  connected?: boolean;
  jid?: string;
  phone?: string;
  recipientPhone?: string;
  lastError?: string;
  sidecarReachable?: boolean;
  error?: string;
};

type QrResponse = {
  qr?: string;
  qrPngUrl?: string;
  paired?: boolean;
  error?: string;
};

type Tab = "qr" | "phone";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function WhatsAppLinkModal({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("qr");
  const [status, setStatus] = useState<Status | null>(null);
  const [qr, setQr] = useState<QrResponse | null>(null);
  const [phone, setPhone] = useState("");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recipientDraft, setRecipientDraft] = useState("");
  const [recipientBusy, setRecipientBusy] = useState(false);
  const [recipientNote, setRecipientNote] = useState<string | null>(null);
  const [forwardingEnabled, setForwardingEnabled] = useState<boolean | null>(null);
  const [forwardingBusy, setForwardingBusy] = useState(false);
  const [unlinkConfirm, setUnlinkConfirm] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset when the modal closes so the next open starts clean.
  useEffect(() => {
    if (open) return;
    setTab("qr");
    setQr(null);
    setPhone("");
    setPairingCode(null);
    setCodeCopied(false);
    setBusy(false);
    setError(null);
    setRecipientDraft("");
    setRecipientBusy(false);
    setRecipientNote(null);
    setForwardingEnabled(null);
    setForwardingBusy(false);
    setUnlinkConfirm(false);
  }, [open]);

  // Fetch the forwarding toggle state on open. The backend stores it
  // per-workspace in SQLite; reset to "off" after an EC2 rebuild.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(whatsappForwardingUrl());
        if (!res.ok) return;
        const body = (await res.json()) as { enabled?: boolean };
        if (cancelled) return;
        setForwardingEnabled(body.enabled === true);
      } catch {
        /* swallow — the toggle just won't render until next open */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleToggleForwarding = async (next: boolean) => {
    setForwardingBusy(true);
    // Optimistic update so the checkbox snaps even if the network is slow.
    setForwardingEnabled(next);
    try {
      const res = await fetch(whatsappForwardingUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        // Roll back on failure.
        setForwardingEnabled(!next);
      }
    } catch {
      setForwardingEnabled(!next);
    } finally {
      setForwardingBusy(false);
    }
  };

  // Seed the recipient input from the latest status snapshot so the
  // user sees what's currently configured when they open the modal.
  useEffect(() => {
    if (!status?.recipientPhone) return;
    setRecipientDraft((cur) => (cur === "" ? status.recipientPhone! : cur));
  }, [status?.recipientPhone]);

  // In the Electron desktop app, user tabs render as native
  // WebContentsViews stacked ABOVE the page DOM. A regular CSS overlay
  // is hidden behind them. Workaround: enumerate visible tabs when the
  // modal opens, hide them, then restore on close. No-op outside
  // Electron (browser dev — there are no tabs).
  useEffect(() => {
    if (!open) return;
    const electron = getElectronTabs();
    if (!electron) return;

    let cancelled = false;
    let hiddenIds: string[] = [];
    void (async () => {
      try {
        const { tabs } = await electron.list();
        if (cancelled) return;
        hiddenIds = tabs.filter((t) => t.visible).map((t) => t.tabId);
        await Promise.all(
          hiddenIds.map((id) => electron.setVisible(id, false).catch(() => {}))
        );
      } catch {
        /* swallow — if list/hide fails the modal still renders, just over a
           visible tab. Better than crashing the modal. */
      }
    })();

    return () => {
      cancelled = true;
      if (hiddenIds.length === 0) return;
      // Restore on close — fire and forget; any tab that got destroyed
      // in the meantime will just reject and be ignored.
      void Promise.all(
        hiddenIds.map((id) => electron.setVisible(id, true).catch(() => {}))
      );
    };
  }, [open]);

  // Status fetch on open + polling.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(whatsappStatusUrl());
        const body = (await res.json()) as Status;
        if (cancelled) return;
        setStatus(body);
        if (body.error) setError(body.error);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    pollTimer.current = setInterval(tick, 2500);
    return () => {
      cancelled = true;
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [open]);

  // QR polling — only while the modal is open, the QR tab is selected,
  // status fetched, and we're NOT already paired.
  useEffect(() => {
    if (!open) return;
    if (tab !== "qr") return;
    if (status?.paired) return;
    if (status && !status.configured) return; // 503 — nothing to poll

    let cancelled = false;
    const fetchQr = async () => {
      try {
        const res = await fetch(whatsappQrUrl());
        const body = (await res.json()) as QrResponse;
        if (cancelled) return;
        if (body.error) setError(body.error);
        else setQr(body);
      } catch {
        /* transient — try again on next tick */
      }
    };
    void fetchQr();
    const id = setInterval(fetchQr, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open, tab, status?.paired, status?.configured]);

  const handlePairPhone = async () => {
    if (!phone.trim()) {
      setError("Enter a phone number in international format, e.g. +14155552671.");
      return;
    }
    setBusy(true);
    setError(null);
    setPairingCode(null);
    setCodeCopied(false);
    try {
      const res = await fetch(whatsappPairPhoneUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim() }),
      });
      const body = (await res.json()) as { pairingCode?: string; error?: string };
      if (!res.ok || !body.pairingCode) {
        setError(body.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setPairingCode(body.pairingCode);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCopyCode = async () => {
    if (!pairingCode) return;
    try {
      await navigator.clipboard.writeText(pairingCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1800);
    } catch {
      /* clipboard blocked — the user can still read & type the code */
    }
  };

  const handleSaveRecipient = async (clear: boolean) => {
    setRecipientBusy(true);
    setRecipientNote(null);
    try {
      const res = await fetch(whatsappRecipientUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: clear ? "" : recipientDraft.trim() }),
      });
      const body = (await res.json()) as {
        recipientPhone?: string;
        error?: string;
      };
      if (!res.ok) {
        setRecipientNote(body.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setRecipientNote(
        body.recipientPhone
          ? `Saved — notifications go to ${body.recipientPhone}.`
          : "Cleared — notifications go to your own Message Yourself chat."
      );
      if (clear) setRecipientDraft("");
    } catch (err) {
      setRecipientNote(err instanceof Error ? err.message : String(err));
    } finally {
      setRecipientBusy(false);
    }
  };

  const handleUnlink = async () => {
    if (!unlinkConfirm) {
      setUnlinkConfirm(true);
      return;
    }
    setUnlinkConfirm(false);
    setBusy(true);
    try {
      await fetch(whatsappUnlinkUrl(), { method: "POST" });
    } catch {
      /* swallow — we'll learn the result from the next status poll */
    } finally {
      setBusy(false);
      setQr(null);
      setPairingCode(null);
    }
  };

  if (!open) return null;

  const isLoading = status === null;
  const isPaired = !!status?.paired;
  const isUnconfigured = !!status && status.configured === false;
  const isConnected = status?.connected !== false; // undefined => assume up
  const displayNumber = formatNumber(status?.phone ?? jidToNumber(status?.jid));

  return (
    <div
      className="whatsapp-modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={overlayStyle}
    >
      <div
        className="whatsapp-modal"
        onClick={(e) => e.stopPropagation()}
        style={modalStyle}
      >
        {/* accent top rule */}
        <div style={accentBarStyle} />

        {/* ── Header ── */}
        <div style={headerStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <span style={waBadgeStyle}>
              <WhatsAppGlyph />
            </span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.2 }}>
                WhatsApp
              </div>
              <div style={{ fontSize: 12, color: MUTED, marginTop: 1 }}>
                {isLoading
                  ? "Checking status…"
                  : isUnconfigured
                    ? "Unavailable"
                    : isPaired
                      ? "Linked device"
                      : "Pair your account"}
              </div>
            </div>
          </div>
          <button type="button" onClick={onClose} style={closeBtnStyle} aria-label="Close">
            <CloseGlyph />
          </button>
        </div>

        <div style={contentStyle}>
          {isLoading ? (
            <div style={loadingWrapStyle}>
              <span style={spinnerStyle} />
              <span style={{ color: MUTED, fontSize: 13 }}>Connecting to the sidecar…</span>
            </div>
          ) : isUnconfigured ? (
            <div style={emptyStateStyle}>
              <span style={emptyIconStyle}>
                <WhatsAppGlyph size={22} />
              </span>
              <div style={{ fontWeight: 600, fontSize: 14 }}>WhatsApp isn&apos;t set up here</div>
              <p style={{ ...hintStyle, textAlign: "center", maxWidth: 280 }}>
                The WhatsApp sidecar isn&apos;t installed on this workspace yet.
                Ask the operator to enable it, then reopen this panel.
              </p>
            </div>
          ) : isPaired ? (
            /* ─────────────────────── CONNECTED ─────────────────────── */
            <>
              <div style={heroConnectedStyle}>
                <div style={heroGlowStyle} />
                <span style={heroIconWrapStyle}>
                  <CheckGlyph />
                </span>
                <div style={{ position: "relative", zIndex: 1 }}>
                  <div style={heroEyebrowStyle}>
                    <span style={isConnected ? dotGreen : dotAmber} />
                    {isConnected ? "Connected" : "Reconnecting…"}
                  </div>
                  <div style={heroNumberStyle}>{displayNumber || "Linked"}</div>
                  <div style={heroSubStyle}>
                    This workspace is one of your WhatsApp linked devices.
                  </div>
                </div>
              </div>

              <div style={gridTwoColStyle}>
              {/* recipient */}
              <div style={cardStyle}>
                <div style={cardLabelStyle}>Recipient</div>
                <div style={hintStyle}>
                  Where the agent texts you. Defaults to your own
                  Message&nbsp;Yourself chat — change it to any number you can text.
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <input
                    type="tel"
                    placeholder="+1 415 555 2671"
                    value={recipientDraft}
                    onChange={(e) => setRecipientDraft(e.target.value)}
                    style={inputStyle}
                  />
                  <button
                    type="button"
                    onClick={() => handleSaveRecipient(false)}
                    disabled={recipientBusy || !recipientDraft.trim()}
                    style={{
                      ...primaryBtnStyle,
                      opacity: recipientBusy || !recipientDraft.trim() ? 0.55 : 1,
                    }}
                  >
                    {recipientBusy ? "Saving…" : "Save"}
                  </button>
                </div>
                {status?.recipientPhone && (
                  <button
                    type="button"
                    onClick={() => handleSaveRecipient(true)}
                    disabled={recipientBusy}
                    style={linkBtnStyle}
                  >
                    Reset to Message Yourself
                  </button>
                )}
                {recipientNote && (
                  <div style={{ ...hintStyle, marginTop: 8, color: ACCENT }}>
                    {recipientNote}
                  </div>
                )}
              </div>

              {/* forwarding */}
              <div style={cardStyle}>
                <div style={rowBetween}>
                  <div style={{ flex: 1 }}>
                    <div style={cardLabelStyle}>Always forward</div>
                    <div style={hintStyle}>
                      Off: you&apos;re only pinged after you close the workspace or
                      go quiet 5&nbsp;min. On: every prompt hits your phone.
                    </div>
                  </div>
                  <Switch
                    on={forwardingEnabled === true}
                    disabled={forwardingBusy || forwardingEnabled === null}
                    onChange={(next) => void handleToggleForwarding(next)}
                  />
                </div>
              </div>
              </div>

              {/* danger zone */}
              <div style={dangerZoneStyle}>
                <div style={{ flex: 1 }}>
                  <div style={{ ...cardLabelStyle, color: DANGER }}>Danger zone</div>
                  <div style={hintStyle}>
                    Unlinking removes this workspace from your WhatsApp linked
                    devices. You&apos;ll need to scan again to reconnect.
                  </div>
                </div>
                {unlinkConfirm ? (
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={handleUnlink}
                      disabled={busy}
                      style={dangerBtnStyle}
                    >
                      {busy ? "Unlinking…" : "Confirm unlink"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setUnlinkConfirm(false)}
                      style={ghostBtnStyle}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={handleUnlink}
                    disabled={busy}
                    style={dangerOutlineBtnStyle}
                  >
                    Unlink device
                  </button>
                )}
              </div>
            </>
          ) : (
            /* ────────────────────── DISCONNECTED ────────────────────── */
            <>
              <p style={{ ...hintStyle, marginTop: -2 }}>
                Link your account to get pinged when a task finishes, needs
                approval, or asks a question — then reply to drive the agent
                straight from WhatsApp.
              </p>

              <div style={segmentStyle}>
                <button
                  type="button"
                  onClick={() => setTab("qr")}
                  style={tab === "qr" ? segActiveStyle : segStyle}
                >
                  Scan QR
                </button>
                <button
                  type="button"
                  onClick={() => setTab("phone")}
                  style={tab === "phone" ? segActiveStyle : segStyle}
                >
                  Phone number
                </button>
              </div>

              {tab === "qr" ? (
                <div style={qrLayoutStyle}>
                  <div style={qrFrameStyle}>
                    {qr?.qrPngUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={qr.qrPngUrl}
                        alt="WhatsApp QR code"
                        width={210}
                        height={210}
                        style={{ display: "block", borderRadius: 8 }}
                      />
                    ) : (
                      <div style={qrPlaceholderStyle}>
                        <span style={spinnerStyle} />
                        <span>Generating code…</span>
                      </div>
                    )}
                  </div>
                  <div style={qrSideStyle}>
                    <div style={{ ...stepsStyle, marginTop: 0 }}>
                      <Step n={1}>Open WhatsApp on your phone</Step>
                      <Step n={2}>
                        Tap <strong>Settings → Linked Devices → Link a Device</strong>
                      </Step>
                      <Step n={3}>Point your camera at this code</Step>
                    </div>
                    <div style={{ ...waitingRowStyle, justifyContent: "flex-start", marginTop: 14 }}>
                      <span style={spinnerSmStyle} />
                      Waiting for you to scan…
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      type="tel"
                      placeholder="+1 415 555 2671"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      style={inputStyle}
                    />
                    <button
                      type="button"
                      onClick={handlePairPhone}
                      disabled={busy}
                      style={{ ...primaryBtnStyle, opacity: busy ? 0.55 : 1 }}
                    >
                      {busy ? "…" : "Get code"}
                    </button>
                  </div>
                  <p style={{ ...hintStyle, marginTop: 8 }}>
                    Then in WhatsApp: <strong>Linked Devices → Link with phone
                    number</strong> and enter this code.
                  </p>
                  {pairingCode && (
                    <div style={pairingCodeBoxStyle}>
                      <div style={pairingCodeTextStyle}>{formatPairingCode(pairingCode)}</div>
                      <button type="button" onClick={handleCopyCode} style={copyBtnStyle}>
                        {codeCopied ? "Copied ✓" : "Copy"}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {error && !isUnconfigured && (
            <p style={noticeStyle}>{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Helpers ───────────────────────────────────────────────────────── */

function jidToNumber(jid?: string): string | undefined {
  if (!jid) return undefined;
  // jids look like "923008899548:12@s.whatsapp.net" — keep the leading digits.
  const m = jid.match(/^(\d{6,15})/);
  return m ? m[1] : undefined;
}

function formatNumber(raw?: string): string {
  if (!raw) return "";
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return raw.startsWith("+") ? raw : `+${raw}`;
  return `+${digits}`;
}

function formatPairingCode(code: string): string {
  // WhatsApp shows the 8-char code as two groups of four.
  const c = code.replace(/\s/g, "");
  if (c.length === 8) return `${c.slice(0, 4)}-${c.slice(4)}`;
  return code;
}

/* ── Small UI atoms ────────────────────────────────────────────────── */

function WhatsAppGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#fff" aria-hidden>
      <path d="M12 2a10 10 0 0 0-8.5 15.3L2 22l4.8-1.5A10 10 0 1 0 12 2Zm5.4 14.1c-.2.6-1.2 1.2-1.7 1.2-.4 0-1 .1-3.3-.9-2.8-1.2-4.5-4-4.6-4.2-.1-.2-1-1.4-1-2.6 0-1.3.6-1.9.9-2.1.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.4.6c-.2.2-.3.4-.1.7.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.4 2.4 1.5.2.1.4.1.6-.1l.7-.8c.2-.2.3-.2.6-.1l1.9.9c.3.1.5.2.5.4.1.2.1.7-.1 1.2Z" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div style={stepRowStyle}>
      <span style={stepNumStyle}>{n}</span>
      <span style={{ fontSize: 12.5, color: "#c7c7cc", lineHeight: 1.45 }}>{children}</span>
    </div>
  );
}

function Switch({
  on,
  disabled,
  onChange,
}: {
  on: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      style={{
        position: "relative",
        width: 42,
        height: 24,
        borderRadius: 999,
        border: "none",
        flexShrink: 0,
        background: on ? ACCENT : "#3a3a3c",
        cursor: disabled ? "wait" : "pointer",
        transition: "background 0.18s",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: on ? 20 : 2,
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "#fff",
          transition: "left 0.18s",
          boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
        }}
      />
    </button>
  );
}

/* ── Styles ────────────────────────────────────────────────────────── */

const ACCENT = "#25D366";
const ACCENT_DK = "#128C4B";
const MUTED = "#8e8e93";
const SURFACE = "#161618";
const CARD = "#1f1f22";
const BORDER = "#2c2c2e";
const DANGER = "#ff5a52";

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.62)",
  backdropFilter: "blur(3px)",
  WebkitBackdropFilter: "blur(3px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  padding: 16,
};

const modalStyle: CSSProperties = {
  position: "relative",
  background: SURFACE,
  color: "#f2f2f2",
  borderRadius: 18,
  width: "min(640px, 96vw)",
  maxHeight: "90vh",
  overflowY: "auto",
  border: `1px solid ${BORDER}`,
  boxShadow: "0 30px 80px rgba(0,0,0,0.6)",
};

/* Two-column grid for the connected-state cards so the modal grows wide
 * instead of tall. Collapses to a single column on narrow viewports. */
const gridTwoColStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
  gap: 12,
  alignItems: "start",
};

const accentBarStyle: CSSProperties = {
  height: 3,
  background: `linear-gradient(90deg, ${ACCENT}, ${ACCENT_DK})`,
  borderTopLeftRadius: 18,
  borderTopRightRadius: 18,
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "16px 18px",
  borderBottom: `1px solid ${BORDER}`,
};

const waBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 34,
  height: 34,
  borderRadius: 10,
  background: `linear-gradient(135deg, ${ACCENT}, ${ACCENT_DK})`,
  boxShadow: `0 4px 12px rgba(37,211,102,0.3)`,
};

const closeBtnStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  background: "transparent",
  border: "none",
  color: MUTED,
  cursor: "pointer",
  borderRadius: 8,
};

const contentStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 18,
};

const loadingWrapStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 12,
  padding: "32px 0",
};

const emptyStateStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 10,
  padding: "20px 0 8px",
};

const emptyIconStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 52,
  height: 52,
  borderRadius: 14,
  background: "#232326",
  border: `1px solid ${BORDER}`,
  opacity: 0.85,
};

/* connected hero */
const heroConnectedStyle: CSSProperties = {
  position: "relative",
  overflow: "hidden",
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: 16,
  borderRadius: 14,
  background: "linear-gradient(135deg, rgba(37,211,102,0.16), rgba(18,140,75,0.06))",
  border: "1px solid rgba(37,211,102,0.32)",
};

const heroGlowStyle: CSSProperties = {
  position: "absolute",
  top: -40,
  right: -30,
  width: 140,
  height: 140,
  borderRadius: "50%",
  background: "radial-gradient(circle, rgba(37,211,102,0.25), transparent 70%)",
  pointerEvents: "none",
};

const heroIconWrapStyle: CSSProperties = {
  position: "relative",
  zIndex: 1,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 46,
  height: 46,
  flexShrink: 0,
  borderRadius: "50%",
  background: `linear-gradient(135deg, ${ACCENT}, ${ACCENT_DK})`,
  boxShadow: "0 6px 16px rgba(37,211,102,0.4)",
};

const heroEyebrowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: ACCENT,
};

const heroNumberStyle: CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
  letterSpacing: 0.3,
  margin: "3px 0 2px",
  fontVariantNumeric: "tabular-nums",
};

const heroSubStyle: CSSProperties = { fontSize: 12, color: "#b8b8bd", lineHeight: 1.4 };

const dotGreen: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: ACCENT,
  boxShadow: `0 0 8px ${ACCENT}`,
};

const dotAmber: CSSProperties = { ...dotGreen, background: "#e0a32e", boxShadow: "0 0 8px #e0a32e" };

const cardStyle: CSSProperties = {
  padding: 14,
  background: CARD,
  border: `1px solid ${BORDER}`,
  borderRadius: 12,
};

const cardLabelStyle: CSSProperties = { fontWeight: 600, fontSize: 13.5, marginBottom: 3 };

const hintStyle: CSSProperties = { color: MUTED, fontSize: 12.5, lineHeight: 1.5, margin: 0 };

const rowBetween: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 14,
};

const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "10px 12px",
  background: "#0e0e10",
  border: `1px solid ${BORDER}`,
  borderRadius: 9,
  color: "#f2f2f2",
  fontSize: 13.5,
  outline: "none",
};

const primaryBtnStyle: CSSProperties = {
  padding: "10px 18px",
  background: `linear-gradient(135deg, ${ACCENT}, ${ACCENT_DK})`,
  color: "#062012",
  border: "none",
  borderRadius: 9,
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const linkBtnStyle: CSSProperties = {
  marginTop: 10,
  padding: 0,
  background: "transparent",
  color: "#9a9aa0",
  border: "none",
  cursor: "pointer",
  fontSize: 12,
  textDecoration: "underline",
  alignSelf: "flex-start",
  display: "block",
};

const ghostBtnStyle: CSSProperties = {
  padding: "8px 14px",
  background: "transparent",
  color: MUTED,
  border: `1px solid ${BORDER}`,
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 12.5,
  fontWeight: 600,
};

/* danger zone */
const dangerZoneStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 14,
  padding: 14,
  marginTop: 2,
  background: "rgba(255,90,82,0.06)",
  border: "1px solid rgba(255,90,82,0.28)",
  borderRadius: 12,
};

const dangerOutlineBtnStyle: CSSProperties = {
  flexShrink: 0,
  padding: "9px 16px",
  background: "transparent",
  color: DANGER,
  border: `1px solid rgba(255,90,82,0.55)`,
  borderRadius: 9,
  cursor: "pointer",
  fontSize: 12.5,
  fontWeight: 700,
  whiteSpace: "nowrap",
};

const dangerBtnStyle: CSSProperties = {
  padding: "9px 14px",
  background: DANGER,
  color: "#2a0a08",
  border: "none",
  borderRadius: 9,
  cursor: "pointer",
  fontSize: 12.5,
  fontWeight: 700,
  whiteSpace: "nowrap",
};

const segmentStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  padding: 4,
  background: "#0e0e10",
  border: `1px solid ${BORDER}`,
  borderRadius: 11,
};

const segStyle: CSSProperties = {
  flex: 1,
  padding: "9px 0",
  background: "transparent",
  border: "none",
  color: MUTED,
  cursor: "pointer",
  fontSize: 13,
  borderRadius: 8,
  fontWeight: 600,
  transition: "background 0.15s, color 0.15s",
};

const segActiveStyle: CSSProperties = {
  ...segStyle,
  background: CARD,
  color: "#f2f2f2",
  boxShadow: "0 1px 2px rgba(0,0,0,0.3)",
};

const qrLayoutStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "center",
  gap: 20,
};

const qrSideStyle: CSSProperties = {
  flex: 1,
  minWidth: 220,
};

const qrFrameStyle: CSSProperties = {
  display: "inline-block",
  padding: 12,
  background: "#fff",
  borderRadius: 14,
  boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
  flexShrink: 0,
};

const qrPlaceholderStyle: CSSProperties = {
  width: 210,
  height: 210,
  display: "inline-flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  background: "#0e0e10",
  borderRadius: 8,
  color: MUTED,
  fontSize: 12.5,
};

const stepsStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  marginTop: 16,
  textAlign: "left",
};

const stepRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
};

const stepNumStyle: CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  borderRadius: "50%",
  background: "rgba(37,211,102,0.15)",
  border: "1px solid rgba(37,211,102,0.4)",
  color: ACCENT,
  fontSize: 11,
  fontWeight: 700,
};

const waitingRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  marginTop: 16,
  fontSize: 12.5,
  color: MUTED,
};

const spinnerStyle: CSSProperties = {
  width: 20,
  height: 20,
  border: "2px solid #333",
  borderTopColor: ACCENT,
  borderRadius: "50%",
  display: "inline-block",
  animation: "wa-spin 0.7s linear infinite",
};

const spinnerSmStyle: CSSProperties = {
  width: 13,
  height: 13,
  border: "2px solid #333",
  borderTopColor: ACCENT,
  borderRadius: "50%",
  display: "inline-block",
  animation: "wa-spin 0.7s linear infinite",
};

const pairingCodeBoxStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  marginTop: 14,
  padding: "14px 16px",
  background: "#0e0e10",
  border: `1px solid rgba(37,211,102,0.3)`,
  borderRadius: 12,
};

const pairingCodeTextStyle: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 26,
  fontWeight: 700,
  letterSpacing: 4,
  color: ACCENT,
};

const copyBtnStyle: CSSProperties = {
  flexShrink: 0,
  padding: "7px 14px",
  background: "rgba(37,211,102,0.14)",
  color: ACCENT,
  border: "1px solid rgba(37,211,102,0.4)",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 12.5,
  fontWeight: 700,
};

const noticeStyle: CSSProperties = {
  color: "#f0a0a0",
  fontSize: 12.5,
  lineHeight: 1.5,
  margin: 0,
  padding: "10px 12px",
  background: "rgba(255,90,82,0.08)",
  border: "1px solid rgba(255,90,82,0.3)",
  borderRadius: 9,
};

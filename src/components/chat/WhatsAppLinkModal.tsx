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
 * WhatsApp link modal â€” pair the workspace's ai-ide-whatsapp sidecar
 * with the user's WhatsApp account so the agent can ping them when a
 * task completes / needs a permission / asks a question, AND so they
 * can drive the agent by texting from their phone.
 *
 *  - Polls /api/whatsapp/status on open. If `paired=true`, we show the
 *    linked-state UI with an Unlink button.
 *  - Otherwise we poll /api/whatsapp/qr every 2s and render the QR
 *    PNG returned by the sidecar (qrPngUrl is a data: URL). Switching
 *    to the "phone number" tab POSTs to /pair-phone and surfaces the
 *    8-char pairing code instead â€” same end result, different entry
 *    point for users who can't scan.
 *  - When status flips to paired (the polling sees it), we
 *    auto-switch to the linked-state UI.
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
        /* swallow â€” the toggle just won't render until next open */
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
  // Electron (browser dev â€” there are no tabs).
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
        /* swallow â€” if list/hide fails the modal still renders, just over a
           visible tab. Better than crashing the modal. */
      }
    })();

    return () => {
      cancelled = true;
      if (hiddenIds.length === 0) return;
      // Restore on close â€” fire and forget; any tab that got destroyed
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

  // QR polling â€” only while the modal is open, the QR tab is selected,
  // status fetched, and we're NOT already paired.
  useEffect(() => {
    if (!open) return;
    if (tab !== "qr") return;
    if (status?.paired) return;
    if (status && !status.configured) return; // 503 â€” nothing to poll

    let cancelled = false;
    const fetchQr = async () => {
      try {
        const res = await fetch(whatsappQrUrl());
        const body = (await res.json()) as QrResponse;
        if (cancelled) return;
        if (body.error) setError(body.error);
        else setQr(body);
      } catch {
        /* transient â€” try again on next tick */
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
          ? `Saved. Notifications will go to ${body.recipientPhone}.`
          : "Cleared. Notifications will go to your own Message Yourself chat."
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
      /* swallow â€” we'll learn the result from the next status poll */
    } finally {
      setBusy(false);
      setQr(null);
      setPairingCode(null);
    }
  };

  if (!open) return null;

  const isPaired = !!status?.paired;
  const isUnconfigured = status && status.configured === false;

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
        {/* â”€â”€ Header â”€â”€ */}
        <div style={headerStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={waBadgeStyle}>
              <WhatsAppGlyph />
            </span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Link WhatsApp</div>
              <div style={{ fontSize: 12, color: MUTED }}>
                {isPaired ? "Connected device" : "Pair your account"}
              </div>
            </div>
          </div>
          <button type="button" onClick={onClose} style={closeBtnStyle} aria-label="Close">
            Ã—
          </button>
        </div>

        <div style={contentStyle}>
          {isUnconfigured ? (
            <p style={noticeStyle}>
              WhatsApp isn&apos;t installed on this workspace yet. Ask the
              operator to enable the sidecar.
            </p>
          ) : isPaired ? (
            <>
              {/* status pill */}
              <div style={statusPillStyle}>
                <span style={status?.connected === false ? dotAmber : dotGreen} />
                <span style={{ fontWeight: 600 }}>
                  {status?.phone ?? status?.jid}
                </span>
                <span style={{ color: MUTED, fontSize: 12, marginLeft: "auto" }}>
                  {status?.connected === false ? "reconnectingâ€¦" : "linked"}
                </span>
              </div>

              {/* recipient */}
              <div style={cardStyle}>
                <div style={cardLabelStyle}>Recipient</div>
                <div style={hintStyle}>
                  Where messages go â€” defaults to your Message&nbsp;Yourself chat.
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
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
                    style={primaryBtnStyle}
                  >
                    {recipientBusy ? "Savingâ€¦" : "Save"}
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
                  <div>
                    <div style={cardLabelStyle}>Always forward</div>
                    <div style={hintStyle}>
                      Push every prompt to WhatsApp, even while you&apos;re here.
                    </div>
                  </div>
                  <Switch
                    on={forwardingEnabled === true}
                    disabled={forwardingBusy || forwardingEnabled === null}
                    onChange={(next) => void handleToggleForwarding(next)}
                  />
                </div>
              </div>

              {/* unlink */}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                {unlinkConfirm ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 12, color: MUTED }}>Remove this device?</span>
                    <button type="button" onClick={handleUnlink} disabled={busy} style={dangerBtnStyle}>
                      {busy ? "Unlinkingâ€¦" : "Unlink"}
                    </button>
                    <button type="button" onClick={() => setUnlinkConfirm(false)} style={linkBtnStyle}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={handleUnlink} disabled={busy} style={linkDangerStyle}>
                    Unlink device
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <p style={hintStyle}>
                Get pinged when a task finishes, needs approval, or asks a
                question â€” reply to drive the agent.
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
                <div style={{ textAlign: "center" }}>
                  {qr?.qrPngUrl ? (
                    <img
                      src={qr.qrPngUrl}
                      alt="WhatsApp QR code"
                      width={220}
                      height={220}
                      style={{ background: "#fff", padding: 10, borderRadius: 10 }}
                    />
                  ) : (
                    <div style={qrPlaceholderStyle}>
                      <span style={{ ...spinnerStyle }} />
                      Generating codeâ€¦
                    </div>
                  )}
                  <p style={{ ...hintStyle, marginTop: 12 }}>
                    WhatsApp â†’ <strong>Linked Devices</strong> â†’ Link a Device,
                    then scan.
                  </p>
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
                      style={primaryBtnStyle}
                    >
                      {busy ? "â€¦" : "Get code"}
                    </button>
                  </div>
                  <p style={{ ...hintStyle, marginTop: 8 }}>
                    Enter the code in WhatsApp â†’ Linked Devices â†’ Link with
                    phone number.
                  </p>
                  {pairingCode && (
                    <div style={pairingCodeBoxStyle}>
                      <div style={pairingCodeTextStyle}>{pairingCode}</div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {error && <p style={noticeStyle}>{error}</p>}
        </div>
      </div>
    </div>
  );
}

/* â”€â”€ Small UI atoms â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

function WhatsAppGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" aria-hidden>
      <path d="M12 2a10 10 0 0 0-8.5 15.3L2 22l4.8-1.5A10 10 0 1 0 12 2Zm5.4 14.1c-.2.6-1.2 1.2-1.7 1.2-.4 0-1 .1-3.3-.9-2.8-1.2-4.5-4-4.6-4.2-.1-.2-1-1.4-1-2.6 0-1.3.6-1.9.9-2.1.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.4.6c-.2.2-.3.4-.1.7.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.4 2.4 1.5.2.1.4.1.6-.1l.7-.8c.2-.2.3-.2.6-.1l1.9.9c.3.1.5.2.5.4.1.2.1.7-.1 1.2Z" />
    </svg>
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
        width: 40,
        height: 22,
        borderRadius: 999,
        border: "none",
        flexShrink: 0,
        background: on ? ACCENT : "#3a3a3a",
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
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "#fff",
          transition: "left 0.18s",
          boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
        }}
      />
    </button>
  );
}

/* â”€â”€ Styles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */

const ACCENT = "#25D366";
const MUTED = "#8a8a8a";
const SURFACE = "#161616";
const CARD = "#1d1d1d";
const BORDER = "#2a2a2a";

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.6)",
  backdropFilter: "blur(2px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalStyle: CSSProperties = {
  background: SURFACE,
  color: "#ededed",
  borderRadius: 16,
  width: "min(400px, 94vw)",
  maxHeight: "88vh",
  overflowY: "auto",
  border: `1px solid ${BORDER}`,
  boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
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
  width: 32,
  height: 32,
  borderRadius: 9,
  background: ACCENT,
};

const closeBtnStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: MUTED,
  fontSize: 22,
  lineHeight: 1,
  cursor: "pointer",
  padding: 4,
};

const contentStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 18,
};

const statusPillStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 12px",
  background: CARD,
  border: `1px solid ${BORDER}`,
  borderRadius: 10,
  fontSize: 13,
};

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
  borderRadius: 10,
};

const cardLabelStyle: CSSProperties = { fontWeight: 600, fontSize: 13.5 };

const hintStyle: CSSProperties = { color: MUTED, fontSize: 12.5, lineHeight: 1.5, margin: 0 };

const rowBetween: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

const inputStyle: CSSProperties = {
  flex: 1,
  padding: "9px 11px",
  background: "#0e0e0e",
  border: `1px solid ${BORDER}`,
  borderRadius: 8,
  color: "#ededed",
  fontSize: 13,
  outline: "none",
};

const primaryBtnStyle: CSSProperties = {
  padding: "9px 16px",
  background: ACCENT,
  color: "#06210f",
  border: "none",
  borderRadius: 8,
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const linkBtnStyle: CSSProperties = {
  marginTop: 8,
  padding: 0,
  background: "transparent",
  color: "#9aa",
  border: "none",
  cursor: "pointer",
  fontSize: 12,
  textDecoration: "underline",
  alignSelf: "flex-start",
};

const linkDangerStyle: CSSProperties = {
  padding: 0,
  background: "transparent",
  color: "#d66",
  border: "none",
  cursor: "pointer",
  fontSize: 12.5,
};

const dangerBtnStyle: CSSProperties = {
  padding: "7px 12px",
  background: "#2a1414",
  color: "#f08a8a",
  border: "1px solid #5a2424",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 12.5,
  fontWeight: 600,
};

const segmentStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  padding: 4,
  background: "#0e0e0e",
  border: `1px solid ${BORDER}`,
  borderRadius: 10,
};

const segStyle: CSSProperties = {
  flex: 1,
  padding: "8px 0",
  background: "transparent",
  border: "none",
  color: MUTED,
  cursor: "pointer",
  fontSize: 13,
  borderRadius: 7,
  fontWeight: 600,
};

const segActiveStyle: CSSProperties = {
  ...segStyle,
  background: CARD,
  color: "#ededed",
};

const qrPlaceholderStyle: CSSProperties = {
  width: 220,
  height: 220,
  display: "inline-flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  background: "#0e0e0e",
  border: `1px solid ${BORDER}`,
  borderRadius: 10,
  color: MUTED,
  fontSize: 12.5,
  margin: "0 auto",
};

const spinnerStyle: CSSProperties = {
  width: 18,
  height: 18,
  border: "2px solid #333",
  borderTopColor: ACCENT,
  borderRadius: "50%",
  display: "inline-block",
  animation: "wa-spin 0.7s linear infinite",
};

const pairingCodeBoxStyle: CSSProperties = {
  marginTop: 12,
  padding: 14,
  background: "#0e0e0e",
  border: `1px solid ${BORDER}`,
  borderRadius: 10,
  textAlign: "center",
};

const pairingCodeTextStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: 24,
  fontWeight: 700,
  letterSpacing: 4,
  color: ACCENT,
};

const noticeStyle: CSSProperties = {
  color: "#f0a0a0",
  fontSize: 12.5,
  lineHeight: 1.5,
  margin: 0,
  padding: "10px 12px",
  background: "#2a1414",
  border: "1px solid #4a2020",
  borderRadius: 8,
};

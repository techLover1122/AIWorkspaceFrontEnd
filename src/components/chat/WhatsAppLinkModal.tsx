"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  whatsappPairPhoneUrl,
  whatsappQrUrl,
  whatsappStatusUrl,
  whatsappUnlinkUrl,
} from "../../constant/api";

/**
 * WhatsApp link modal — pair the workspace's ai-ide-whatsapp sidecar
 * with the user's WhatsApp account so the agent can ping them when a
 * task completes / needs a permission / asks a question, AND so they
 * can drive the agent by texting from their phone.
 *
 *  - Polls /api/whatsapp/status on open. If `paired=true`, we show the
 *    linked-state UI with an Unlink button.
 *  - Otherwise we poll /api/whatsapp/qr every 2s and render the QR
 *    PNG returned by the sidecar (qrPngUrl is a data: URL). Switching
 *    to the "phone number" tab POSTs to /pair-phone and surfaces the
 *    8-char pairing code instead — same end result, different entry
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

  const handleUnlink = async () => {
    const ok = window.confirm(
      "Unlink WhatsApp? You'll need to re-scan the QR or re-pair to receive notifications again."
    );
    if (!ok) return;
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
        <div style={headerStyle}>
          <strong>Link WhatsApp</strong>
          <button type="button" onClick={onClose} style={closeBtnStyle} aria-label="Close">
            ×
          </button>
        </div>

        {isUnconfigured ? (
          <p style={errorStyle}>
            WhatsApp integration isn&apos;t installed on this workspace. The operator
            needs to run the cloud-init step that builds and starts the
            ai-ide-whatsapp sidecar.
          </p>
        ) : isPaired ? (
          <div style={bodyStyle}>
            <p>
              Linked as <code>{status?.phone ?? status?.jid}</code>
              {status?.connected === false && (
                <span style={{ color: "#c66", marginLeft: 8 }}>(reconnecting…)</span>
              )}
            </p>
            <p style={subtleStyle}>
              The agent will ping this number when a task finishes, asks for a
              permission, or opens a question — and you can drive the agent by
              texting the &quot;Message Yourself&quot; chat in WhatsApp.
            </p>
            <button
              type="button"
              onClick={handleUnlink}
              disabled={busy}
              style={dangerBtnStyle}
            >
              {busy ? "Unlinking…" : "Unlink"}
            </button>
          </div>
        ) : (
          <div style={bodyStyle}>
            <div style={tabsStyle}>
              <button
                type="button"
                onClick={() => setTab("qr")}
                style={tab === "qr" ? activeTabStyle : tabStyle}
              >
                Scan QR
              </button>
              <button
                type="button"
                onClick={() => setTab("phone")}
                style={tab === "phone" ? activeTabStyle : tabStyle}
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
                    width={256}
                    height={256}
                    style={{ background: "#fff", padding: 8, borderRadius: 6 }}
                  />
                ) : (
                  <div style={qrPlaceholderStyle}>Waiting for QR…</div>
                )}
                <ol style={instructionListStyle}>
                  <li>Open WhatsApp on your phone.</li>
                  <li>
                    Go to <em>Settings → Linked Devices → Link a Device</em>.
                  </li>
                  <li>Scan this code.</li>
                </ol>
              </div>
            ) : (
              <div>
                <p style={subtleStyle}>
                  Enter your WhatsApp number (with country code). You&apos;ll get an
                  8-character pairing code to type under{" "}
                  <em>Linked Devices → Link with phone number</em>.
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    type="tel"
                    placeholder="+14155552671"
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
                    {busy ? "Requesting…" : "Get code"}
                  </button>
                </div>
                {pairingCode && (
                  <div style={pairingCodeBoxStyle}>
                    <div style={subtleStyle}>Enter in WhatsApp:</div>
                    <div style={pairingCodeTextStyle}>{pairingCode}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {error && <p style={errorStyle}>{error}</p>}
      </div>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalStyle: CSSProperties = {
  background: "#1e1e1e",
  color: "#e6e6e6",
  borderRadius: 8,
  padding: 20,
  width: "min(440px, 92vw)",
  maxHeight: "90vh",
  overflowY: "auto",
  boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 12,
};

const closeBtnStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#aaa",
  fontSize: 22,
  cursor: "pointer",
};

const bodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const tabsStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  borderBottom: "1px solid #333",
  marginBottom: 8,
};

const tabStyle: CSSProperties = {
  padding: "8px 14px",
  background: "transparent",
  border: "none",
  color: "#999",
  cursor: "pointer",
  fontSize: 13,
};

const activeTabStyle: CSSProperties = {
  ...tabStyle,
  color: "#e6e6e6",
  borderBottom: "2px solid #25d366",
};

const subtleStyle: CSSProperties = { color: "#999", fontSize: 13 };

const qrPlaceholderStyle: CSSProperties = {
  width: 256,
  height: 256,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#0e0e0e",
  borderRadius: 6,
  color: "#666",
  margin: "0 auto",
};

const instructionListStyle: CSSProperties = {
  textAlign: "left",
  fontSize: 13,
  color: "#bbb",
  marginTop: 12,
};

const inputStyle: CSSProperties = {
  flex: 1,
  padding: "8px 10px",
  background: "#0e0e0e",
  border: "1px solid #333",
  borderRadius: 4,
  color: "#e6e6e6",
};

const primaryBtnStyle: CSSProperties = {
  padding: "8px 14px",
  background: "#25d366",
  color: "#0b1f0b",
  border: "none",
  borderRadius: 4,
  fontWeight: 600,
  cursor: "pointer",
};

const dangerBtnStyle: CSSProperties = {
  padding: "8px 14px",
  background: "transparent",
  color: "#e66",
  border: "1px solid #623",
  borderRadius: 4,
  cursor: "pointer",
  alignSelf: "flex-start",
};

const pairingCodeBoxStyle: CSSProperties = {
  marginTop: 14,
  padding: 12,
  background: "#0e0e0e",
  borderRadius: 6,
  textAlign: "center",
};

const pairingCodeTextStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: 22,
  letterSpacing: 2,
  marginTop: 4,
};

const errorStyle: CSSProperties = {
  color: "#e88",
  fontSize: 13,
  marginTop: 10,
};

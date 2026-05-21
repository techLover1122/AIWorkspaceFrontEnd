"use client";

import { useCallback, useEffect, useState } from "react";
import { portScanUrl } from "../../constant/api";

type DetectedPort = {
  port: number;
  pid: number | null;
  processName: string | null;
  appLabel: string | null;
  address: string;
  isWebUI?: boolean;
  title?: string | null;
};

type PortsViewProps = {
  onOpen: (url: string, label: string) => void;
};

type CardStyle = { accent: string; icon: React.ReactNode };

function styleForPort(p: DetectedPort): CardStyle {
  const proc = (p.processName ?? "").toLowerCase();
  const lbl = (p.appLabel ?? "").toLowerCase();
  const title = (p.title ?? "").toLowerCase();
  const all = `${proc} ${lbl} ${title}`;

  if (/vite/.test(all) || p.port === 5173 || p.port === 5174) {
    return {
      accent: "#646cff",
      icon: (
        <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
          <polygon points="16,2 30,28 2,28" fill="#646cff" opacity="0.9" />
          <polygon points="16,8 26,26 6,26" fill="#ffbd2e" opacity="0.85" />
        </svg>
      ),
    };
  }
  if (/next/.test(all) || p.port === 3000) {
    return {
      accent: "#ffffff",
      icon: (
        <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
          <circle cx="16" cy="16" r="14" fill="#000" />
          <text x="5" y="22" fontSize="14" fontWeight="800" fill="#fff" fontFamily="monospace">N</text>
        </svg>
      ),
    };
  }
  if (/angular/.test(all) || p.port === 4200) {
    return {
      accent: "#dd0031",
      icon: (
        <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
          <polygon points="16,4 28,9 26,23 16,28 6,23 4,9" fill="#dd0031" opacity="0.9" />
          <text x="10" y="22" fontSize="11" fontWeight="900" fill="#fff" fontFamily="monospace">A</text>
        </svg>
      ),
    };
  }
  if (/django/.test(all)) {
    return {
      accent: "#44b78b",
      icon: (
        <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
          <rect width="32" height="32" rx="6" fill="#0c4b33" />
          <text x="5" y="22" fontSize="13" fontWeight="700" fill="#44b78b" fontFamily="monospace">Dj</text>
        </svg>
      ),
    };
  }
  if (/flask/.test(all)) {
    return {
      accent: "#05c4a0",
      icon: (
        <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
          <rect width="32" height="32" rx="6" fill="#0a2e2e" />
          <text x="5" y="22" fontSize="13" fontWeight="700" fill="#05c4a0" fontFamily="monospace">Fl</text>
        </svg>
      ),
    };
  }
  if (/express|node/.test(all)) {
    return {
      accent: "#68a063",
      icon: (
        <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
          <rect width="32" height="32" rx="6" fill="#1a1a1a" />
          <text x="4" y="22" fontSize="13" fontWeight="700" fill="#68a063" fontFamily="monospace">Ex</text>
        </svg>
      ),
    };
  }
  if (/code-server|vscode|^code/.test(all) || p.port === 8080) {
    return {
      accent: "#007acc",
      icon: (
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none">
          <rect x="1" y="1" width="22" height="22" rx="5" fill="#007acc" />
          <path d="M6 7.5l6 4.5-6 4.5M13 16h5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ),
    };
  }
  const letter = (p.title || p.appLabel || p.processName || `:${p.port}`)
    .replace(/\.exe$/i, "")
    .trim()
    .charAt(0)
    .toUpperCase() || "?";
  return {
    accent: "#3794ff",
    icon: (
      <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
        <rect width="32" height="32" rx="6" fill="#202833" stroke="#3794ff" strokeOpacity="0.4" />
        <text x="16" y="22" fontSize="14" fontWeight="700" fill="#3794ff" fontFamily="monospace" textAnchor="middle">{letter}</text>
      </svg>
    ),
  };
}

export function PortsView({ onOpen }: PortsViewProps) {
  const [detected, setDetected] = useState<DetectedPort[]>([]);
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState<number | null>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await fetch(portScanUrl());
      if (!res.ok) return;
      const data = (await res.json()) as { ports: DetectedPort[] };
      setDetected(data.ports ?? []);
      setLastScan(Date.now());
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    scan();
    const id = setInterval(scan, 8000);
    return () => clearInterval(id);
  }, [scan]);

  return (
    <div className="ports-view">
      <div className="ports-view-header">
        <div>
          <h2 className="ports-view-title">Running Web Servers</h2>
          <p className="ports-view-sub">
            {scanning
              ? "Scanning ports…"
              : detected.length === 0
              ? "No web servers detected"
              : `${detected.length} active web server${detected.length === 1 ? "" : "s"} on this machine`}
          </p>
        </div>
        <button
          type="button"
          className="ports-view-refresh"
          onClick={scan}
          disabled={scanning}
          title="Refresh now"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
            <path
              d="M3 8a5 5 0 0 1 9-3M13 3v3h-3M13 8a5 5 0 0 1-9 3M3 13v-3h3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {scanning ? "Scanning" : "Refresh"}
        </button>
      </div>

      <div className="ports-view-scroll">
      {detected.length === 0 ? (
        <div className="ports-view-empty">
          <div className="ports-view-empty-icon" aria-hidden>
            <svg viewBox="0 0 48 48" width="48" height="48" fill="none">
              <rect x="6" y="10" width="36" height="28" rx="3" stroke="currentColor" strokeWidth="1.6" />
              <path d="M6 18h36" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="12" cy="14" r="1" fill="currentColor" />
              <circle cx="16" cy="14" r="1" fill="currentColor" />
            </svg>
          </div>
          <p>Start any dev server (`npm run dev`, `python manage.py runserver`, etc.) and refresh.</p>
        </div>
      ) : (
        <div className="ports-view-grid">
          {detected.map((p) => {
            const url = `http://localhost:${p.port}`;
            const label = p.title || p.appLabel || (p.processName ?? "").replace(/\.exe$/i, "") || "Server";
            const style = styleForPort(p);
            return (
              <button
                key={`${p.port}-${p.pid ?? "0"}`}
                type="button"
                className="ports-view-card"
                style={{ "--ntp-card-accent": style.accent } as React.CSSProperties}
                onClick={() => onOpen(url, `${label} :${p.port}`)}
                title={`${label} · PID ${p.pid ?? "?"} · ${p.address}:${p.port}`}
              >
                <span className="ports-view-card-icon">{style.icon}</span>
                <span className="ports-view-card-port">:{p.port}</span>
              </button>
            );
          })}
        </div>
      )}
      </div>

      {lastScan && (
        <div className="ports-view-footer">
          Last scan: {new Date(lastScan).toLocaleTimeString()} · auto-refresh every 8s
        </div>
      )}
    </div>
  );
}

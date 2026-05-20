"use client";

import { useEffect, useRef, useState } from "react";

type NewTabPageProps = {
  codeServerUrl: string;
  onNavigate: (url: string, label: string) => void;
};

const PRESET_CARDS = [
  {
    id: "vite",
    label: "Vite",
    desc: "React / Vue dev server",
    port: 5173,
    bg: "#1a1a2e",
    accent: "#646cff",
    icon: (
      <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
        <polygon points="16,2 30,28 2,28" fill="#646cff" opacity="0.9" />
        <polygon points="16,8 26,26 6,26" fill="#ffbd2e" opacity="0.85" />
      </svg>
    ),
  },
  {
    id: "angular",
    label: "Angular",
    desc: "Angular CLI server",
    port: 4200,
    bg: "#1a0a0a",
    accent: "#dd0031",
    icon: (
      <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
        <rect width="32" height="32" rx="6" fill="#1a0a0a" />
        <polygon points="16,4 28,9 26,23 16,28 6,23 4,9" fill="#dd0031" opacity="0.9" />
        <text x="10" y="22" fontSize="11" fontWeight="900" fill="#fff" fontFamily="monospace">A</text>
      </svg>
    ),
  },
  {
    id: "django",
    label: "Django",
    desc: "Python backend",
    port: 8000,
    bg: "#0c4b33",
    accent: "#44b78b",
    icon: (
      <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
        <rect width="32" height="32" rx="6" fill="#0c4b33" />
        <text x="5" y="22" fontSize="13" fontWeight="700" fill="#44b78b" fontFamily="monospace">Dj</text>
      </svg>
    ),
  },
  {
    id: "express",
    label: "Express",
    desc: "Node.js backend",
    port: 3001,
    bg: "#1a1a1a",
    accent: "#68a063",
    icon: (
      <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
        <rect width="32" height="32" rx="6" fill="#1a1a1a" />
        <text x="4" y="22" fontSize="13" fontWeight="700" fill="#68a063" fontFamily="monospace">Ex</text>
      </svg>
    ),
  },
  {
    id: "flask",
    label: "Flask",
    desc: "Python micro-framework",
    port: 5001,
    bg: "#0a2e2e",
    accent: "#05c4a0",
    icon: (
      <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
        <rect width="32" height="32" rx="6" fill="#0a2e2e" />
        <text x="5" y="22" fontSize="13" fontWeight="700" fill="#05c4a0" fontFamily="monospace">Fl</text>
      </svg>
    ),
  },
];

function urlFromInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // pure port number like "5173"
  if (/^\d+$/.test(trimmed)) return `http://localhost:${trimmed}`;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return `http://${trimmed}`;
}

function labelFromUrl(url: string): string {
  try {
    const p = new URL(url);
    return p.hostname + (p.port ? `:${p.port}` : "");
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
}

export function NewTabPage({ codeServerUrl, onNavigate }: NewTabPageProps) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleGo = () => {
    const url = urlFromInput(input);
    if (!url) return;
    onNavigate(url, labelFromUrl(url));
  };

  return (
    <div className="ntp-root">
      <div className="ntp-inner">

        {/* VS Code — primary large card */}
        <button
          type="button"
          className="ntp-vscode-card"
          onClick={() => onNavigate(codeServerUrl, "VS Code")}
        >
          <span className="ntp-vscode-icon">
            <svg viewBox="0 0 24 24" width="36" height="36" fill="none">
              <rect x="1" y="1" width="22" height="22" rx="5" fill="#007acc" />
              <path d="M6 7.5l6 4.5-6 4.5M13 16h5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div className="ntp-vscode-info">
            <span className="ntp-vscode-title">VS Code Editor</span>
            <span className="ntp-vscode-url">{codeServerUrl}</span>
          </div>
          <span className="ntp-vscode-arrow">→</span>
        </button>

        {/* URL bar */}
        <div className="ntp-urlbar-wrap">
          <svg className="ntp-urlbar-icon" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="ntp-urlbar-input"
            placeholder="Enter URL or port  —  e.g.  5173  or  http://localhost:8000"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleGo(); }}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className="ntp-urlbar-go"
            onClick={handleGo}
            disabled={!input.trim()}
          >
            Open
          </button>
        </div>

        {/* Preset cards */}
        <div className="ntp-section-label">Common dev servers</div>
        <div className="ntp-grid">
          {PRESET_CARDS.map((card) => (
            <button
              key={card.id}
              type="button"
              className="ntp-card"
              style={{ "--ntp-card-accent": card.accent } as React.CSSProperties}
              onClick={() =>
                onNavigate(
                  `http://localhost:${card.port}`,
                  `${card.label} :${card.port}`
                )
              }
            >
              <span className="ntp-card-icon">{card.icon}</span>
              <span className="ntp-card-label">{card.label}</span>
              <span className="ntp-card-port">:{card.port}</span>
              <span className="ntp-card-desc">{card.desc}</span>
            </button>
          ))}
        </div>

      </div>
    </div>
  );
}

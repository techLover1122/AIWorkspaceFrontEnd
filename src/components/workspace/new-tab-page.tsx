"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { INSTANCE_IP, urlsUrl, urlByIdUrl } from "../../constant/api";

// Sentinel URL recognized by preview-pane.tsx — when a tab opens this
// URL it renders <TerminalView /> instead of an iframe.
export const TERMINAL_VIEW_URL = "aiide://terminal";

type NewTabPageProps = {
  codeServerUrl: string;
  onNavigate: (url: string, label: string) => void;
};

type PinnedTile = {
  id: string;
  label: string;
  url: string;
  icon: React.ReactNode;
};

type SavedUrl = {
  id: number;
  name: string | null;
  icon: string | null;
  url: string;
  created_at: number;
};

function urlFromInput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^\d+$/.test(trimmed)) return `http://${INSTANCE_IP}:${trimmed}`;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  return `http://${trimmed}`;
}

function hostFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] ?? url;
  }
}

function fallbackLetter(s: string): string {
  const c = s.replace(/^https?:\/\//, "").trim().charAt(0).toUpperCase();
  return c || "?";
}

export function NewTabPage({ codeServerUrl, onNavigate }: NewTabPageProps) {
  const [input, setInput] = useState("");
  const [saved, setSaved] = useState<SavedUrl[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [iconErrors, setIconErrors] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  const loadUrls = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(urlsUrl());
      if (!res.ok) return;
      const data = (await res.json()) as { urls: SavedUrl[] };
      setSaved(data.urls ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUrls();
  }, [loadUrls]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleAdd = useCallback(async () => {
    const url = urlFromInput(input);
    if (!url) return;
    setAdding(true);
    try {
      const res = await fetch(urlsUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) return;
      setInput("");
      await loadUrls();
    } finally {
      setAdding(false);
    }
  }, [input, loadUrls]);

  const handleDelete = useCallback(
    async (id: number, e: React.MouseEvent) => {
      e.stopPropagation();
      await fetch(urlByIdUrl(id), { method: "DELETE" });
      setSaved((prev) => prev.filter((u) => u.id !== id));
    },
    []
  );

  const onIconError = useCallback((id: number) => {
    setIconErrors((s) => {
      if (s.has(id)) return s;
      const next = new Set(s);
      next.add(id);
      return next;
    });
  }, []);

  // Built-in tiles that always sit at the front of the grid — VS Code
  // editor and an in-workspace terminal. They use the same tile look as
  // saved bookmarks but have no delete button (built-in, can't be
  // removed). codeServerUrl is captured so it stays correct when the
  // workspace URL changes.
  const pinnedTiles = useMemo<PinnedTile[]>(
    () => [
      {
        id: "vscode",
        label: "VS Code Editor",
        url: codeServerUrl,
        icon: (
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
            <rect x="1" y="1" width="22" height="22" rx="5" fill="#007acc" />
            <path
              d="M6 7.5l6 4.5-6 4.5M13 16h5"
              stroke="#fff"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ),
      },
      {
        id: "terminal",
        label: "Terminal",
        url: TERMINAL_VIEW_URL,
        icon: (
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
            <rect
              x="1.5"
              y="3"
              width="21"
              height="18"
              rx="3"
              fill="#1c1c1c"
              stroke="#3794ff"
              strokeWidth="1.4"
            />
            <path
              d="M5 9l3 3-3 3M10 15h5"
              stroke="#73c991"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ),
      },
    ],
    [codeServerUrl]
  );

  return (
    <div className="ntp-root">
      <div className="ntp-inner">
        {/* URL add bar */}
        <div className="ntp-urlbar-wrap">
          <svg className="ntp-urlbar-icon" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="ntp-urlbar-input"
            placeholder="Add a URL or port — e.g. 5173, localhost:3000, https://github.com"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
            spellCheck={false}
            autoComplete="off"
            disabled={adding}
          />
          <button
            type="button"
            className="ntp-urlbar-go"
            onClick={handleAdd}
            disabled={!input.trim() || adding}
          >
            {adding ? "Adding…" : "Add"}
          </button>
        </div>

        {/* Saved URLs */}
        <div className="ntp-section-row">
          <span className="ntp-section-label">
            Saved URLs
            {loading && <span className="ntp-scanning-dot" aria-hidden />}
          </span>
          <button
            type="button"
            className="ntp-refresh-btn"
            onClick={loadUrls}
            title="Reload"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden>
              <path
                d="M3 8a5 5 0 0 1 9-3M13 3v3h-3M13 8a5 5 0 0 1-9 3M3 13v-3h3"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <div className="ntp-grid">
          {pinnedTiles.map((tile) => (
            <div
              key={tile.id}
              className="ntp-card ntp-bookmark-card ntp-pinned-card"
              onClick={() => onNavigate(tile.url, tile.label)}
              title={tile.label}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onNavigate(tile.url, tile.label);
                }
              }}
            >
              <span className="ntp-bookmark-icon">{tile.icon}</span>
              <span className="ntp-bookmark-name">{tile.label}</span>
            </div>
          ))}
          {saved.map((u) => {
            const displayName = u.name || hostFromUrl(u.url);
            const showImg = u.icon && !iconErrors.has(u.id);
            return (
              <div
                key={u.id}
                className="ntp-card ntp-bookmark-card"
                onClick={() => onNavigate(u.url, displayName)}
                title={`${displayName}\n${u.url}`}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onNavigate(u.url, displayName);
                  }
                }}
              >
                <button
                  type="button"
                  className="ntp-bookmark-delete"
                  onClick={(e) => handleDelete(u.id, e)}
                  onMouseDown={(e) => e.stopPropagation()}
                  title="Remove"
                  aria-label="Delete bookmark"
                >
                  <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden>
                    <path
                      d="M4 4l8 8M12 4l-8 8"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
                <span className="ntp-bookmark-icon">
                  {showImg ? (
                    <img
                      src={u.icon!}
                      alt=""
                      width={32}
                      height={32}
                      loading="lazy"
                      onError={() => onIconError(u.id)}
                    />
                  ) : (
                    <span className="ntp-bookmark-letter" aria-hidden>
                      {fallbackLetter(displayName)}
                    </span>
                  )}
                </span>
                <span className="ntp-bookmark-name">{displayName}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

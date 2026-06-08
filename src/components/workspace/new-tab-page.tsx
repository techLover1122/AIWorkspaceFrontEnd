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

/** Collapse-key for a bookmark: its base URL (scheme + host + port). Two
 *  saved URLs that differ only by path / query / name share one key, so the
 *  grid shows a single tile per service instead of one per visited page. */
function baseUrlKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "");
  }
}

/** Pick the best representative among same-base bookmarks: prefer a custom
 *  name, then a real icon, then the earliest-created (the original entry). */
function dedupeByBase(urls: SavedUrl[]): SavedUrl[] {
  const score = (s: SavedUrl) => (s.name ? 2 : 0) + (s.icon ? 1 : 0);
  const byBase = new Map<string, SavedUrl>();
  for (const u of urls) {
    const key = baseUrlKey(u.url);
    const cur = byBase.get(key);
    if (
      !cur ||
      score(u) > score(cur) ||
      (score(u) === score(cur) && u.created_at < cur.created_at)
    ) {
      byBase.set(key, u);
    }
  }
  return Array.from(byBase.values());
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

  // Deleting the single tile shown for a base URL removes every saved row
  // that shares that base — otherwise a hidden duplicate would just take its
  // place on the next reload and the tile would look un-deletable.
  const handleDelete = useCallback(
    async (rep: SavedUrl, e: React.MouseEvent) => {
      e.stopPropagation();
      const key = baseUrlKey(rep.url);
      const victims = saved.filter((u) => baseUrlKey(u.url) === key);
      setSaved((prev) => prev.filter((u) => baseUrlKey(u.url) !== key));
      await Promise.all(
        victims.map((u) =>
          fetch(urlByIdUrl(u.id), { method: "DELETE" }).catch(() => {})
        )
      );
    },
    [saved]
  );

  // One tile per base URL — collapses the "same site opened at many paths"
  // duplicates the user was seeing into a single bookmark.
  const dedupedSaved = useMemo(() => dedupeByBase(saved), [saved]);

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
          {dedupedSaved.map((u) => {
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
                  onClick={(e) => handleDelete(u, e)}
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

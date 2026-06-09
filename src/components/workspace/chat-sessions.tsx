"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatInputHandle } from "../chat/ChatInput";
import { ChatPanel } from "./chat-panel";

/* ------------------------------------------------------------------
 * ChatSessions
 *
 * Hosts N independent chat sessions in the single chat-panel slot. Each
 * session is its own <ChatPanel> with a namespaced persistence key, so
 * they share one working directory without clobbering each other's
 * transcript. ALL sessions stay mounted — only the active one is visible
 * (the rest are display:none) — so a background session's server task
 * keeps streaming live and is already up to date when you switch back.
 * The tab strip shows a "running" dot for any session with an in-flight
 * turn.
 *
 * The first session uses the LEGACY persistence namespace (no sessionKey),
 * so a chat saved before multi-session simply shows up as "Session 1".
 * ------------------------------------------------------------------ */

type Session = {
  id: string;
  title: string;
  /** Persistence namespace passed to ChatPanel. Undefined for the first
   *  session = legacy single-session key (preserves the pre-existing chat). */
  storageKey?: string;
};

type SessionsSnapshot = { sessions: Session[]; activeId: string };

const SESSIONS_PREFIX = "ai-ide:chat-sessions";
// Must match the prefix in useChatState so closing a session can evict its
// stored transcript.
const CHAT_STATE_PREFIX = "aiide.chat.state";

function snapshotKey(cwd?: string): string {
  return `${SESSIONS_PREFIX}::${cwd ?? "__default__"}`;
}

function defaultSnapshot(): SessionsSnapshot {
  return { sessions: [{ id: "main", title: "Session 1" }], activeId: "main" };
}

function loadSnapshot(cwd?: string): SessionsSnapshot {
  if (typeof window === "undefined") return defaultSnapshot();
  try {
    const raw = window.localStorage.getItem(snapshotKey(cwd));
    if (!raw) return defaultSnapshot();
    const parsed = JSON.parse(raw) as SessionsSnapshot;
    if (
      !parsed ||
      !Array.isArray(parsed.sessions) ||
      parsed.sessions.length === 0
    ) {
      return defaultSnapshot();
    }
    const activeId = parsed.sessions.some((s) => s.id === parsed.activeId)
      ? parsed.activeId
      : parsed.sessions[0].id;
    return { sessions: parsed.sessions, activeId };
  } catch {
    return defaultSnapshot();
  }
}

function saveSnapshot(cwd: string | undefined, snap: SessionsSnapshot): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(snapshotKey(cwd), JSON.stringify(snap));
  } catch {
    /* quota / disabled — ignore */
  }
}

type ChatSessionsProps = {
  workingDirectory?: string;
  onChangeProject?: (path: string) => void;
  /** Snapshot-send ref from WorkspaceShell. Forwarded to whichever session
   *  is currently active so the annotation Send flow drops its PNG into the
   *  visible composer. */
  chatInputRef?: React.Ref<ChatInputHandle>;
};

export function ChatSessions({
  workingDirectory,
  onChangeProject,
  chatInputRef,
}: ChatSessionsProps) {
  const [snap, setSnap] = useState<SessionsSnapshot>(() =>
    loadSnapshot(workingDirectory)
  );
  // Per-session in-flight flag, fed by each panel's onLoadingChange — drives
  // the running dot on background tabs.
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});

  // Reload the session set when the working directory changes (each project
  // keeps its own tabs).
  const lastCwdRef = useRef(workingDirectory);
  useEffect(() => {
    if (lastCwdRef.current === workingDirectory) return;
    lastCwdRef.current = workingDirectory;
    setSnap(loadSnapshot(workingDirectory));
    setLoadingMap({});
  }, [workingDirectory]);

  // Persist on any change.
  useEffect(() => {
    saveSnapshot(workingDirectory, snap);
  }, [workingDirectory, snap]);

  const activeIdRef = useRef(snap.activeId);
  activeIdRef.current = snap.activeId;

  /* --- Forward the external chatInputRef to the active session's input --- */

  const assignExternal = useCallback(
    (handle: ChatInputHandle | null) => {
      const r = chatInputRef;
      if (!r) return;
      if (typeof r === "function") r(handle);
      else (r as React.MutableRefObject<ChatInputHandle | null>).current = handle;
    },
    [chatInputRef]
  );

  // Each panel registers its ChatInput handle here; the active one is mirrored
  // onto the external ref.
  const handlesRef = useRef<Map<string, ChatInputHandle | null>>(new Map());
  const refCbsRef = useRef<Map<string, (h: ChatInputHandle | null) => void>>(
    new Map()
  );

  const getRefCb = useCallback(
    (id: string) => {
      let cb = refCbsRef.current.get(id);
      if (!cb) {
        cb = (h: ChatInputHandle | null) => {
          handlesRef.current.set(id, h);
          if (id === activeIdRef.current) assignExternal(h);
        };
        refCbsRef.current.set(id, cb);
      }
      return cb;
    },
    [assignExternal]
  );

  // Re-point the external ref whenever the active session changes.
  useEffect(() => {
    assignExternal(handlesRef.current.get(snap.activeId) ?? null);
  }, [snap.activeId, assignExternal]);

  const handleLoadingChange = useCallback((id: string, loading: boolean) => {
    setLoadingMap((m) => (m[id] === loading ? m : { ...m, [id]: loading }));
  }, []);

  const selectSession = useCallback((id: string) => {
    setSnap((prev) => (prev.activeId === id ? prev : { ...prev, activeId: id }));
  }, []);

  const addSession = useCallback(() => {
    setSnap((prev) => {
      const nums = prev.sessions.map((s) => {
        const m = s.title.match(/(\d+)\s*$/);
        return m ? parseInt(m[1], 10) : 0;
      });
      const n = (nums.length ? Math.max(...nums) : 0) + 1;
      const id = `s_${Date.now().toString(36)}_${prev.sessions.length}`;
      const session: Session = { id, title: `Session ${n}`, storageKey: id };
      return { sessions: [...prev.sessions, session], activeId: id };
    });
  }, []);

  const closeSession = useCallback(
    (id: string) => {
      setSnap((prev) => {
        if (prev.sessions.length <= 1) return prev; // never close the last one
        const idx = prev.sessions.findIndex((s) => s.id === id);
        if (idx < 0) return prev;
        const closed = prev.sessions[idx];

        // Evict the closed session's persisted transcript so it doesn't
        // linger in localStorage. Only namespaced (non-legacy) sessions get
        // a dedicated key; the legacy "main" session is left untouched.
        if (typeof window !== "undefined" && closed.storageKey) {
          try {
            window.localStorage.removeItem(
              `${CHAT_STATE_PREFIX}::${workingDirectory ?? "__default__"}::${closed.storageKey}`
            );
          } catch {
            /* ignore */
          }
        }

        const sessions = prev.sessions.filter((s) => s.id !== id);
        let activeId = prev.activeId;
        if (activeId === id) {
          const neighbor = sessions[Math.min(idx, sessions.length - 1)];
          activeId = neighbor.id;
        }
        return { sessions, activeId };
      });
      setLoadingMap((m) => {
        if (!(id in m)) return m;
        const next = { ...m };
        delete next[id];
        return next;
      });
      handlesRef.current.delete(id);
      refCbsRef.current.delete(id);
    },
    [workingDirectory]
  );

  const renameSession = useCallback((id: string, firstPrompt: string) => {
    const raw = firstPrompt.replace(/\s+/g, " ").trim();
    const title = raw.length > 30 ? raw.slice(0, 28) + "…" : raw || "Session";
    setSnap((prev) => {
      const sessions = prev.sessions.map((s) =>
        s.id === id ? { ...s, title } : s
      );
      return { ...prev, sessions };
    });
  }, []);

  return (
    <div className="chat-sessions">
      <div className="chat-session-tabs" role="tablist" aria-label="Chat sessions">
        {snap.sessions.map((s) => {
          const isActive = s.id === snap.activeId;
          const isRunning = !!loadingMap[s.id];
          return (
            <div
              key={s.id}
              role="tab"
              aria-selected={isActive}
              className={`chat-session-tab${isActive ? " active" : ""}${isRunning ? " running" : ""}`}
              onClick={() => selectSession(s.id)}
              title={s.title}
            >
              <span className="chat-session-title">{s.title}</span>
              {snap.sessions.length > 1 && (
                <button
                  type="button"
                  className="chat-session-close tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSession(s.id);
                  }}
                  title="Close session"
                  aria-label={`Close ${s.title}`}
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
              )}
            </div>
          );
        })}
        <button
          type="button"
          className="chat-session-add tab-add"
          onClick={addSession}
          title="New session"
          aria-label="New session"
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              d="M8 3v10M3 8h10"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="chat-session-bodies">
        {snap.sessions.map((s) => {
          const isActive = s.id === snap.activeId;
          return (
            <div
              key={s.id}
              className="chat-session-body"
              style={{ display: isActive ? "flex" : "none" }}
            >
              <ChatPanel
                workingDirectory={workingDirectory}
                onChangeProject={onChangeProject}
                chatInputRef={getRefCb(s.id)}
                sessionKey={s.storageKey}
                active={isActive}
                onLoadingChange={(l) => handleLoadingChange(s.id, l)}
                onFirstMessage={(text) => renameSession(s.id, text)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

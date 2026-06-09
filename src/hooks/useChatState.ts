"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { ChatMessage, ChatState } from "../types/types";

let idCounter = 0;
function nextId(): string {
  return `msg_${Date.now()}_${++idCounter}`;
}

/** Safe rAF wrapper: SSR doesn't have requestAnimationFrame, fall back
 *  to setTimeout so the module import doesn't blow up during build. */
const raf =
  typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame.bind(window)
    : (cb: FrameRequestCallback): number =>
        setTimeout(() => cb(performance.now()), 16) as unknown as number;
const cancelRaf =
  typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function"
    ? window.cancelAnimationFrame.bind(window)
    : (id: number): void => clearTimeout(id as unknown as NodeJS.Timeout);

export function createUserMessage(
  text: string,
  imageUrls?: string[]
): ChatMessage {
  return {
    id: nextId(),
    type: "chat",
    role: "user",
    content: text,
    timestamp: Date.now(),
    ...(imageUrls && imageUrls.length > 0 ? { imageUrls } : {}),
  };
}

export function createAssistantMessage(text?: string): ChatMessage {
  return {
    id: nextId(),
    type: "chat",
    role: "assistant",
    content: text ?? "",
    timestamp: Date.now(),
    isStreaming: true,
  };
}

/** Scan the array from the end and return the index of the last message that
 *  is still marked as streaming. -1 if none. */
function findLastStreamingIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isStreaming) return i;
  }
  return -1;
}

/* ============================================================
   localStorage persistence
   ------------------------------------------------------------
   Keyed by workingDirectory so switching projects gets each
   project's own chat back. We persist messages + sessionId +
   taskId + lastSeq — `isLoading` is intentionally NOT persisted;
   it's derived from "is there an active server task" at mount.
   ============================================================ */

const STORAGE_PREFIX = "aiide.chat.state";

type PersistedSnapshot = {
  messages: ChatMessage[];
  sessionId: string | null;
  taskId: string | null;
  lastSeq: number;
};

function storageKey(
  workingDirectory?: string | null,
  sessionKey?: string | null
): string {
  const base = `${STORAGE_PREFIX}::${workingDirectory ?? "__default__"}`;
  // No sessionKey → legacy single-session key (preserves chats saved before
  // multi-session). A sessionKey suffixes the namespace so each tab keeps an
  // independent transcript under the same working directory.
  return sessionKey ? `${base}::${sessionKey}` : base;
}

function readPersisted(
  workingDirectory?: string | null,
  sessionKey?: string | null
): PersistedSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(workingDirectory, sessionKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSnapshot;
    if (!parsed || !Array.isArray(parsed.messages)) return null;
    return {
      messages: parsed.messages,
      sessionId: parsed.sessionId ?? null,
      taskId: parsed.taskId ?? null,
      lastSeq: typeof parsed.lastSeq === "number" ? parsed.lastSeq : -1,
    };
  } catch {
    return null;
  }
}

function writePersisted(
  workingDirectory: string | undefined | null,
  sessionKey: string | undefined | null,
  snapshot: PersistedSnapshot
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKey(workingDirectory, sessionKey),
      JSON.stringify(snapshot)
    );
  } catch {
    // localStorage may be full / disabled — silently degrade.
  }
}

function clearPersisted(
  workingDirectory?: string | null,
  sessionKey?: string | null
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(workingDirectory, sessionKey));
  } catch {
    /* ignore */
  }
}

/* ============================================================
   useChatState
   ============================================================ */

/**
 * Backing state for a single chat panel. When `workingDirectory` is
 * provided, the state is persisted to localStorage keyed by that path —
 * switching projects and returning later restores each project's
 * conversation. The persisted snapshot also carries the active server
 * `taskId` + `lastSeq` so a page reload can reattach to in-flight work.
 */
export function useChatState(
  workingDirectory?: string | null,
  sessionKey?: string | null
) {
  // Hydrate synchronously on first mount so the chat panel doesn't
  // flicker through "empty" before the persisted snapshot loads.
  const [state, setState] = useState<ChatState>(() => {
    const persisted = readPersisted(workingDirectory, sessionKey);
    return {
      messages: persisted?.messages ?? [],
      sessionId: persisted?.sessionId ?? null,
      isLoading: false,
      currentRequestId: persisted?.taskId ?? null,
      lastSeq: persisted?.lastSeq ?? -1,
    };
  });

  const stateRef = useRef(state);
  stateRef.current = state;

  /* ------------------------------------------------------------
   * Streaming-chunk batching
   *
   * Claude's SDK emits one stream event per small text fragment — often
   * 2-5 chars at a time. Calling setState per fragment is what made long
   * chats feel laggy: each setState re-renders ChatMessages, which (even
   * with React.memo on Message) still has to walk the whole array.
   *
   * Instead we buffer incoming chunks in a ref and flush at most once
   * per animation frame (~60Hz). The user perceives the same smooth
   * streaming because the screen can't repaint faster than 60fps anyway,
   * but the React render cost drops to 1 update/frame regardless of how
   * fast the SDK is firing.
   *
   * Important: every non-append state update (addMessage, finalize, etc)
   * MUST flush the pending buffer first — otherwise a buffered text
   * chunk would end up appended AFTER a tool-call message that arrived
   * later, scrambling the transcript ordering.
   * ------------------------------------------------------------ */
  const pendingChunkRef = useRef<string>("");
  const rafIdRef = useRef<number | null>(null);

  const applyPendingChunk = useCallback(() => {
    const chunk = pendingChunkRef.current;
    if (!chunk) return;
    pendingChunkRef.current = "";
    setState((prev) => {
      const messages = [...prev.messages];
      const idx = findLastStreamingIndex(messages);
      if (idx >= 0) {
        messages[idx] = {
          ...messages[idx],
          content: messages[idx].content + chunk,
        };
      } else {
        messages.push({
          id: nextId(),
          type: "chat",
          role: "assistant",
          content: chunk,
          timestamp: Date.now(),
          isStreaming: true,
        });
      }
      return { ...prev, messages };
    });
  }, []);

  const flushPending = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelRaf(rafIdRef.current);
      rafIdRef.current = null;
    }
    applyPendingChunk();
  }, [applyPendingChunk]);

  // Cancel any pending rAF on unmount so we don't fire setState on a
  // dead component (React warns about that).
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelRaf(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  // When the workspace switches projects, swap to that project's
  // persisted chat. workingDirectory acts as the namespace key.
  const lastWorkingDirRef = useRef<string | null | undefined>(workingDirectory);
  useEffect(() => {
    if (lastWorkingDirRef.current === workingDirectory) return;
    lastWorkingDirRef.current = workingDirectory;
    // Discard any half-buffered chunk from the previous project's stream.
    pendingChunkRef.current = "";
    if (rafIdRef.current !== null) {
      cancelRaf(rafIdRef.current);
      rafIdRef.current = null;
    }
    const persisted = readPersisted(workingDirectory, sessionKey);
    setState({
      messages: persisted?.messages ?? [],
      sessionId: persisted?.sessionId ?? null,
      isLoading: false,
      currentRequestId: persisted?.taskId ?? null,
      lastSeq: persisted?.lastSeq ?? -1,
    });
  }, [workingDirectory, sessionKey]);

  // Persist on any meaningful state change. `isLoading` isn't persisted —
  // it gets re-derived when the chat panel decides whether to reattach
  // to the stored taskId on mount.
  useEffect(() => {
    writePersisted(workingDirectory, sessionKey, {
      messages: state.messages,
      sessionId: state.sessionId,
      taskId: state.currentRequestId,
      lastSeq: state.lastSeq,
    });
  }, [
    workingDirectory,
    sessionKey,
    state.messages,
    state.sessionId,
    state.currentRequestId,
    state.lastSeq,
  ]);

  const addMessage = useCallback(
    (message: ChatMessage) => {
      flushPending();
      setState((prev) => ({ ...prev, messages: [...prev.messages, message] }));
    },
    [flushPending]
  );

  const updateLastMessage = useCallback(
    (content: string) => {
      flushPending();
      setState((prev) => {
        const messages = [...prev.messages];
        const idx = findLastStreamingIndex(messages);
        if (idx >= 0) {
          messages[idx] = { ...messages[idx], content };
        }
        return { ...prev, messages };
      });
    },
    [flushPending]
  );

  /**
   * Append a streaming chunk to the latest *streaming* assistant message.
   * Buffers chunks in a ref and flushes once per animation frame instead
   * of firing setState per chunk — see the comment block above for why.
   */
  const appendToLastMessage = useCallback((chunk: string) => {
    if (!chunk) return;
    pendingChunkRef.current += chunk;
    if (rafIdRef.current === null) {
      rafIdRef.current = raf(() => {
        rafIdRef.current = null;
        applyPendingChunk();
      });
    }
  }, [applyPendingChunk]);

  const finalizeLastMessage = useCallback(() => {
    flushPending();
    setState((prev) => {
      const messages = [...prev.messages];
      const idx = findLastStreamingIndex(messages);
      if (idx >= 0) {
        messages[idx] = { ...messages[idx], isStreaming: false };
      }
      return { ...prev, messages };
    });
  }, [flushPending]);

  const setSessionId = useCallback((id: string) => {
    setState((prev) => ({ ...prev, sessionId: id }));
  }, []);

  const setLoading = useCallback((loading: boolean) => {
    setState((prev) => ({ ...prev, isLoading: loading }));
  }, []);

  const setCurrentRequestId = useCallback((id: string | null) => {
    setState((prev) => ({ ...prev, currentRequestId: id }));
  }, []);

  const setLastSeq = useCallback((seq: number) => {
    // Cursor advances ONLY on strictly-increasing seq. This protects
    // against the backend's "re-emit pending permission" path sending
    // an old permission_request seq on reattach — if we accepted
    // smaller seqs the resume cursor would regress and the next
    // reconnect would re-fetch already-processed events.
    setState((prev) => (seq <= prev.lastSeq ? prev : { ...prev, lastSeq: seq }));
  }, []);

  /**
   * Force-reset the seq cursor to -1. Called when starting a brand-new
   * task (the new task's first event is at seq 0, so the next attach
   * needs `from=0` not `from=oldHighWater+1`). Bypasses the monotonic
   * guard on setLastSeq — that's only for stream-callback writes.
   */
  const resetSeqCursor = useCallback(() => {
    setState((prev) => (prev.lastSeq === -1 ? prev : { ...prev, lastSeq: -1 }));
  }, []);

  const setMessages = useCallback(
    (messages: ChatMessage[]) => {
      // Discard any buffered streaming chunk — it belongs to whatever
      // session we're replacing, not the new history.
      pendingChunkRef.current = "";
      if (rafIdRef.current !== null) {
        cancelRaf(rafIdRef.current);
        rafIdRef.current = null;
      }
      setState((prev) => ({ ...prev, messages }));
    },
    []
  );

  const reset = useCallback(() => {
    pendingChunkRef.current = "";
    if (rafIdRef.current !== null) {
      cancelRaf(rafIdRef.current);
      rafIdRef.current = null;
    }
    setState({
      messages: [],
      sessionId: null,
      isLoading: false,
      currentRequestId: null,
      lastSeq: -1,
    });
    clearPersisted(workingDirectory, sessionKey);
  }, [workingDirectory, sessionKey]);

  return {
    state,
    addMessage,
    updateLastMessage,
    appendToLastMessage,
    finalizeLastMessage,
    setSessionId,
    setLoading,
    setCurrentRequestId,
    setLastSeq,
    resetSeqCursor,
    setMessages,
    reset,
    stateRef,
  };
}

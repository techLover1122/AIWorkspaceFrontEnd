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

export function useChatState() {
  const [state, setState] = useState<ChatState>({
    messages: [],
    sessionId: null,
    isLoading: false,
    currentRequestId: null,
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
    setState({ messages: [], sessionId: null, isLoading: false, currentRequestId: null });
  }, []);

  return {
    state,
    addMessage,
    updateLastMessage,
    appendToLastMessage,
    finalizeLastMessage,
    setSessionId,
    setLoading,
    setCurrentRequestId,
    setMessages,
    reset,
    stateRef,
  };
}

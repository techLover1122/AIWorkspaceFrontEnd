"use client";

import { useState, useCallback, useRef } from "react";
import type { ChatMessage, ChatState } from "../types/types";

let idCounter = 0;
function nextId(): string {
  return `msg_${Date.now()}_${++idCounter}`;
}

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

  const addMessage = useCallback((message: ChatMessage) => {
    setState((prev) => ({ ...prev, messages: [...prev.messages, message] }));
  }, []);

  const updateLastMessage = useCallback((content: string) => {
    setState((prev) => {
      const messages = [...prev.messages];
      const idx = findLastStreamingIndex(messages);
      if (idx >= 0) {
        messages[idx] = { ...messages[idx], content };
      }
      return { ...prev, messages };
    });
  }, []);

  /**
   * Append a streaming chunk to the latest *streaming* assistant message
   * (regardless of position — system/tool messages may sit in between). If
   * no streaming assistant exists yet, create one so the text isn't lost.
   */
  const appendToLastMessage = useCallback((chunk: string) => {
    setState((prev) => {
      const messages = [...prev.messages];
      const idx = findLastStreamingIndex(messages);
      if (idx >= 0) {
        messages[idx] = { ...messages[idx], content: messages[idx].content + chunk };
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

  const finalizeLastMessage = useCallback(() => {
    setState((prev) => {
      const messages = [...prev.messages];
      const idx = findLastStreamingIndex(messages);
      if (idx >= 0) {
        messages[idx] = { ...messages[idx], isStreaming: false };
      }
      return { ...prev, messages };
    });
  }, []);

  const setSessionId = useCallback((id: string) => {
    setState((prev) => ({ ...prev, sessionId: id }));
  }, []);

  const setLoading = useCallback((loading: boolean) => {
    setState((prev) => ({ ...prev, isLoading: loading }));
  }, []);

  const setCurrentRequestId = useCallback((id: string | null) => {
    setState((prev) => ({ ...prev, currentRequestId: id }));
  }, []);

  const setMessages = useCallback((messages: ChatMessage[]) => {
    setState((prev) => ({ ...prev, messages }));
  }, []);

  const reset = useCallback(() => {
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

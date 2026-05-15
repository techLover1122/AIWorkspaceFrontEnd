"use client";

import { useCallback, useState } from "react";
import type { ChatMessage } from "../types/types";
import { conversationUrl } from "../constant/api";
import { convertHistoryMessages } from "../utils/messageConverter";

interface HistoryLoaderState {
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  sessionId: string | null;
}

interface HistoryLoaderResult extends HistoryLoaderState {
  loadHistory: (encodedProjectName: string, sessionId: string) => Promise<void>;
  clearHistory: () => void;
}

/**
 * Fetches a previous Claude Code conversation from the backend
 * (/api/projects/:enc/histories/:sid) and converts the raw SDK messages
 * into the UI's ChatMessage[] shape.
 */
export function useHistoryLoader(): HistoryLoaderResult {
  const [state, setState] = useState<HistoryLoaderState>({
    messages: [],
    loading: false,
    error: null,
    sessionId: null,
  });

  const loadHistory = useCallback(
    async (encodedProjectName: string, sessionId: string) => {
      if (!encodedProjectName || !sessionId) {
        setState((prev) => ({
          ...prev,
          error: "Encoded project name and session ID are required",
        }));
        return;
      }

      setState((prev) => ({ ...prev, loading: true, error: null }));

      try {
        const response = await fetch(conversationUrl(encodedProjectName, sessionId));
        if (!response.ok) {
          throw new Error(`Failed to load conversation: HTTP ${response.status}`);
        }

        const data: { sessionId?: string; messages?: unknown[] } = await response.json();
        if (!Array.isArray(data.messages)) {
          throw new Error("Invalid conversation history response");
        }

        const messages = convertHistoryMessages(data.messages);

        setState({
          messages,
          loading: false,
          error: null,
          sessionId: data.sessionId ?? sessionId,
        });
      } catch (err) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error:
            err instanceof Error ? err.message : "Failed to load conversation history",
        }));
      }
    },
    []
  );

  const clearHistory = useCallback(() => {
    setState({ messages: [], loading: false, error: null, sessionId: null });
  }, []);

  return { ...state, loadHistory, clearHistory };
}

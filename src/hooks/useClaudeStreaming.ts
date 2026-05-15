"use client";

import { useCallback, useRef } from "react";
import { chatUrl, abortUrl } from "../constant/api";
import type {
  ChatMessage,
  ChatRequest,
  PermissionMode,
  PermissionRequest,
  StreamResponse,
} from "../types/types";

type StreamingCallbacks = {
  onMessage: (msg: ChatMessage) => void;
  onAppend: (chunk: string) => void;
  onFinalize: () => void;
  onSessionId: (id: string) => void;
  onPermissionError: (req: PermissionRequest) => void;
  onDone: () => void;
  onError: (error: string) => void;
};

export function useClaudeStreaming() {
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const abort = useCallback(async (requestId: string) => {
    try {
      await fetch(abortUrl(requestId), { method: "POST" });
    } catch { }
    readerRef.current?.cancel();
    readerRef.current = null;
  }, []);

  const send = useCallback(
    async (
      request: ChatRequest,
      callbacks: StreamingCallbacks
    ) => {
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch(chatUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal,
        });

        if (!response.ok) {
          callbacks.onError(`HTTP ${response.status}: ${response.statusText}`);
          return;
        }

        if (!response.body) {
          callbacks.onError("No response body");
          return;
        }

        const reader = response.body.getReader();
        readerRef.current = reader;
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed: StreamResponse = JSON.parse(line);
              await processStreamResponse(parsed, request, callbacks);
            } catch { }
          }
        }

        if (buffer.trim()) {
          try {
            const parsed: StreamResponse = JSON.parse(buffer);
            await processStreamResponse(parsed, request, callbacks);
          } catch { }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name !== "AbortError") {
          callbacks.onError(err.message);
        }
      } finally {
        readerRef.current = null;
        abortRef.current = null;
      }
    },
    []
  );

  return { send, abort };
}

async function processStreamResponse(
  parsed: StreamResponse,
  request: ChatRequest,
  callbacks: StreamingCallbacks
) {
  switch (parsed.type) {
    case "claude_json": {
      const sdkMsg = parsed.data as Record<string, unknown>;
      if (!sdkMsg?.type) return;

      const sessionId = sdkMsg.session_id as string | undefined;
      if (sessionId) {
        callbacks.onSessionId(sessionId);
      }

      const messageType = sdkMsg.type as string;

      if (messageType === "assistant") {
        const apiMsg = sdkMsg.message as Record<string, unknown> | undefined;
        const content = apiMsg?.content as Array<Record<string, unknown>> | undefined;
        if (!content) return;

        for (const block of content) {
          const blockType = block.type as string;

          if (blockType === "text") {
            const text = (block.text as string) ?? "";
            if (text) {
              callbacks.onAppend(text);
            }
          } else if (blockType === "tool_use") {
            callbacks.onFinalize();
            callbacks.onMessage({
              id: `tool_${Date.now()}`,
              type: "tool",
              role: "assistant",
              content: (block.name as string) ?? "unknown",
              timestamp: Date.now(),
              toolName: block.name as string,
              toolUseId: block.id as string,
              toolInput: (block.input as Record<string, unknown>) ?? undefined,
            });
          } else if (blockType === "thinking") {
            callbacks.onFinalize();
            callbacks.onMessage({
              id: `think_${Date.now()}`,
              type: "thinking",
              role: "assistant",
              content: (block.thinking as string) ?? "",
              timestamp: Date.now(),
            });
          }
        }
      } else if (messageType === "user") {
        callbacks.onFinalize();
        const apiMsg = sdkMsg.message as Record<string, unknown> | undefined;
        const content = apiMsg?.content as Array<Record<string, unknown>> | undefined;
        if (!content) return;

        for (const block of content) {
          if (block.type === "tool_result") {
            const textContent = (block.content as Array<Record<string, unknown>>)?.[0];
            const resultText = textContent?.text as string ?? "";
            callbacks.onMessage({
              id: `result_${Date.now()}`,
              type: "tool_result",
              content: resultText.slice(0, 500),
              timestamp: Date.now(),
              toolName: (block.tool_use_id as string) ?? "",
              toolUseResult: {
                summary: resultText.slice(0, 200),
                isError: (block.is_error as boolean) ?? false,
              },
            });

            if (block.is_error) {
              const toolUseId = sdkMsg.parent_tool_use_id as string;
              if (toolUseId) {
                callbacks.onPermissionError({
                  toolName: "tool",
                  toolUseId,
                  patterns: [resultText.slice(0, 100)],
                  isPlanMode: request.permissionMode === "plan",
                });
              }
            }
          }
        }
      } else if (messageType === "result") {
        callbacks.onFinalize();
      } else if (messageType === "system") {
        callbacks.onFinalize();
      }
      break;
    }
    case "done":
      callbacks.onFinalize();
      callbacks.onDone();
      break;
    case "error":
      callbacks.onError(parsed.error ?? "Unknown error");
      break;
    case "aborted":
      callbacks.onFinalize();
      break;
  }
}

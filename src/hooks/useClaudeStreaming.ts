"use client";

import { useCallback, useRef } from "react";
import { chatUrl, abortUrl } from "../constant/api";
import type {
  AskUserQuestionItem,
  AskUserQuestionRequest,
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
  /** Structured permission ask from SDK canUseTool callback. */
  onPermissionRequest: (req: PermissionRequest) => void;
  onAskUserQuestion?: (req: AskUserQuestionRequest) => void;
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

      // Guarantee exactly one terminal callback (onDone / onError) fires per
      // request so the chat-panel's isLoading + typing animation always clears,
      // even if the server closes the stream without emitting a "done" event
      // or the network drops mid-stream.
      let settled = false;
      const wrapped: StreamingCallbacks = {
        ...callbacks,
        onDone: () => {
          if (settled) return;
          settled = true;
          callbacks.onDone();
        },
        onError: (e: string) => {
          if (settled) return;
          settled = true;
          callbacks.onError(e);
        },
      };

      try {
        const response = await fetch(chatUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: controller.signal,
        });

        if (!response.ok) {
          wrapped.onError(`HTTP ${response.status}: ${response.statusText}`);
          return;
        }

        if (!response.body) {
          wrapped.onError("No response body");
          return;
        }

        const reader = response.body.getReader();
        readerRef.current = reader;
        const decoder = new TextDecoder();
        let buffer = "";
        const toolRegistry = new Map<string, string>();

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
              await processStreamResponse(parsed, request, wrapped, toolRegistry);
            } catch { }
          }
        }

        if (buffer.trim()) {
          try {
            const parsed: StreamResponse = JSON.parse(buffer);
            await processStreamResponse(parsed, request, wrapped, toolRegistry);
          } catch { }
        }

        // Stream closed cleanly but no "done" event arrived — server hung up
        // mid-turn (session end, backend crash, proxy timeout). Surface it so
        // the user sees an error message instead of a frozen typing bubble.
        if (!settled) {
          wrapped.onError(
            "Connection to Claude ended before the response finished. " +
              "The session may have timed out or the backend disconnected. " +
              "Please try again."
          );
        }
      } catch (err: unknown) {
        if (controller.signal.aborted) {
          // User-initiated stop — handleStop() already cleared loading state.
          // Mark settled so the finally block doesn't fire a spurious error.
          settled = true;
        } else if (err instanceof Error && err.name !== "AbortError") {
          wrapped.onError(err.message || "Network error while streaming");
        }
      } finally {
        readerRef.current = null;
        abortRef.current = null;
        // Final safety net — if nothing above settled (e.g. unexpected throw
        // path), still clear the loading state so the UI doesn't stay stuck.
        if (!settled) {
          wrapped.onError("Stream ended unexpectedly.");
        }
      }
    },
    []
  );

  return { send, abort };
}

async function processStreamResponse(
  parsed: StreamResponse,
  request: ChatRequest,
  callbacks: StreamingCallbacks,
  toolRegistry: Map<string, string>   // toolUseId -> toolName
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
            const toolId = block.id as string;
            const toolName = (block.name as string) ?? "unknown";
            // Save mapping so permission errors can look up the real name
            if (toolId) toolRegistry.set(toolId, toolName);

            // AskUserQuestion: open our modal instead of rendering the call
            // as a regular "tool" message. The SDK will auto-error this call
            // (no host handler); the suppression branch in tool_result skips
            // surfacing that error so the user only sees the modal.
            if (toolName === "AskUserQuestion" && callbacks.onAskUserQuestion) {
              const input = (block.input as Record<string, unknown>) ?? {};
              const questions =
                (input.questions as AskUserQuestionItem[] | undefined) ?? [];
              // eslint-disable-next-line no-console
              console.log("[askUserQuestion:intercept]", {
                toolUseId: toolId,
                questionCount: questions.length,
                questions: questions.map((q) => ({
                  header: q.header,
                  question: q.question,
                  multiSelect: !!q.multiSelect,
                  optionCount: q.options?.length ?? 0,
                  options: q.options?.map((o) => o.label),
                })),
              });
              callbacks.onFinalize();
              callbacks.onAskUserQuestion({
                toolUseId: toolId,
                questions,
              });
              continue;
            }

            callbacks.onFinalize();
            callbacks.onMessage({
              id: `tool_${Date.now()}`,
              type: "tool",
              role: "assistant",
              content: toolName,
              timestamp: Date.now(),
              toolName,
              toolUseId: toolId,
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
            // tool_result.content can be either:
            //   - a string (legacy / simple errors)
            //   - an array of content blocks: [{ type: "text", text: "..." }, ...]
            // Some SDK paths (notably silent auto-denials of Write/Edit/Bash)
            // send is_error=true with an EMPTY content. Normalize all shapes.
            const rawContent = block.content as unknown;
            let resultText = "";
            if (typeof rawContent === "string") {
              resultText = rawContent;
            } else if (Array.isArray(rawContent)) {
              resultText = rawContent
                .map((c) => {
                  if (typeof c === "string") return c;
                  if (c && typeof c === "object") {
                    return (
                      ((c as Record<string, unknown>).text as string) ?? ""
                    );
                  }
                  return "";
                })
                .filter(Boolean)
                .join("\n");
            }
            const blockToolUseId = (block.tool_use_id as string) ?? "";
            const isErr = (block.is_error as boolean) ?? false;

            // If this is the auto-generated error for our intercepted
            // AskUserQuestion call, swallow it entirely — the modal handles
            // the UX. Otherwise the user would see a red error AND the modal.
            const isAskUserQuestionResult =
              toolRegistry.get(blockToolUseId) === "AskUserQuestion";
            if (isAskUserQuestionResult) {
              // eslint-disable-next-line no-console
              console.log("[askUserQuestion:suppress-error]", {
                toolUseId: blockToolUseId,
                isError: isErr,
                fullText: resultText.slice(0, 200),
              });
              continue;
            }

            callbacks.onMessage({
              id: `result_${Date.now()}`,
              type: "tool_result",
              content: resultText.slice(0, 500),
              timestamp: Date.now(),
              toolName: blockToolUseId,
              toolUseResult: {
                summary: resultText.slice(0, 200),
                isError: isErr,
              },
            });

            if (isErr) {
              // Permission decisions now flow through the SDK's canUseTool
              // callback (backend) → "permission_request" stream event
              // (handled below). By the time a tool_result with is_error
              // reaches us, the tool actually RAN and failed for a real
              // reason (file not found, command exited non-zero, etc.) —
              // no permission inference needed.
              const realToolName =
                toolRegistry.get(blockToolUseId) ||
                (sdkMsg.parent_tool_use_id
                  ? toolRegistry.get(sdkMsg.parent_tool_use_id as string)
                  : undefined) ||
                "tool";
              // eslint-disable-next-line no-console
              console.warn("[tool_error]", {
                tool: realToolName,
                toolUseId: blockToolUseId,
                fullText: resultText.slice(0, 500),
              });
              const displayText = resultText.trim() || "(empty error body)";
              callbacks.onMessage({
                id: `err_${Date.now()}`,
                type: "error",
                content: `${realToolName} error: ${displayText.slice(0, 2000)}`,
                timestamp: Date.now(),
              });
            }
          }
        }
      } else if (messageType === "result") {
        callbacks.onFinalize();
      } else if (messageType === "system") {
        // The SDK emits `{ type: "system", subtype: "permission_denied", ... }`
        // for AUTO-denials (deny rules, classifiers). canUseTool handles the
        // "ask" path now, so this is only informational — log + surface a
        // soft system note, no permission UI (granting wouldn't help; the
        // SDK already decided).
        const subtype = sdkMsg.subtype as string | undefined;
        if (subtype === "permission_denied") {
          const toolName = (sdkMsg.tool_name as string) ?? "(unknown)";
          const toolUseId = (sdkMsg.tool_use_id as string) ?? "";
          const reason = (sdkMsg.decision_reason as string) ?? "";
          const reasonType = (sdkMsg.decision_reason_type as string) ?? "";
          const denialMsg = (sdkMsg.message as string) ?? "";
          // eslint-disable-next-line no-console
          console.warn("[permission_denied]", {
            toolName,
            toolUseId,
            reasonType,
            reason,
            denialMsg,
          });
          callbacks.onFinalize();
          callbacks.onMessage({
            id: `pd_${Date.now()}`,
            type: "system",
            content:
              `Tool "${toolName}" was auto-denied` +
              (reasonType ? ` (${reasonType})` : "") +
              (reason ? `: ${reason}` : denialMsg ? `: ${denialMsg}` : "") +
              `.`,
            timestamp: Date.now(),
          });
        } else {
          callbacks.onFinalize();
        }
      }
      break;
    }
    case "permission_request": {
      // Structured permission request from the backend's canUseTool
      // callback — the proper non-regex flow. data shape mirrors
      // PermissionRequestPayload from backend/handlers/permission.ts.
      const payload = parsed.data as {
        id: string;
        toolUseId: string;
        toolName: string;
        input?: Record<string, unknown>;
        title?: string;
        displayName?: string;
        description?: string;
        blockedPath?: string;
        decisionReason?: string;
        suggestions?: Record<string, unknown>[];
      } | undefined;
      if (!payload) break;
      // eslint-disable-next-line no-console
      console.log("[permission_request]", payload);
      callbacks.onFinalize();
      callbacks.onPermissionRequest({
        id: payload.id,
        toolName: payload.toolName,
        toolUseId: payload.toolUseId,
        input: payload.input,
        title: payload.title,
        displayName: payload.displayName,
        description: payload.description,
        blockedPath: payload.blockedPath,
        decisionReason: payload.decisionReason,
        suggestions: payload.suggestions,
        isPlanMode: request.permissionMode === "plan",
      });
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
    case "heartbeat":
      // Backend keep-alive tick — no UI effect. Its only job is to make the
      // proxy chain see bytes flowing so the stream isn't reaped during a
      // long permission wait or a slow model response.
      break;
  }
}

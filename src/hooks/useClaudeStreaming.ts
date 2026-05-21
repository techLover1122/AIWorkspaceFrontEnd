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
              await processStreamResponse(parsed, request, callbacks, toolRegistry);
            } catch { }
          }
        }

        if (buffer.trim()) {
          try {
            const parsed: StreamResponse = JSON.parse(buffer);
            await processStreamResponse(parsed, request, callbacks, toolRegistry);
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
              const toolUseId =
                blockToolUseId ||
                (sdkMsg.parent_tool_use_id as string) ||
                "";
              const realToolName =
                toolRegistry.get(toolUseId) ||
                toolRegistry.get(sdkMsg.parent_tool_use_id as string) ||
                "Bash";

              const lower = resultText.toLowerCase();
              // The SDK's per-path permission gate for file-editing tools.
              // Allow-once / allow-permanently against the allowedTools list
              // does NOT clear this — the user has to switch permissionMode to
              // "acceptEdits" (or bypassPermissions). Surface a hint so the
              // user understands clicking Allow again won't help.
              const isPerPathFileGate =
                /claude requested permissions to (write|edit) to/.test(lower) &&
                /haven'?t granted it yet/.test(lower);
              // Tools that the SDK auto-denies silently (with empty content)
              // when they're not in allowedTools. Treat an empty error on any
              // of these as a permission denial.
              const PERMISSION_GATED = new Set([
                "Bash",
                "Write",
                "Edit",
                "Read",
                "MultiEdit",
                "NotebookEdit",
                "WebFetch",
                "WebSearch",
              ]);
              // Tools the backend has explicitly disallowed because we don't
              // wire a response channel for them. These should NOT trigger a
              // permission UI (allowing won't help — the host can't fulfill
              // the call). Just surface a soft note in chat.
              const UNSUPPORTED_BY_HOST = new Set([
                "AskUserQuestion",
              ]);
              const looksLikePermissionText =
                /permission|not allowed|denied|requires approval|use.*tool/.test(lower);
              const looksLikeNonPermission =
                /enoent|no such file|syntax error|module not found/.test(lower);
              const emptySilentDenial =
                resultText.trim().length === 0 && PERMISSION_GATED.has(realToolName);
              const isUnsupportedHostTool = UNSUPPORTED_BY_HOST.has(realToolName);
              const isPermission =
                !isUnsupportedHostTool &&
                (emptySilentDenial ||
                  (looksLikePermissionText && !looksLikeNonPermission));

              // eslint-disable-next-line no-console
              console.warn("[tool_error]", {
                tool: realToolName,
                toolUseId,
                isPermission,
                emptySilentDenial,
                rawContentShape: Array.isArray(rawContent)
                  ? "array"
                  : typeof rawContent,
                fullText: resultText,
                rawContent,
              });

              // Host-unsupported tools (e.g. AskUserQuestion): show a soft
              // system note instead of a red error + permission UI. Granting
              // permission wouldn't help — we have no channel to answer.
              if (isUnsupportedHostTool) {
                callbacks.onMessage({
                  id: `sys_${Date.now()}`,
                  type: "system",
                  content:
                    `Claude tried to use "${realToolName}" but this app doesn't wire a response ` +
                    `channel for it yet. Claude will ask you in plain chat instead.`,
                  timestamp: Date.now(),
                });
              } else if (isPerPathFileGate) {
                // The per-path file gate keeps firing even after Allow. Tell
                // the user how to break the loop and skip the permission UI
                // (clicking Allow won't help — the gate is mode-driven).
                callbacks.onMessage({
                  id: `err_${Date.now()}`,
                  type: "error",
                  content:
                    `${realToolName} error: ${resultText.slice(0, 600)}\n\n` +
                    `Hint: this is the SDK's per-path file gate. Adding the tool to the ` +
                    `allow-list does not clear it. Switch the permission mode chip from ` +
                    `"default" to "auto" (acceptEdits) — or "bypass" — using the chip in ` +
                    `the chat composer, then send "continue".`,
                  timestamp: Date.now(),
                });
              } else {
                // Always surface the tool error as a chat error message — but
                // synthesize text when the SDK sent an empty body so the user
                // doesn't just see "Write error: " with nothing after.
                const displayText = resultText.trim()
                  ? resultText
                  : emptySilentDenial
                    ? `(empty body — SDK auto-denied "${realToolName}" because it is not in the allowed-tools list)`
                    : "(empty error body)";
                callbacks.onMessage({
                  id: `err_${Date.now()}`,
                  type: "error",
                  content: `${realToolName} error: ${displayText.slice(0, 2000)}`,
                  timestamp: Date.now(),
                });

                if (isPermission) {
                  callbacks.onPermissionError({
                    toolName: realToolName,
                    toolUseId,
                    patterns: [realToolName],
                    isPlanMode: request.permissionMode === "plan",
                  });
                }
              }
            }
          }
        }
      } else if (messageType === "result") {
        callbacks.onFinalize();
      } else if (messageType === "system") {
        // The SDK emits `{ type: "system", subtype: "permission_denied", ... }`
        // when a tool call is auto-denied (allowedTools, deny rule, classifier).
        // This is THE authoritative permission-denial signal — much more
        // reliable than the empty-body heuristic on tool_result blocks.
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
              `Tool "${toolName}" was auto-denied by the SDK` +
              (reasonType ? ` (${reasonType})` : "") +
              (reason ? `: ${reason}` : denialMsg ? `: ${denialMsg}` : "") +
              `. Add it to allowedTools to grant permission.`,
            timestamp: Date.now(),
          });
          callbacks.onPermissionError({
            toolName,
            toolUseId,
            patterns: [toolName],
            isPlanMode: request.permissionMode === "plan",
          });
        } else {
          callbacks.onFinalize();
        }
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

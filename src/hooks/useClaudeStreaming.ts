"use client";

import { useCallback, useRef } from "react";
import { chatUrl, chatStreamUrl, abortUrl } from "../constant/api";
import type {
  AskUserQuestionItem,
  AskUserQuestionRequest,
  ChatMessage,
  ChatRequest,
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
  /** Server-side resolution of a pending permission (5-min user-absent
   *  auto-allow timer fired, task aborted server-side, etc.). UI uses
   *  this to close any stale modal and show a soft note. */
  onPermissionResolved?: (info: {
    id: string;
    decision: "auto-allow" | "auto-deny";
    reason: string;
  }) => void;
  onAskUserQuestion?: (req: AskUserQuestionRequest) => void;
  /** Live token usage from the backend — fires each turn so the chat
   *  header's CompactRing can fill without a separate polling loop. */
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  /** Fires after every successfully-processed buffered event with the
   *  new high-water seq mark. Caller persists it so a reconnect after a
   *  network blip can resume without losing or duplicating events. */
  onSeq?: (seq: number) => void;
  /** Fired when the backend confirmed a taskId — caller persists it so a
   *  page reload can reattach to the same in-flight task. */
  onTaskStarted?: (taskId: string) => void;
  /** Fired when a transient network error caused a reconnect attempt.
   *  UI can show a subtle "reconnecting…" hint without showing a fatal
   *  error. */
  onReconnecting?: (attempt: number) => void;
  onDone: () => void;
  onError: (error: string) => void;
};

/**
 * Each NDJSON line off the wire is one of:
 *   - a heartbeat:        `{ type: "heartbeat" }`
 *   - a buffered event:   `{ seq: number, event: StreamResponse }`
 * The shape lets us distinguish keepalives from real events without
 * relying on type-string overlap.
 */
type WireLine =
  | { type: "heartbeat" }
  | { seq: number; event: StreamResponse };

/** Backoff schedule for reconnect attempts. Caps at 30s. After
 *  RECONNECT_GIVE_UP_MS of consecutive failures, surface a real error. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const RECONNECT_GIVE_UP_MS = 5 * 60 * 1000;

export function useClaudeStreaming() {
  /** The fetch controller for the live streaming GET — separate from the
   *  POST controller because the POST is short-lived (returns immediately)
   *  while the GET is the long stream we may abort on user-initiated stop. */
  const streamControllerRef = useRef<AbortController | null>(null);

  /** Aborts the BACKGROUND task on the server too — calls /api/abort and
   *  also cancels the local stream reader so the loop exits promptly. */
  const abort = useCallback(async (taskId: string) => {
    try {
      await fetch(abortUrl(taskId), { method: "POST" });
    } catch {
      // The task may already be done; we still want to stop streaming.
    }
    streamControllerRef.current?.abort();
    streamControllerRef.current = null;
  }, []);

  /**
   * POST /api/chat → receive { taskId }. Returns null on connection
   * failure so the caller can retry without surfacing a fatal error.
   */
  const startTask = useCallback(
    async (request: ChatRequest): Promise<string | null> => {
      try {
        const res = await fetch(chatUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const data = (await res.json()) as { taskId?: string };
        return data.taskId ?? null;
      } catch (err: unknown) {
        // eslint-disable-next-line no-console
        console.warn("[startTask] failed:", err);
        return null;
      }
    },
    []
  );

  /**
   * Open the GET stream for an existing taskId. Auto-reconnects on
   * transient failures (network blips, proxy drops) using `fromSeq`
   * advanced past the last successfully-seen seq, so events are neither
   * lost nor duplicated.
   *
   * Returns when the task completes (done/error/aborted) OR
   * RECONNECT_GIVE_UP_MS of consecutive failures elapse.
   */
  const attachToTask = useCallback(
    async (
      taskId: string,
      fromSeq: number,
      request: ChatRequest,
      callbacks: StreamingCallbacks
    ) => {
      // Single terminal-callback latch — onDone/onError fires at most once.
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

      const toolRegistry = new Map<string, string>();
      let lastSeq = fromSeq - 1;
      let reconnectAttempt = 0;
      let firstFailureAt: number | null = null;

      // Outer loop: each iteration is one fetch attempt. Exits when the
      // task ends (settled=true) or we've given up on reconnects.
      while (!settled) {
        const controller = new AbortController();
        streamControllerRef.current = controller;

        try {
          const url = chatStreamUrl(taskId, lastSeq + 1);
          const response = await fetch(url, { signal: controller.signal });

          if (response.status === 404) {
            wrapped.onError(
              "The previous chat task is no longer available on the server. " +
                "Send a new message to start a fresh task."
            );
            return;
          }
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }
          if (!response.body) {
            throw new Error("No response body");
          }

          if (reconnectAttempt > 0) {
            // eslint-disable-next-line no-console
            console.info("[attachToTask] reconnected:", { taskId, lastSeq });
          }
          reconnectAttempt = 0;
          firstFailureAt = null;

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (!settled) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.trim()) continue;
              let parsed: WireLine | null = null;
              try {
                parsed = JSON.parse(line) as WireLine;
              } catch {
                continue;
              }
              if (!parsed) continue;
              if ("seq" in parsed && typeof parsed.seq === "number") {
                // Cursor advances ONLY on strictly-increasing seq so
                // that backend's "re-emit pending permissions" path
                // (which sends an old permission_request seq again)
                // doesn't regress the resume cursor. The event itself
                // still goes through the processor so the modal opens.
                if (parsed.seq > lastSeq) {
                  lastSeq = parsed.seq;
                  wrapped.onSeq?.(parsed.seq);
                }
                await processStreamResponse(
                  parsed.event,
                  request,
                  wrapped,
                  toolRegistry
                );
              }
              // Heartbeats are intentionally ignored — pure keepalive.
            }
            if (settled) break;
          }

          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer) as WireLine;
              if ("seq" in parsed && typeof parsed.seq === "number") {
                // Cursor advances ONLY on strictly-increasing seq so
                // that backend's "re-emit pending permissions" path
                // (which sends an old permission_request seq again)
                // doesn't regress the resume cursor. The event itself
                // still goes through the processor so the modal opens.
                if (parsed.seq > lastSeq) {
                  lastSeq = parsed.seq;
                  wrapped.onSeq?.(parsed.seq);
                }
                await processStreamResponse(
                  parsed.event,
                  request,
                  wrapped,
                  toolRegistry
                );
              }
            } catch {
              /* malformed trailing line — ignore */
            }
          }

          // Stream closed by server. If we already saw a terminal event
          // (settled=true), we're done. Otherwise this is a mid-stream
          // drop — reconnect.
          if (settled) return;
        } catch (err: unknown) {
          if (controller.signal.aborted) {
            // User-initiated stop (handleStop / new chat / unmount).
            settled = true;
            return;
          }
          // Any other error (network blip, fetch failure) → reconnect.
          // eslint-disable-next-line no-console
          console.warn("[attachToTask] stream error, will reconnect:", err);
        } finally {
          streamControllerRef.current = null;
        }

        // ───── Reconnect path ─────
        if (settled) return;

        if (firstFailureAt === null) firstFailureAt = Date.now();
        if (Date.now() - firstFailureAt > RECONNECT_GIVE_UP_MS) {
          wrapped.onError(
            "Lost connection to the chat task and couldn't reconnect after " +
              "several minutes. The task may still be running on the server — " +
              "reload the workspace to retry."
          );
          return;
        }

        const delay =
          RECONNECT_DELAYS_MS[
            Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
          ];
        reconnectAttempt += 1;
        wrapped.onReconnecting?.(reconnectAttempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    },
    []
  );

  /**
   * Convenience wrapper: POST then attach. Preserves the original
   * useClaudeStreaming.send API so the chat panel call site stays simple.
   */
  const send = useCallback(
    async (request: ChatRequest, callbacks: StreamingCallbacks) => {
      const taskId = await startTask(request);
      if (!taskId) {
        callbacks.onError("Failed to start chat task on the server.");
        return;
      }
      callbacks.onTaskStarted?.(taskId);
      await attachToTask(taskId, 0, request, callbacks);
    },
    [startTask, attachToTask]
  );

  return { send, startTask, attachToTask, abort };
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
    case "token_usage": {
      const usage = parsed.data as
        | { inputTokens?: number; outputTokens?: number }
        | undefined;
      if (usage && callbacks.onTokenUsage) {
        callbacks.onTokenUsage({
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        });
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
    case "permission_resolved": {
      // The backend auto-resolved a pending permission server-side
      // (5-min user-absent timer fired, task aborted, etc.). Forward
      // to the chat panel so any stale modal can dismiss itself.
      const info = parsed.data as
        | { id?: string; decision?: "auto-allow" | "auto-deny"; reason?: string }
        | undefined;
      if (!info?.id || !info.decision) break;
      // eslint-disable-next-line no-console
      console.log("[permission_resolved]", info);
      callbacks.onPermissionResolved?.({
        id: info.id,
        decision: info.decision,
        reason: info.reason ?? "",
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
      // Surface "aborted" as done so the chat panel can clear its
      // in-flight state.
      callbacks.onDone();
      break;
    case "heartbeat":
      // Wire-level keepalive — never reaches here because the wire
      // reader filters them out before dispatch, but kept for type
      // exhaustiveness.
      break;
  }
}

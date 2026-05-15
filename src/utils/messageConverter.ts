/**
 * Convert raw Claude Code SDK messages into the simplified ChatMessage[]
 * shape used by the UI. Mirrors the type-extraction logic in
 * useClaudeStreaming so historical sessions render identically to live ones.
 */

import type { ChatMessage } from "../types/types";

type Block = Record<string, unknown>;
type SdkMessage = Record<string, unknown> & { type?: string; timestamp?: string };

let idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${++idCounter}`;
}

function tsToMs(ts: unknown): number {
  if (typeof ts === "string") {
    const t = Date.parse(ts);
    if (!Number.isNaN(t)) return t;
  }
  if (typeof ts === "number") return ts;
  return Date.now();
}

/**
 * Convert one SDK message into zero-or-more ChatMessages. Each SDK message
 * may produce several UI messages (e.g. an assistant message with two
 * text blocks + one tool_use becomes three UI messages).
 */
function convertOne(msg: SdkMessage): ChatMessage[] {
  const timestamp = tsToMs(msg.timestamp);
  const type = msg.type;
  const out: ChatMessage[] = [];

  if (type === "system") {
    // `init` / other system events are not surfaced in the chat UI.
    return out;
  }

  if (type === "assistant") {
    const apiMsg = msg.message as { content?: Block[] } | undefined;
    const blocks = apiMsg?.content ?? [];
    let buffered = "";
    for (const block of blocks) {
      const blockType = block.type as string;
      if (blockType === "text") {
        buffered += (block.text as string) ?? "";
      } else if (blockType === "tool_use") {
        if (buffered) {
          out.push({
            id: nextId("a"),
            type: "chat",
            role: "assistant",
            content: buffered,
            timestamp,
          });
          buffered = "";
        }
        out.push({
          id: nextId("tool"),
          type: "tool",
          role: "assistant",
          content: (block.name as string) ?? "tool",
          timestamp,
          toolName: block.name as string,
          toolUseId: block.id as string,
          toolInput: (block.input as Record<string, unknown>) ?? undefined,
        });
      } else if (blockType === "thinking") {
        if (buffered) {
          out.push({
            id: nextId("a"),
            type: "chat",
            role: "assistant",
            content: buffered,
            timestamp,
          });
          buffered = "";
        }
        out.push({
          id: nextId("think"),
          type: "thinking",
          role: "assistant",
          content: (block.thinking as string) ?? "",
          timestamp,
        });
      }
    }
    if (buffered) {
      out.push({
        id: nextId("a"),
        type: "chat",
        role: "assistant",
        content: buffered,
        timestamp,
      });
    }
    return out;
  }

  if (type === "user") {
    const apiMsg = msg.message as { content?: Block[] | string } | undefined;
    const content = apiMsg?.content;
    if (typeof content === "string") {
      // A plain text user message (shouldn't be common in SDK exports).
      out.push({
        id: nextId("u"),
        type: "chat",
        role: "user",
        content,
        timestamp,
      });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const blockType = block.type as string;
        if (blockType === "text") {
          out.push({
            id: nextId("u"),
            type: "chat",
            role: "user",
            content: (block.text as string) ?? "",
            timestamp,
          });
        } else if (blockType === "tool_result") {
          const blockContent = block.content;
          let resultText = "";
          if (typeof blockContent === "string") {
            resultText = blockContent;
          } else if (Array.isArray(blockContent)) {
            const first = blockContent[0] as Block | undefined;
            resultText = (first?.text as string) ?? "";
          }
          out.push({
            id: nextId("result"),
            type: "tool_result",
            content: resultText.slice(0, 1000),
            timestamp,
            toolName: (block.tool_use_id as string) ?? "",
            toolUseResult: {
              summary: resultText.slice(0, 200),
              isError: (block.is_error as boolean) ?? false,
            },
          });
        }
      }
    }
    return out;
  }

  if (type === "result") {
    // Cost / turn-count metadata is not surfaced in the chat UI.
    return out;
  }

  return out;
}

/**
 * Public: convert an array of SDK messages (as returned by the
 * `/api/projects/:enc/histories/:sid` endpoint) into ChatMessage[].
 */
export function convertHistoryMessages(rawMessages: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;
    out.push(...convertOne(raw as SdkMessage));
  }
  return out;
}

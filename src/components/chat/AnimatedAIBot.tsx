"use client";

import { MiniBot } from "./MiniBot";
import type { ChatMessage } from "../../types/types";

/**
 * Empty-state animated AI bot — floats, blinks, ears split outward
 * periodically, antenna jiggles, whole bot tilts left/right on a long
 * cycle. Orbit rings spin in opposite directions, particles drift up.
 *
 * No console / talking box — just the bot, filling the available area.
 */
export function AnimatedAIBot() {
  // 12 particles spread via prime offsets so the pattern isn't gridded.
  const particles = Array.from({ length: 12 }, (_, i) => i);

  return (
    <div className="bot-stage" aria-hidden>
      <div className="bot-glow" />
      <div className="bot-orbit bot-orbit-1" />
      <div className="bot-orbit bot-orbit-2" />

      {particles.map((i) => (
        <span
          key={i}
          className="bot-particle"
          style={{
            top: `${((i * 41) % 90) + 5}%`,
            left: `${((i * 53) % 90) + 5}%`,
            animationDelay: `${(i % 7) * 0.55}s`,
          }}
        />
      ))}

      <div className="bot-frame">
        <div className="bot-halo" />
        <div className="bot-ping" />

        <div className="bot-body">
          {/* Antenna */}
          <div className="bot-antenna">
            <div className="bot-antenna-stem" />
            <div className="bot-antenna-bulb" />
          </div>

          {/* Eyes */}
          <div className="bot-eyes">
            <div className="bot-eye">
              <div className="bot-pupil" />
            </div>
            <div className="bot-eye">
              <div className="bot-pupil" />
            </div>
          </div>

          {/* Side ears */}
          <div className="bot-ear bot-ear-left" />
          <div className="bot-ear bot-ear-right" />
        </div>

        <div className="bot-shadow" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------
   Inline typing indicator — shown while the SDK turn is in flight.
   The label is *derived from real activity* by walking the message
   list backward and matching the most recent tool call / streaming
   text — not a hardcoded cycle. That way the user sees what Claude
   is actually doing right now ("Reading config.json", "Running
   bash", "Editing layout.tsx", …) the way Claude.ai does. The
   shimmer animation in globals.css paints the text regardless of
   what string we pass in.
   ------------------------------------------------------------------ */

export function TypingIndicator({ messages }: { messages: ChatMessage[] }) {
  const status = deriveStatus(messages);
  return (
    <span className="typing-indicator" aria-live="polite">
      <MiniBot />
      <span className="typing-indicator-text">{status}</span>
    </span>
  );
}

/* ------------------------------------------------------------------
   Status derivation
   ------------------------------------------------------------------ */

/** Walk the message list back-to-front and return a short status label
 *  for whatever the assistant is doing right now. User / system / error
 *  messages are skipped — they don't describe AI activity. */
function deriveStatus(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === "thinking" && m.isStreaming) {
      return "Thinking";
    }
    if (m.type === "tool") {
      return describeTool(m.toolName ?? "", m.toolInput);
    }
    if (m.type === "tool_result") {
      // Tool just finished — Claude is now reading the result and
      // deciding the next step.
      return "Thinking";
    }
    if (m.type === "chat" && m.role === "assistant") {
      if (m.isStreaming) {
        return m.content.trim() ? "Writing" : "Thinking";
      }
      // Last assistant turn already finalized but a new turn is in
      // flight (e.g. tool just queued) — treat as thinking.
      return "Thinking";
    }
    // user / system / error / abort messages: keep walking back.
  }
  return "Thinking";
}

/** Map a tool name + its raw input to a short verb-phrase. Tries to
 *  surface the most useful identifier (filename, command name, search
 *  pattern) so the user sees specific activity, not "Using Edit". */
function describeTool(
  toolName: string,
  input?: Record<string, unknown>
): string {
  const getStr = (key: string): string | null => {
    const v = input?.[key];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  const basename = (p: string | null): string | null => {
    if (!p) return null;
    const match = p.match(/[^/\\]+$/);
    return match ? match[0] : p;
  };

  switch (toolName) {
    case "Read": {
      const name = basename(getStr("file_path") ?? getStr("path"));
      return name ? `Reading ${name}` : "Reading file";
    }
    case "Edit":
    case "MultiEdit": {
      const name = basename(getStr("file_path"));
      return name ? `Editing ${name}` : "Editing file";
    }
    case "Write": {
      const name = basename(getStr("file_path"));
      return name ? `Writing ${name}` : "Writing file";
    }
    case "NotebookEdit":
      return "Editing notebook";
    case "Bash":
    case "PowerShell": {
      const cmd = getStr("command");
      if (cmd) {
        const first = cmd.trim().split(/\s+/)[0] ?? "";
        if (first) return `Running ${first}`;
      }
      return "Running command";
    }
    case "Glob": {
      const pattern = getStr("pattern");
      return pattern ? `Globbing ${pattern}` : "Searching files";
    }
    case "Grep": {
      const pattern = getStr("pattern");
      if (pattern) {
        const short = pattern.length > 24 ? `${pattern.slice(0, 24)}…` : pattern;
        return `Searching "${short}"`;
      }
      return "Searching code";
    }
    case "WebSearch": {
      const query = getStr("query");
      return query ? `Searching the web` : "Searching the web";
    }
    case "WebFetch":
      return "Fetching URL";
    case "TodoWrite":
      return "Updating todos";
    case "Task":
    case "Agent":
      return "Running agent";
    case "ToolSearch":
      return "Loading tools";
    case "AskUserQuestion":
      return "Preparing a question";
    default:
      // MCP tools come through as `mcp__<server>__<tool>` — pretty-print
      // those instead of dumping the raw id.
      if (toolName.startsWith("mcp__")) {
        const parts = toolName.split("__");
        const last = parts[parts.length - 1] || toolName;
        return `Using ${last}`;
      }
      return toolName ? `Using ${toolName}` : "Working";
  }
}

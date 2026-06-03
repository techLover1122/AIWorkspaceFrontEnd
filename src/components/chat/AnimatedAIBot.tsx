"use client";

import { useEffect, useState } from "react";
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
   Rules (from user feedback):
     - Show ONE word only. No filenames, no command names, no phrases.
     - The single word reflects what Claude is doing right now —
       Thinking / Reading / Writing / Editing / Coding / Searching /
       Running / Fetching / Working / Updating / Loading.
     - While the indicator is visible, the word cycles through four
       languages: English → Spanish → Greek → Latin → English …,
       changing every ~1.6s. Gives the indicator a "alive, multilingual"
       feel without flashing different *activities*.
   ------------------------------------------------------------------ */

type StatusKey =
  | "Thinking"
  | "Reading"
  | "Writing"
  | "Editing"
  | "Coding"
  | "Searching"
  | "Running"
  | "Fetching"
  | "Working"
  | "Updating"
  | "Loading";

const LANGUAGES = ["en", "es", "el", "la"] as const;
type Lang = (typeof LANGUAGES)[number];

/** Translations of each status key into the four cycling languages.
 *  English → Spanish → Greek → Latin. The latin entries use the
 *  present-active participle form ("thinking" → "cogitans") which
 *  reads as the verb's "doing" form, matching the others. */
const TRANSLATIONS: Record<StatusKey, Record<Lang, string>> = {
  Thinking:  { en: "Thinking",  es: "Pensando",     el: "Σκέπτομαι",    la: "Cogitans" },
  Reading:   { en: "Reading",   es: "Leyendo",      el: "Διαβάζω",      la: "Legens" },
  Writing:   { en: "Writing",   es: "Escribiendo",  el: "Γράφω",        la: "Scribens" },
  Editing:   { en: "Editing",   es: "Editando",     el: "Επεξεργάζομαι", la: "Emendans" },
  Coding:    { en: "Coding",    es: "Codificando",  el: "Κωδικοποιώ",   la: "Codicans" },
  Searching: { en: "Searching", es: "Buscando",     el: "Ψάχνω",        la: "Quaerens" },
  Running:   { en: "Running",   es: "Ejecutando",   el: "Εκτελώ",       la: "Currens" },
  Fetching:  { en: "Fetching",  es: "Obteniendo",   el: "Αναζητώ",      la: "Captans" },
  Working:   { en: "Working",   es: "Trabajando",   el: "Εργάζομαι",    la: "Operans" },
  Updating:  { en: "Updating",  es: "Actualizando", el: "Ενημερώνω",    la: "Renovans" },
  Loading:   { en: "Loading",   es: "Cargando",     el: "Φορτώνω",      la: "Onerans" },
};

const LANG_CYCLE_MS = 1_600;

export function TypingIndicator({ messages }: { messages: ChatMessage[] }) {
  const status = deriveStatus(messages);
  // Local language index — advances on a timer while the indicator is
  // mounted. Mounting/unmounting takes care of starting/stopping the
  // cycle, since the indicator is only rendered while isLoading is on.
  const [langIdx, setLangIdx] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      setLangIdx((i) => (i + 1) % LANGUAGES.length);
    }, LANG_CYCLE_MS);
    return () => window.clearInterval(id);
  }, []);

  const lang = LANGUAGES[langIdx];
  const word = TRANSLATIONS[status][lang];
  return (
    <span className="typing-indicator" aria-live="polite">
      <MiniBot />
      <span className="typing-indicator-text" lang={lang}>
        {word}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------
   Status derivation — single word only
   ------------------------------------------------------------------ */

/** Walk the message list back-to-front and return ONE status key for
 *  whatever the assistant is doing right now. Phrases, filenames,
 *  command names are intentionally NOT surfaced — the user explicitly
 *  asked for single-word labels. */
function deriveStatus(messages: ChatMessage[]): StatusKey {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === "thinking" && m.isStreaming) {
      return "Thinking";
    }
    if (m.type === "tool") {
      return toolToStatus(m.toolName ?? "");
    }
    if (m.type === "tool_result") {
      // Tool just finished — Claude is now reading the result and
      // deciding the next step.
      return "Thinking";
    }
    if (m.type === "chat" && m.role === "assistant") {
      if (m.isStreaming) {
        // Once text has started, the model is composing prose — call
        // it Writing. Empty stream is still pre-text Thinking.
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

/** Single-word verb for each tool. Bash / shell commands collapse to
 *  "Coding" (rather than "Running") to give a coder-friendly feel
 *  during file-edit-heavy turns; pure command tools that aren't
 *  obviously about code (WebFetch, WebSearch) get more specific verbs. */
function toolToStatus(toolName: string): StatusKey {
  switch (toolName) {
    case "Read":
      return "Reading";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "Editing";
    case "Write":
      return "Writing";
    case "Bash":
    case "PowerShell":
      return "Coding";
    case "Glob":
    case "Grep":
      return "Searching";
    case "WebSearch":
      return "Searching";
    case "WebFetch":
      return "Fetching";
    case "TodoWrite":
      return "Updating";
    case "Task":
    case "Agent":
      return "Running";
    case "ToolSearch":
      return "Loading";
    case "AskUserQuestion":
      return "Thinking";
    default:
      return "Working";
  }
}

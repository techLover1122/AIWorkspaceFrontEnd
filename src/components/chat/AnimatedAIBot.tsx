"use client";

import { useEffect, useRef, useState } from "react";
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

// Typewriter timings — kept loose so the rhythm feels natural, not
// metronomic. Hold lingers a bit longer than type+delete so the user
// can actually read each translation before it scrubs away.
const TYPE_IN_MS = 75;
const TYPE_OUT_MS = 40;
const HOLD_FULL_MS = 700;
const HOLD_EMPTY_MS = 200;

export function TypingIndicator({ messages }: { messages: ChatMessage[] }) {
  const status = deriveStatus(messages);
  // Keep status in a ref so the typewriter loop reads the latest
  // value on each tick instead of capturing the mount-time closure
  // (status flips during a turn: Thinking → Editing → Writing …).
  const statusRef = useRef(status);
  statusRef.current = status;

  const [displayText, setDisplayText] = useState("");
  const [langCode, setLangCode] = useState<Lang>("en");

  // Single self-scheduled loop owns the typewriter cycle: types the
  // current language's word in letter-by-letter, holds, deletes, then
  // advances to the next language and repeats. The lang change ONLY
  // happens between word cycles — within a single word the shimmer
  // and font style stay coherent.
  useEffect(() => {
    let cancelled = false;
    let langIdx = 0;
    let phase: "typing" | "deleting" = "typing";
    let pos = 0;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const schedule = (fn: () => void, ms: number): void => {
      timerId = setTimeout(() => {
        timerId = null;
        if (!cancelled) fn();
      }, ms);
    };

    const tick = (): void => {
      if (cancelled) return;
      const lang = LANGUAGES[langIdx];
      const word = TRANSLATIONS[statusRef.current][lang];
      setLangCode(lang);

      if (phase === "typing") {
        // Clamp pos in case status changed mid-cycle to a shorter word.
        pos = Math.min(pos + 1, word.length);
        setDisplayText(word.slice(0, pos));
        if (pos >= word.length) {
          // Fully typed — hold, then start deleting.
          schedule(() => {
            phase = "deleting";
            tick();
          }, HOLD_FULL_MS);
        } else {
          schedule(tick, TYPE_IN_MS);
        }
        return;
      }

      // phase === "deleting"
      pos = Math.max(pos - 1, 0);
      setDisplayText(word.slice(0, pos));
      if (pos <= 0) {
        // Fully erased — brief pause, advance language, type next word.
        langIdx = (langIdx + 1) % LANGUAGES.length;
        phase = "typing";
        schedule(tick, HOLD_EMPTY_MS);
      } else {
        schedule(tick, TYPE_OUT_MS);
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, []);

  return (
    <span className="typing-indicator" aria-live="polite">
      <MiniBot />
      <span className="typing-indicator-text" lang={langCode}>
        {displayText}
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

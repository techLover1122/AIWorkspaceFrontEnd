"use client";

import { useEffect, useState } from "react";
import { MiniBot } from "./MiniBot";

const CODING_WORDS = ["Thinking", "Coding", "Debugging", "Building", "Deploying"];

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
   Inline typing indicator — used while an assistant message is being
   streamed but hasn't yet emitted any text. Cycles the same coding
   verbs as the empty-state bot used to.
   ------------------------------------------------------------------ */

export function TypingIndicator() {
  const typed = useTypewriter(CODING_WORDS);
  return (
    <span className="typing-indicator" aria-live="polite">
      <MiniBot />
      <span className="typing-indicator-text">{typed}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */

function useTypewriter(words: string[]) {
  const [wordIndex, setWordIndex] = useState(0);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const current = words[wordIndex];
    const speed = deleting ? 45 : 90;
    const pause = typed === current && !deleting ? 900 : speed;

    const timer = setTimeout(() => {
      if (!deleting && typed.length < current.length) {
        setTyped(current.slice(0, typed.length + 1));
      } else if (!deleting && typed === current) {
        setDeleting(true);
      } else if (deleting && typed.length > 0) {
        setTyped(current.slice(0, typed.length - 1));
      } else if (deleting && typed.length === 0) {
        setDeleting(false);
        setWordIndex((prev) => (prev + 1) % words.length);
      }
    }, pause);

    return () => clearTimeout(timer);
  }, [typed, deleting, wordIndex, words]);

  return typed;
}

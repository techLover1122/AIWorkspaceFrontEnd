"use client";

import { useEffect, useState } from "react";
import { MiniBot } from "./MiniBot";

const CHECKING_WORDS = [
  "Checking",
  "Connecting",
  "Verifying",
  "Almost there",
];

/**
 * Splash shown while the very first `/api/status` round-trip is in flight on
 * mount — only triggers when a previous session marker exists in localStorage,
 * so a fresh user goes straight to ConnectScreen instead of seeing this.
 *
 * Visually: centred MiniBot + cycling typewriter text. Intentionally minimal
 * so it doesn't compete with the full ConnectScreen that may follow.
 */
export function ConnectionCheckLoader() {
  const word = useTypewriter(CHECKING_WORDS);

  return (
    <div className="connect-check-loader" role="status" aria-live="polite">
      <div className="connect-check-loader-inner">
        <MiniBot />
        <span className="connect-check-loader-text">{word}</span>
      </div>
    </div>
  );
}

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

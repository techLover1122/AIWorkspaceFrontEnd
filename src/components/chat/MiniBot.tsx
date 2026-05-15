"use client";

type MiniBotProps = {
  /**
   * When true, disables float + antenna-pulse animations. Eyes still blink
   * — used in the chat header where a calm, static mascot is preferred.
   */
  frozen?: boolean;
};

/**
 * Compact inline bot — a tiny mascot used inline next to streaming text
 * (e.g. inside the TypingIndicator) or in the chat panel header. Same
 * visual language as the full AnimatedAIBot but sized to sit on a single
 * line of text.
 */
export function MiniBot({ frozen = false }: MiniBotProps) {
  return (
    <span
      className={`mini-bot ${frozen ? "mini-bot-frozen" : ""}`}
      aria-hidden
    >
      <span className="mini-bot-antenna" />
      <span className="mini-bot-head">
        <span className="mini-bot-ear mini-bot-ear-left" />
        <span className="mini-bot-ear mini-bot-ear-right" />
        <span className="mini-bot-eye" />
        <span className="mini-bot-eye" />
      </span>
    </span>
  );
}

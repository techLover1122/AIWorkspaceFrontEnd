"use client";

import { useEffect, useMemo, useState } from "react";
import type { AskUserQuestionRequest } from "../../types/types";

type Props = {
  request: AskUserQuestionRequest | null;
  onCancel: () => void;
  /**
   * Called with the user's answers keyed by question text. Values are the
   * chosen option label (single-select) or comma-joined labels (multi-select).
   * "Other" answers come through as the user's typed string.
   */
  onSubmit: (answers: Record<string, string>) => void;
};

type SelectedState = Record<number, Set<string>>;
type OtherState = Record<number, string>;

const OTHER = "__other__";

export function AskUserQuestionModal({ request, onCancel, onSubmit }: Props) {
  const [selected, setSelected] = useState<SelectedState>({});
  const [otherText, setOtherText] = useState<OtherState>({});
  const [focusedOption, setFocusedOption] = useState<Record<number, number>>({});

  useEffect(() => {
    if (!request) {
      setSelected({});
      setOtherText({});
      setFocusedOption({});
      return;
    }
    // eslint-disable-next-line no-console
    console.log("[askUserQuestion:modal-render]", {
      toolUseId: request.toolUseId,
      questions: request.questions.map((q) => ({
        header: q.header,
        question: q.question,
        multiSelect: !!q.multiSelect,
        optionCount: q.options?.length ?? 0,
      })),
    });
    // Default-focus the first option of each question.
    const focus: Record<number, number> = {};
    request.questions.forEach((_, i) => {
      focus[i] = 0;
    });
    setFocusedOption(focus);
  }, [request]);

  const questions = request?.questions ?? [];

  const toggle = (qIdx: number, label: string, multi: boolean) => {
    setSelected((prev) => {
      const next: SelectedState = { ...prev };
      const current = new Set(next[qIdx] ?? []);
      if (multi) {
        if (current.has(label)) current.delete(label);
        else current.add(label);
      } else {
        current.clear();
        current.add(label);
      }
      next[qIdx] = current;
      // eslint-disable-next-line no-console
      console.log("[askUserQuestion:pick]", {
        qIdx,
        label: label === OTHER ? "Other" : label,
        multi,
        selectedNow: Array.from(current),
      });
      return next;
    });
  };

  const canSubmit = useMemo(() => {
    return questions.every((q, i) => {
      const picks = selected[i];
      if (!picks || picks.size === 0) return false;
      if (picks.has(OTHER) && !(otherText[i] ?? "").trim()) return false;
      return true;
    });
  }, [questions, selected, otherText]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit || !request) return;
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      const picks = Array.from(selected[i] ?? []);
      const expanded = picks.map((p) =>
        p === OTHER ? (otherText[i] ?? "").trim() : p
      );
      answers[q.question] = expanded.join(", ");
    });
    onSubmit(answers);
  };

  if (!request) return null;

  return (
    <div className="history-overlay" onClick={onCancel}>
      <div
        className="history-panel auq-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="history-header">
          <span className="history-title">Claude is asking</span>
          <button
            type="button"
            className="history-close"
            onClick={onCancel}
            aria-label="Cancel"
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <form className="auq-form" onSubmit={handleSubmit}>
          {questions.map((q, qIdx) => {
            const multi = !!q.multiSelect;
            const picks = selected[qIdx] ?? new Set<string>();
            const focusedPreview =
              q.options[focusedOption[qIdx] ?? 0]?.preview;

            return (
              <section key={qIdx} className="auq-question">
                <header className="auq-question-header">
                  {q.header && (
                    <span className="auq-question-chip">{q.header}</span>
                  )}
                  <span className="auq-question-text">{q.question}</span>
                  {multi && (
                    <span className="auq-question-multi">multi-select</span>
                  )}
                </header>

                <div className="auq-options">
                  {q.options.map((opt, oIdx) => {
                    const isPicked = picks.has(opt.label);
                    return (
                      <button
                        key={oIdx}
                        type="button"
                        className={`auq-option ${isPicked ? "picked" : ""}`}
                        onClick={() => toggle(qIdx, opt.label, multi)}
                        onMouseEnter={() =>
                          setFocusedOption((p) => ({ ...p, [qIdx]: oIdx }))
                        }
                      >
                        <span className="auq-option-marker" aria-hidden>
                          {isPicked ? (multi ? "☑" : "●") : multi ? "☐" : "○"}
                        </span>
                        <span className="auq-option-body">
                          <span className="auq-option-label">{opt.label}</span>
                          <span className="auq-option-desc">
                            {opt.description}
                          </span>
                        </span>
                      </button>
                    );
                  })}

                  {/* Always offer "Other" so users aren't boxed in */}
                  <button
                    type="button"
                    className={`auq-option auq-other ${picks.has(OTHER) ? "picked" : ""}`}
                    onClick={() => toggle(qIdx, OTHER, multi)}
                  >
                    <span className="auq-option-marker" aria-hidden>
                      {picks.has(OTHER) ? (multi ? "☑" : "●") : multi ? "☐" : "○"}
                    </span>
                    <span className="auq-option-body">
                      <span className="auq-option-label">Other…</span>
                      <span className="auq-option-desc">
                        Type your own answer below.
                      </span>
                    </span>
                  </button>

                  {picks.has(OTHER) && (
                    <input
                      type="text"
                      className="auq-other-input"
                      placeholder="Your answer"
                      value={otherText[qIdx] ?? ""}
                      onChange={(e) =>
                        setOtherText((p) => ({ ...p, [qIdx]: e.target.value }))
                      }
                      autoFocus
                    />
                  )}
                </div>

                {focusedPreview && (
                  <pre className="auq-preview">{focusedPreview}</pre>
                )}
              </section>
            );
          })}

          <div className="auq-actions">
            <button
              type="button"
              className="pack-btn"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="pack-btn pack-btn-primary"
              disabled={!canSubmit}
            >
              Send answer
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

"use client";

import { useState, useRef, useEffect } from "react";
import type { IntentGuardRequest } from "../../types/types";
import { intentGuardUrl } from "../../constant/api";

type IntentGuardPanelProps = {
  request: IntentGuardRequest;
  onResolved: () => void;
};

export function IntentGuardPanel({ request, onResolved }: IntentGuardPanelProps) {
  const [selected, setSelected] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const choose = async (choice: "narrow" | "broad") => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await fetch(intentGuardUrl(request.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice }),
      });
    } catch {
      // Ignore network errors — backend will auto-resolve on timeout
    }
    onResolved();
  };

  const options = [
    {
      key: request.narrowOption.key,
      label: request.narrowOption.label,
      isLargeScale: request.narrowOption.isLargeScale,
      action: () => void choose("narrow"),
    },
    {
      key: request.broadOption.key,
      label: request.broadOption.label,
      isLargeScale: request.broadOption.isLargeScale,
      estimatedScope: request.broadOption.estimatedScope,
      action: () => void choose("broad"),
    },
  ];

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (s + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => (s - 1 + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      options[selected].action();
    } else if (e.key === "1") {
      options[0].action();
    } else if (e.key === "2") {
      options[1].action();
    }
  };

  return (
    <div
      className="permission-panel intent-guard-panel"
      ref={ref}
      tabIndex={0}
      onKeyDown={handleKey}
    >
      <div className="permission-header">
        <span className="permission-icon intent-guard-icon" aria-hidden>
          <svg viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M8 5v3.5M8 10.5h.01"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className="permission-title">Clarify your intent</span>
      </div>

      <div className="intent-guard-question">{request.question}</div>

      <div className="permission-actions intent-guard-actions">
        {options.map((opt, i) => (
          <button
            key={opt.key}
            type="button"
            className={`permission-btn intent-guard-btn ${i === selected ? "selected" : ""} ${opt.isLargeScale ? "intent-guard-btn--broad" : ""}`}
            onClick={opt.action}
            onMouseEnter={() => setSelected(i)}
            disabled={submitting}
          >
            <span className="intent-guard-btn-label">
              {opt.label}
              {opt.isLargeScale && opt.estimatedScope && (
                <span className="intent-guard-scope-badge">⚠ {opt.estimatedScope}</span>
              )}
            </span>
            <span className="permission-btn-key">{i + 1}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

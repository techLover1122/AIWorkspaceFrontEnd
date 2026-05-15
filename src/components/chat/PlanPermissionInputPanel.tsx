"use client";

import { useState, useRef, useEffect } from "react";

type PlanPermissionInputPanelProps = {
  onAcceptWithAutoEdits: () => void;
  onAcceptManual: () => void;
  onKeepPlanning: () => void;
};

export function PlanPermissionInputPanel({
  onAcceptWithAutoEdits,
  onAcceptManual,
  onKeepPlanning,
}: PlanPermissionInputPanelProps) {
  const [selected, setSelected] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const options = [
    { label: "Accept · auto-approve edits", key: "1", action: onAcceptWithAutoEdits },
    { label: "Accept · manual approval", key: "2", action: onAcceptManual },
    { label: "Keep planning", key: "Esc", action: onKeepPlanning },
  ];

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) =>
        e.key === "ArrowDown"
          ? (s + 1) % options.length
          : (s - 1 + options.length) % options.length
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      options[selected].action();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onKeepPlanning();
    } else if (e.key === "1") {
      options[0].action();
    } else if (e.key === "2") {
      options[1].action();
    }
  };

  return (
    <div className="permission-panel plan" ref={ref} tabIndex={0} onKeyDown={handleKey}>
      <div className="permission-header">
        <span className="permission-icon" aria-hidden>
          <svg viewBox="0 0 16 16" fill="none">
            <path
              d="M3 2.5h10v11l-5-2.5-5 2.5v-11z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="permission-title">Plan ready</span>
      </div>
      <div className="permission-detail">Review and choose how to proceed</div>
      <div className="permission-actions">
        {options.map((opt, i) => (
          <button
            key={opt.label}
            type="button"
            className={`permission-btn ${i === selected ? "selected" : ""}`}
            onClick={opt.action}
            onMouseEnter={() => setSelected(i)}
          >
            <span>{opt.label}</span>
            <span className="permission-btn-key">{opt.key}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

"use client";

import { useState, useRef, useEffect } from "react";
import type { PermissionRequest } from "../../types/types";

type PermissionInputPanelProps = {
  request: PermissionRequest;
  onAllow: (persist: boolean) => void;
  onDeny: () => void;
};

export function PermissionInputPanel({ request, onAllow, onDeny }: PermissionInputPanelProps) {
  const [selected, setSelected] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const options = [
    { label: "Allow once", key: "1", action: () => onAllow(false) },
    { label: "Allow permanently", key: "2", action: () => onAllow(true) },
    { label: "Deny", key: "Esc", action: onDeny },
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
      onDeny();
    } else if (e.key === "1") {
      options[0].action();
    } else if (e.key === "2") {
      options[1].action();
    }
  };

  return (
    <div className="permission-panel" ref={ref} tabIndex={0} onKeyDown={handleKey}>
      <div className="permission-header">
        <span className="permission-icon" aria-hidden>
          <svg viewBox="0 0 16 16" fill="none">
            <path
              d="M8 1.5L1 14h14L8 1.5zM8 6v4M8 12h.01"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="permission-title">Tool permission required</span>
      </div>
      <div className="permission-detail">{request.toolName}</div>
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

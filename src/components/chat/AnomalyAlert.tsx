"use client";

import { useState } from "react";
import type { AnomalyAlert } from "../../types/types";

type AnomalyAlertProps = {
  alert: AnomalyAlert;
  onDismiss: () => void;
};

export function AnomalyAlertBanner({ alert, onDismiss }: AnomalyAlertProps) {
  const [expanded, setExpanded] = useState(false);

  const isHigh = alert.severity === "high";

  return (
    <div className={`anomaly-alert anomaly-alert--${alert.severity}`}>
      <div className="anomaly-alert-header">
        <span className="anomaly-alert-icon" aria-hidden>
          {isHigh ? (
            <svg viewBox="0 0 16 16" fill="none">
              <path
                d="M8 1.5L1 14h14L8 1.5zM8 6v4M8 12h.01"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
              <path
                d="M8 5v3.5M8 10.5h.01"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          )}
        </span>
        <div className="anomaly-alert-title-row">
          <span className="anomaly-alert-title">
            {isHigh ? "Anomaly Detected" : "Anomaly Notice"}
          </span>
          {alert.capturedIntent && (
            <span className="anomaly-alert-intent">
              Intent: {alert.capturedIntent}
            </span>
          )}
        </div>
        <div className="anomaly-alert-actions">
          <button
            type="button"
            className="anomaly-alert-expand-btn"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Hide details" : "Details"}
          </button>
          <button
            type="button"
            className="anomaly-alert-dismiss-btn"
            onClick={onDismiss}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="anomaly-alert-summary">{alert.summary}</div>

      {expanded && (
        <div className="anomaly-alert-checks">
          {alert.checks
            .filter((c) => c.status !== "pass")
            .map((check, i) => (
              <div key={i} className={`anomaly-check anomaly-check--${check.status}`}>
                <span className="anomaly-check-name">{check.name}</span>
                {check.detail && (
                  <span className="anomaly-check-detail">{check.detail}</span>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

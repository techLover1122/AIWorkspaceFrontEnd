"use client";

import { useEffect, useState } from "react";
import type { ProjectInfo } from "../../types/types";
import { projectsUrl } from "../../constant/api";

type ProjectSelectorProps = {
  /** Called with the selected absolute path. */
  onSelect: (path: string) => void;
  /** Optional close handler when rendered as a modal. */
  onClose?: () => void;
  /** Currently selected working directory (highlights matching item). */
  currentPath?: string;
};

export function ProjectSelector({ onSelect, onClose, currentPath }: ProjectSelectorProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [customPath, setCustomPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(projectsUrl())
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled) setProjects(data.projects ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load projects");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = customPath.trim();
    if (trimmed) {
      onSelect(trimmed);
    }
  };

  return (
    <div className="project-selector">
      <div className="project-selector-card">
        <div className="project-selector-header">
          <h2 className="project-selector-title">Select working directory</h2>
          {onClose && (
            <button
              type="button"
              className="project-selector-close"
              onClick={onClose}
              aria-label="Close"
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
          )}
        </div>

        {loading && <div className="project-loading">Loading projects...</div>}

        {error && !loading && (
          <div className="project-error">Could not reach backend: {error}</div>
        )}

        {!loading && !error && (
          <div className="project-list">
            {projects.map((p) => (
              <button
                key={p.encodedName}
                type="button"
                className={`project-item ${currentPath === p.path ? "active" : ""}`}
                onClick={() => onSelect(p.path)}
              >
                <span className="project-item-icon" aria-hidden>
                  <svg viewBox="0 0 16 16" fill="none" width="14" height="14">
                    <path
                      d="M1.5 3.5h4l1.5 1.5h7.5v8.5a.5.5 0 0 1-.5.5H1.5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"
                      stroke="currentColor"
                      strokeWidth="1.2"
                    />
                  </svg>
                </span>
                <span className="project-item-info">
                  <span className="project-item-name">
                    {p.path.split(/[/\\]/).pop()}
                  </span>
                  <span className="project-item-path">{p.path}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {!loading && !error && projects.length === 0 && (
          <div className="project-empty">
            No recent Claude sessions found. Enter a path manually below.
          </div>
        )}

        <form className="project-custom-form" onSubmit={handleCustomSubmit}>
          <input
            type="text"
            className="project-custom-input"
            placeholder="d:\Working\my-project"
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            spellCheck={false}
          />
          <button
            type="submit"
            className="project-custom-go"
            disabled={!customPath.trim()}
          >
            Open
          </button>
        </form>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import type { ConversationSummary, ProjectInfo } from "../../types/types";
import { projectsUrl, historiesUrl } from "../../constant/api";

type HistoryViewProps = {
  workingDirectory?: string;
  onSelect: (sessionId: string, encodedProjectName: string) => void;
  onClose: () => void;
};

/** Lowercase + normalize separators so Windows path casing/slash differences
 *  don't prevent a match between `workingDirectory` and a project entry. */
function normalizePath(p: string): string {
  return p.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
}

export function HistoryView({ workingDirectory, onSelect, onClose }: HistoryViewProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectInfo | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false);

  // Load project list once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(projectsUrl());
        const data = (await res.json()) as { projects?: ProjectInfo[] };
        if (cancelled) return;
        setProjects(data.projects ?? []);
      } catch {
        if (!cancelled) setProjects([]);
      } finally {
        if (!cancelled) setLoadingProjects(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Once projects load, auto-pick the one matching workingDirectory (or just
  // the first one if there's no working dir). Skips the folder-picker step
  // the user complained about — they land directly on a list of sessions.
  useEffect(() => {
    if (loadingProjects || activeProject || projects.length === 0) return;
    if (workingDirectory) {
      const target = normalizePath(workingDirectory);
      const match = projects.find((p) => normalizePath(p.path) === target);
      if (match) {
        setActiveProject(match);
        return;
      }
    }
    setActiveProject(projects[0]);
  }, [loadingProjects, projects, workingDirectory, activeProject]);

  // Fetch conversations whenever the active project changes.
  useEffect(() => {
    if (!activeProject) return;
    let cancelled = false;
    setLoadingConversations(true);
    setConversations([]);
    (async () => {
      try {
        const res = await fetch(historiesUrl(activeProject.encodedName));
        const data = (await res.json()) as { conversations?: ConversationSummary[] };
        if (cancelled) return;
        setConversations(data.conversations ?? []);
      } catch {
        if (!cancelled) setConversations([]);
      } finally {
        if (!cancelled) setLoadingConversations(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProject]);

  const otherProjects = useMemo(
    () => projects.filter((p) => p.encodedName !== activeProject?.encodedName),
    [projects, activeProject]
  );

  return (
    <div className="history-overlay">
      <div className="history-panel">
        <div className="history-header">
          <span className="history-title">Session history</span>
          <button
            type="button"
            className="history-close"
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
        </div>

        {loadingProjects && (
          <div className="history-loading">Loading projects…</div>
        )}

        {!loadingProjects && projects.length === 0 && (
          <div className="history-empty">
            No projects found. Run Claude CLI first to create sessions.
          </div>
        )}

        {!loadingProjects && activeProject && (
          <>
            <button
              type="button"
              className="history-project-switch"
              onClick={() => setShowProjectSwitcher((s) => !s)}
              title="Switch project"
            >
              <span className="history-project-switch-label">
                {activeProject.path}
              </span>
              <span
                className={`history-project-switch-caret${
                  showProjectSwitcher ? " open" : ""
                }`}
                aria-hidden
              >
                ▾
              </span>
            </button>

            {showProjectSwitcher && (
              <div className="history-project-list">
                {otherProjects.length === 0 && (
                  <div className="history-empty">No other projects.</div>
                )}
                {otherProjects.map((p) => (
                  <button
                    key={p.encodedName}
                    type="button"
                    className="history-project-item"
                    onClick={() => {
                      setActiveProject(p);
                      setShowProjectSwitcher(false);
                    }}
                  >
                    <span className="history-project-path">{p.path}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="history-conversation-list">
              {loadingConversations && (
                <div className="history-loading">Loading sessions…</div>
              )}
              {!loadingConversations && conversations.length === 0 && (
                <div className="history-empty">
                  No sessions found for this project yet.
                </div>
              )}
              {!loadingConversations &&
                conversations.map((c) => (
                  <button
                    key={c.sessionId}
                    type="button"
                    className="history-conversation-item"
                    onClick={() =>
                      onSelect(c.sessionId, activeProject.encodedName)
                    }
                  >
                    <div className="history-conversation-preview">
                      {c.lastMessagePreview || "(no preview)"}
                    </div>
                    <div className="history-conversation-meta">
                      {c.messageCount} messages ·{" "}
                      {new Date(c.lastTime).toLocaleDateString()}
                    </div>
                  </button>
                ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

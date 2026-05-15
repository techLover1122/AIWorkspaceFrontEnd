"use client";

import { useEffect, useState } from "react";
import type { ConversationSummary, ProjectInfo } from "../../types/types";
import { projectsUrl, historiesUrl } from "../../constant/api";

type HistoryViewProps = {
  onSelect: (sessionId: string, encodedProjectName: string) => void;
  onClose: () => void;
};

export function HistoryView({ onSelect, onClose }: HistoryViewProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(projectsUrl())
      .then((r) => r.json())
      .then((data) => setProjects(data.projects ?? []))
      .catch(() => { })
      .finally(() => setLoading(false));
  }, []);

  const loadHistories = async (encodedName: string) => {
    setSelectedProject(encodedName);
    setLoading(true);
    try {
      const res = await fetch(historiesUrl(encodedName));
      const data = await res.json();
      setConversations(data.conversations ?? []);
    } catch {
      setConversations([]);
    } finally {
      setLoading(false);
    }
  };

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

        {loading && <div className="history-loading">Loading...</div>}

        {!selectedProject && !loading && (
          <div className="history-project-list">
            {projects.length === 0 && (
              <div className="history-empty">
                No projects found. Run Claude CLI first to create sessions.
              </div>
            )}
            {projects.map((p) => (
              <button
                key={p.encodedName}
                type="button"
                className="history-project-item"
                onClick={() => loadHistories(p.encodedName)}
              >
                <span className="history-project-path">{p.path}</span>
              </button>
            ))}
          </div>
        )}

        {selectedProject && !loading && (
          <div className="history-conversation-list">
            <button
              type="button"
              className="history-back"
              onClick={() => {
                setSelectedProject(null);
                setConversations([]);
              }}
            >
              ← Back to projects
            </button>
            {conversations.length === 0 && (
              <div className="history-empty">No conversations found.</div>
            )}
            {conversations.map((c) => (
              <button
                key={c.sessionId}
                type="button"
                className="history-conversation-item"
                onClick={() => onSelect(c.sessionId, selectedProject)}
              >
                <div className="history-conversation-preview">
                  {c.lastMessagePreview || "(no preview)"}
                </div>
                <div className="history-conversation-meta">
                  {c.messageCount} messages · {new Date(c.lastTime).toLocaleDateString()}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationSummary, ProjectInfo } from "../../types/types";
import { projectsUrl, historiesUrl, conversationUrl } from "../../constant/api";

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

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M11.5 2.5l2 2-9 9H2.5v-2l9-9zM10 4l2 2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 10h8l1-10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function HistoryView({ workingDirectory, onSelect, onClose }: HistoryViewProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectInfo | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

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

  // Auto-pick the project matching workingDirectory (or the first project).
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
    setEditingId(null);
    setDeletingId(null);
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

  // Focus the edit input when edit mode opens.
  useEffect(() => {
    if (editingId) editInputRef.current?.focus();
  }, [editingId]);

  const otherProjects = useMemo(
    () => projects.filter((p) => p.encodedName !== activeProject?.encodedName),
    [projects, activeProject]
  );

  function startEdit(c: ConversationSummary) {
    setDeletingId(null);
    setEditingId(c.sessionId);
    setEditingTitle(c.title ?? c.lastMessagePreview ?? "");
  }

  async function saveTitle(sessionId: string) {
    if (!activeProject) return;
    const trimmed = editingTitle.trim();
    setEditingId(null);
    if (!trimmed) return;
    try {
      await fetch(conversationUrl(activeProject.encodedName, sessionId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      setConversations((prev) =>
        prev.map((c) => (c.sessionId === sessionId ? { ...c, title: trimmed } : c))
      );
    } catch {
      /* ignore */
    }
  }

  async function deleteConversation(sessionId: string) {
    if (!activeProject) return;
    setDeletingId(null);
    try {
      await fetch(conversationUrl(activeProject.encodedName, sessionId), {
        method: "DELETE",
      });
      setConversations((prev) => prev.filter((c) => c.sessionId !== sessionId));
    } catch {
      /* ignore */
    }
  }

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
                conversations.map((c) => {
                  // ── Delete confirmation row ──
                  if (deletingId === c.sessionId) {
                    return (
                      <div key={c.sessionId} className="history-conversation-confirm-row">
                        <span className="history-confirm-text">Delete this session?</span>
                        <button
                          type="button"
                          className="history-confirm-yes"
                          onClick={() => deleteConversation(c.sessionId)}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          className="history-confirm-no"
                          onClick={() => setDeletingId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    );
                  }

                  // ── Inline edit row ──
                  if (editingId === c.sessionId) {
                    return (
                      <div key={c.sessionId} className="history-conversation-edit-row">
                        <input
                          ref={editInputRef}
                          className="history-conversation-edit-input"
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveTitle(c.sessionId);
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          placeholder="Session name…"
                          maxLength={200}
                        />
                        <button
                          type="button"
                          className="history-edit-save"
                          onClick={() => saveTitle(c.sessionId)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="history-edit-cancel"
                          onClick={() => setEditingId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    );
                  }

                  // ── Normal row ──
                  return (
                    <div key={c.sessionId} className="history-conversation-item-wrapper">
                      <button
                        type="button"
                        className="history-conversation-item"
                        onClick={() => onSelect(c.sessionId, activeProject.encodedName)}
                      >
                        <div className="history-conversation-preview">
                          {c.title || c.lastMessagePreview || "(no preview)"}
                        </div>
                        <div className="history-conversation-meta">
                          {c.messageCount} messages ·{" "}
                          {new Date(c.lastTime).toLocaleDateString()}
                        </div>
                      </button>
                      <div className="history-conversation-actions">
                        <button
                          type="button"
                          className="history-action-btn"
                          title="Rename session"
                          onClick={(e) => {
                            e.stopPropagation();
                            startEdit(c);
                          }}
                        >
                          <PencilIcon />
                        </button>
                        <button
                          type="button"
                          className="history-action-btn delete"
                          title="Delete session"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingId(null);
                            setDeletingId(c.sessionId);
                          }}
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </div>
                  );
                })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

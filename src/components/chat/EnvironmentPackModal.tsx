"use client";

import { useEffect, useRef, useState } from "react";
import { installPackUrl } from "../../constant/api";

export type InstalledPack = {
  name: string;
  slug: string;
  description?: string;
  hasInstall: boolean;
  source: "github" | "zip" | "git";
  installedAt: string;
};

type Tab = "add" | "create";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Called when an environment pack is installed from a URL. */
  onInstalled: (info: InstalledPack) => void;
  /**
   * Called when the user submits the Create tab. The given chat message
   * instructs Claude to invoke the in-process MCP tool `create_pack` via
   * the `aiide` MCP server. The parent is responsible for sending the
   * message into chat.
   */
  onCreateRequest: (message: string) => void;
};

type Step = { t: number; msg: string };

type ApiResponse =
  | (InstalledPack & { ok: true; steps?: Step[] })
  | { ok: false; code: string; error: string; steps?: Step[] };

export function EnvironmentPackModal({
  open,
  onClose,
  onInstalled,
  onCreateRequest,
}: Props) {
  const [tab, setTab] = useState<Tab>("add");

  // Add tab state
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Create tab state
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [createSteps, setCreateSteps] = useState("");
  const [createNotes, setCreateNotes] = useState("");
  const createNameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setTab("add");
      setUrl("");
      setSteps([]);
      setError(null);
      setBusy(false);
      setCreateName("");
      setCreateDescription("");
      setShowAdvanced(false);
      setCreateSteps("");
      setCreateNotes("");
      return;
    }
    setTimeout(() => {
      if (tab === "add") urlInputRef.current?.focus();
      else createNameRef.current?.focus();
    }, 0);
  }, [open, tab]);

  if (!open) return null;

  /* -------------------------------- Add tab -------------------------------- */
  const handleAddSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const trimmed = url.trim();
    if (!trimmed) {
      setError("Enter a URL.");
      return;
    }
    setBusy(true);
    setError(null);
    setSteps([{ t: Date.now(), msg: "Submitting…" }]);

    try {
      const res = await fetch(installPackUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = (await res.json()) as ApiResponse;
      if (data.steps) setSteps(data.steps);
      if (!data.ok) {
        setError(data.error || "Install failed.");
        setBusy(false);
        return;
      }
      onInstalled({
        name: data.name,
        slug: data.slug,
        hasInstall: data.hasInstall,
        source: data.source,
        installedAt: data.installedAt,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setBusy(false);
    }
  };

  /* ------------------------------ Create tab ------------------------------ */
  const buildCreatePrompt = (): string => {
    const args: Record<string, unknown> = {
      name: createName.trim(),
      description: createDescription.trim(),
    };
    if (showAdvanced) {
      const stepsList = createSteps
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (stepsList.length > 0) args.installSteps = stepsList;
      const notes = createNotes.trim();
      if (notes) args.installNotes = notes;
    }
    return (
      `Use the \`mcp__aiide__create_pack\` tool to scaffold a new environment pack with these arguments:\n\n` +
      "```json\n" +
      JSON.stringify(args, null, 2) +
      "\n```\n\n" +
      `After the tool runs, summarize what was created in one sentence and remind me that the pack ` +
      `is project-local — I can promote it to ~/.claude/skills/<slug>/ later for cross-project use.`
    );
  };

  const handleCreateSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (!createName.trim() || !createDescription.trim()) {
      setError("Name and description are required.");
      return;
    }
    setError(null);
    onCreateRequest(buildCreatePrompt());
    onClose();
  };

  const handleChatDriven = () => {
    if (busy) return;
    const message =
      `Help me create a new environment pack interactively. Ask me what to call it, ` +
      `what it does, and what install steps it should have (if any). When you have enough info, ` +
      `use the \`mcp__aiide__create_pack\` tool to scaffold it. After it's created, ` +
      `remind me that it's project-local and that I can promote it to ~/.claude/skills/<slug>/ ` +
      `for cross-project use.`;
    onCreateRequest(message);
    onClose();
  };

  const handleBackdropClick = () => {
    if (!busy) onClose();
  };

  const switchTab = (next: Tab) => {
    if (busy) return;
    setTab(next);
    setError(null);
  };

  /* --------------------------------- Render -------------------------------- */
  return (
    <div className="history-overlay" onClick={handleBackdropClick}>
      <div
        className="history-panel pack-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="history-header">
          <span className="history-title">Environment pack</span>
          <button
            type="button"
            className="history-close"
            onClick={onClose}
            disabled={busy}
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

        <div className="pack-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "add"}
            className={`pack-tab ${tab === "add" ? "active" : ""}`}
            onClick={() => switchTab("add")}
            disabled={busy}
          >
            Add from URL
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "create"}
            className={`pack-tab ${tab === "create" ? "active" : ""}`}
            onClick={() => switchTab("create")}
            disabled={busy}
          >
            Create new
          </button>
        </div>

        {tab === "add" && (
          <form className="pack-form" onSubmit={handleAddSubmit}>
            <label className="pack-label" htmlFor="pack-url-input">
              Paste a GitHub repo URL, a .zip URL, or a git clone URL.
            </label>
            <input
              id="pack-url-input"
              ref={urlInputRef}
              className="pack-url-input"
              type="text"
              placeholder="https://github.com/user/my-pack"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
            />

            {steps.length > 0 && (
              <div className="pack-steps" role="log" aria-live="polite">
                {steps.map((s, i) => (
                  <div key={i} className="pack-step">
                    {s.msg}
                  </div>
                ))}
              </div>
            )}

            {error && <div className="pack-error">{error}</div>}

            <div className="pack-actions">
              <button
                type="button"
                className="pack-btn"
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="pack-btn pack-btn-primary"
                disabled={busy || !url.trim()}
              >
                {busy ? "Installing…" : "Add pack"}
              </button>
            </div>
          </form>
        )}

        {tab === "create" && (
          <form className="pack-form" onSubmit={handleCreateSubmit}>
            <label className="pack-label" htmlFor="pack-create-name">
              Name
            </label>
            <input
              id="pack-create-name"
              ref={createNameRef}
              className="pack-url-input"
              type="text"
              placeholder="Postgres Local Dev"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />

            <label className="pack-label" htmlFor="pack-create-desc">
              Description
            </label>
            <input
              id="pack-create-desc"
              className="pack-url-input"
              type="text"
              placeholder="One-line summary of what this pack provides."
              value={createDescription}
              onChange={(e) => setCreateDescription(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />

            <button
              type="button"
              className="pack-disclosure"
              onClick={() => setShowAdvanced((s) => !s)}
            >
              {showAdvanced ? "− Hide advanced" : "+ Advanced (install steps & notes)"}
            </button>

            {showAdvanced && (
              <>
                <label className="pack-label" htmlFor="pack-create-steps">
                  Install steps — one per line
                </label>
                <textarea
                  id="pack-create-steps"
                  className="pack-url-input pack-textarea"
                  placeholder={"brew install postgresql@16\nbrew services start postgresql@16"}
                  value={createSteps}
                  onChange={(e) => setCreateSteps(e.target.value)}
                  rows={4}
                  spellCheck={false}
                />

                <label className="pack-label" htmlFor="pack-create-notes">
                  Notes (prerequisites, caveats — optional Markdown)
                </label>
                <textarea
                  id="pack-create-notes"
                  className="pack-url-input pack-textarea"
                  placeholder="Requires Homebrew on macOS."
                  value={createNotes}
                  onChange={(e) => setCreateNotes(e.target.value)}
                  rows={3}
                  spellCheck={false}
                />
              </>
            )}

            <p className="pack-hint">
              The pack will be created project-local under{" "}
              <code>.claude/skills/&lt;slug&gt;/</code> via the{" "}
              <code>mcp__aiide__create_pack</code> tool. Claude will remind you
              how to promote it to <code>~/.claude/skills/</code> for cross-project
              use.
            </p>

            {error && <div className="pack-error">{error}</div>}

            <div className="pack-actions">
              <button
                type="button"
                className="pack-btn pack-btn-link"
                onClick={handleChatDriven}
                disabled={busy}
                title="Create via chat — Claude will ask for the details interactively"
              >
                Create via chat instead
              </button>
              <div className="pack-actions-spacer" />
              <button
                type="button"
                className="pack-btn"
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="pack-btn pack-btn-primary"
                disabled={busy || !createName.trim() || !createDescription.trim()}
              >
                Create pack
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

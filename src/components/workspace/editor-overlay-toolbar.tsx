"use client";

import { useTunnelStatus, type TunnelStatusValue } from "../../utils/electronTunnel";
import type { UploadStatus } from "./project-upload";

export type EditorOverlayTool = "pointer" | "comments";

type EditorOverlayToolbarProps = {
  /** When true the full strip renders; when false only the small
   *  chevron handle shows in the same anchor position, clickable to
   *  expand the strip back. Controlled by the parent so the choice
   *  persists across remounts (localStorage in workspace-shell). */
  visible: boolean;
  /** Flip `visible`. Bound to both the hide chevron (in the full
   *  toolbar) and the small handle (in the collapsed state). */
  onToggleVisible: () => void;
  /** Currently active tool (if any). `null` means no tool is selected —
   *  cursor is left untouched so the user can interact with the iframe. */
  activeTool: EditorOverlayTool | null;
  /** Called when the user clicks a tool button (marker / comments). The
   *  parent should ALSO auto-capture an iframe snapshot if one doesn't
   *  already exist for this tab — the marker / comments tools draw on a
   *  frozen snapshot, not on the live iframe. */
  onChangeTool: (tool: EditorOverlayTool | null) => void;
  /** Reload the active tab's iframe. Always shown — works for any URL
   *  (code-server, live preview, external sites). */
  onReload: () => void;
  /** Open the project-upload chooser (folder / .zip). Always shown — works
   *  regardless of which tab is active. Optional so the toolbar still renders
   *  in contexts that don't wire it. */
  onUploadProject?: () => void;
  /** When false, hide marker / comments / send buttons. The refresh
   *  button still renders. Set to true on tabs where annotation makes
   *  sense (port-bearing previews; in practice we now also show on
   *  code-server / external sites since the snapshot path works there
   *  too — the only excluded tab type is the blank "new tab" page,
   *  which never has a URL). */
  showAnnotationTools?: boolean;
  /** Fires when the user clicks the "discard annotation" arrow. Parent
   *  should discard the captured snapshot + any drawings / comments
   *  attached to it. Only meaningful when `hasSnapshot` is true. */
  onCollapse?: () => void;
  /** Fires when the user clicks the Send button — parent should
   *  composite the snapshot + drawings and push them into chat. */
  onSend?: () => void;
  /** Whether a snapshot is currently captured for this tab — controls
   *  whether Send + the discard-snapshot arrow are visible. */
  hasSnapshot?: boolean;
  /** Show the live visual-edit tool button. Only true in the Electron
   *  desktop app (the picker drives a CDP debugger on the tab's
   *  WebContentsView — unavailable in a plain browser). */
  showVisualEdit?: boolean;
  /** Whether a visual-edit session is currently active for this tab. */
  visualEditActive?: boolean;
  /** Toggle the live visual editor on/off for the active tab. */
  onToggleVisualEdit?: () => void;
  /** Current upload/run status — drives the toolbar widget left of the tunnel dot. */
  uploadStatus?: UploadStatus;
  /** Called when the widget is clicked: re-opens the modal while busy, or opens
   *  the preview tab once the dev server is up. */
  onUploadWidgetClick?: () => void;
  /** Called when the user dismisses (✕) a finished/errored widget. */
  onUploadWidgetDismiss?: () => void;
  className?: string;
};

/**
 * Floating toolbar that sits under the editor tabs. Two render modes:
 *
 *   visible=true → full strip:
 *     [🔄 refresh]  [✏️ marker]  [💬 comments]  [✕ discard]  [Send]  [⟩ hide]
 *                     ↑              ↑              ↑          ↑
 *                     only when      only when      only when  only when
 *                     showAnnotation showAnnotation hasSnapshot hasSnapshot
 *
 *   visible=false → just the chevron handle (small pill flush against the
 *     chat panel edge) — clicking it expands the strip back. We keep the
 *     handle in the same anchor position so the user can find it after
 *     hiding the toolbar (the previous "removed entirely" version made
 *     the marker / comments tools unreachable).
 *
 * The refresh button is always reachable in the full strip. Marker /
 * comments are controlled by `showAnnotationTools` (per-tab decision in
 * the parent). The discard arrow + Send button only appear once a
 * snapshot has been captured.
 */
export function EditorOverlayToolbar({
  visible,
  onToggleVisible,
  activeTool,
  onChangeTool,
  onReload,
  onUploadProject,
  showAnnotationTools = false,
  onCollapse,
  onSend,
  hasSnapshot,
  showVisualEdit = false,
  visualEditActive = false,
  onToggleVisualEdit,
  uploadStatus,
  onUploadWidgetClick,
  onUploadWidgetDismiss,
  className,
}: EditorOverlayToolbarProps) {
  // Collapsed mode — just the handle. The `.collapsed` modifier + the
  // matching CSS in globals.css squash the container down to a 40 px
  // pill so it reads as a tab attached to the chat panel.
  if (!visible) {
    return (
      <div
        className={`editor-overlay-toolbar collapsed${className ? ` ${className}` : ""}`}
      >
        <button
          type="button"
          className="overlay-toolbar-handle"
          onClick={onToggleVisible}
          title="Show toolbar"
          aria-label="Show toolbar"
        >
          <IconChevronLeft />
        </button>
      </div>
    );
  }

  // Click the active tool again to deselect it — gives the user a way to
  // restore normal iframe interaction without leaving the toolbar.
  const toggleTool = (tool: EditorOverlayTool) => {
    onChangeTool(activeTool === tool ? null : tool);
  };

  return (
    <div className={`editor-overlay-toolbar${className ? ` ${className}` : ""}`}>
      {/* Upload/run status widget — leftmost element. Shows a ring while
          uploading, a play icon when the dev server is ready, or an error
          dot on failure. Clicking re-opens the modal or opens the preview
          tab; the ✕ dismisses a finished/errored run. */}
      {uploadStatus && uploadStatus.phase !== "idle" && (
        <UploadRunWidget
          status={uploadStatus}
          onClick={onUploadWidgetClick}
          onDismiss={onUploadWidgetDismiss}
        />
      )}

      {/* Phase 6 — tunnel status dot. Sits on the left of the toolbar so
          it never collides with the right-aligned annotation tools. Hidden
          in non-Electron contexts. */}
      <TunnelStatusDot />

      {/* Refresh — always visible. Works for any tab URL. */}
      <button
        type="button"
        className="overlay-toolbar-btn"
        onClick={onReload}
        title="Reload this tab"
        aria-label="Reload this tab"
      >
        <IconReload />
      </button>

      {/* Upload a local project (folder / .zip) → extract + auto-run. Always
          available; independent of the active tab. */}
      {onUploadProject && (
        <button
          type="button"
          className="overlay-toolbar-btn"
          onClick={onUploadProject}
          title="Upload a local project (folder or .zip) and run it"
          aria-label="Upload project"
        >
          <IconUpload />
        </button>
      )}

      {showAnnotationTools && (
        <>
          <div className="overlay-toolbar-divider" aria-hidden />

          {/* Marker — clicking this auto-takes a snapshot (via parent's
              onChangeTool wrapper) if one doesn't exist yet. */}
          <button
            type="button"
            className={`overlay-toolbar-btn${activeTool === "pointer" ? " active" : ""}`}
            onClick={() => toggleTool("pointer")}
            title="Rectangle — draw a box on a snapshot of this tab"
            aria-label="Rectangle"
            aria-pressed={activeTool === "pointer"}
          >
            <IconPointer />
          </button>

          {/* Comments — same auto-snapshot behavior as marker. */}
          <button
            type="button"
            className={`overlay-toolbar-btn${activeTool === "comments" ? " active" : ""}`}
            onClick={() => toggleTool("comments")}
            title="Comments — pin notes on a snapshot of this tab"
            aria-label="Comments"
            aria-pressed={activeTool === "comments"}
          >
            <IconComments />
          </button>

          {/* Discard snapshot + Send appear only after a snapshot is
              captured. Snapshot lifecycle: marker / comments click
              triggers capture; discard X or Send clears it. */}
          {hasSnapshot && (
            <>
              <div className="overlay-toolbar-divider" aria-hidden />
              <button
                type="button"
                className="overlay-toolbar-collapse"
                onClick={onCollapse}
                title="Discard snapshot and annotations"
                aria-label="Discard snapshot and annotations"
              >
                <IconCross />
              </button>
              <div className="overlay-toolbar-divider" aria-hidden />
              <button
                type="button"
                className="overlay-toolbar-send"
                onClick={onSend}
                title="Send annotated screenshot to chat"
                aria-label="Send to chat"
              >
                <IconSend />
                <span>Send</span>
              </button>
            </>
          )}
        </>
      )}

      {/* Live visual editor — distinct from the snapshot-based marker /
          comments flow. Picks real DOM elements over CDP and edits them live;
          Electron-only. */}
      {showVisualEdit && (
        <>
          <div className="overlay-toolbar-divider" aria-hidden />
          <button
            type="button"
            className={`overlay-toolbar-btn${visualEditActive ? " active" : ""}`}
            onClick={onToggleVisualEdit}
            title="Visual edit — point at elements and edit them live"
            aria-label="Visual edit"
            aria-pressed={visualEditActive}
          >
            <IconVisualEdit />
          </button>
        </>
      )}

      {/* Hide the toolbar — separate from the snapshot "discard" chevron
          (which only appears with hasSnapshot). This one is always
          available on the far right so the user can collapse the strip
          when it's in the way of the iframe content. */}
      <div className="overlay-toolbar-divider" aria-hidden />
      <button
        type="button"
        className="overlay-toolbar-btn"
        onClick={onToggleVisible}
        title="Hide toolbar"
        aria-label="Hide toolbar"
      >
        <IconChevronRight />
      </button>
    </div>
  );
}

/* ============================================================
   Upload / run status widget
   ============================================================ */

function UploadRunWidget({
  status,
  onClick,
  onDismiss,
}: {
  status: UploadStatus;
  onClick?: () => void;
  onDismiss?: () => void;
}) {
  const { phase, progress, projectName, previewUrl, error } = status;

  // Determinate progress ring (used while zipping: we have a real %).
  // Circle r=5 → circumference ≈ 31.4.
  const CIRC = 31.4;
  const offset = phase === "zipping" ? CIRC * (1 - progress / 100) : 0;

  const isReady = phase === "done" && !!previewUrl;
  const isError = phase === "error";
  const isBusy = phase === "zipping" || phase === "uploading" || phase === "running";

  let label = "";
  if (phase === "zipping") label = `Packaging ${projectName}… ${progress}%`;
  else if (phase === "uploading") label = `Uploading ${projectName}…`;
  else if (phase === "running") label = `Running ${projectName}…`;
  else if (isReady) label = `${projectName} ready — click to open preview`;
  else if (isError) label = `Upload failed: ${error ?? "unknown error"} — click to reopen`;
  else if (phase === "done") label = `${projectName} done`;

  const widgetClass = [
    "overlay-upload-widget",
    isReady ? "ready" : "",
    isError ? "error" : "",
    isBusy ? "busy" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className="overlay-upload-widget-wrap">
      <button
        type="button"
        className={widgetClass}
        onClick={onClick}
        title={label}
        aria-label={label}
      >
        {isReady ? (
          <IconPlay />
        ) : isError ? (
          <IconAlertDot />
        ) : (
          // Ring: determinate while zipping, spinning while uploading/running.
          <svg
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="none"
            aria-hidden
            className={isBusy && phase !== "zipping" ? "overlay-upload-spin" : undefined}
          >
            {/* Track */}
            <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="2" opacity="0.25" />
            {/* Fill */}
            <circle
              cx="8"
              cy="8"
              r="5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray={`${CIRC} ${CIRC}`}
              strokeDashoffset={phase === "zipping" ? offset : 0}
              style={{ transformOrigin: "8px 8px", transform: "rotate(-90deg)" }}
            />
          </svg>
        )}
      </button>
      {/* Dismiss button — shown on hover via CSS for done/error states. */}
      {!isBusy && (
        <button
          type="button"
          className="overlay-upload-dismiss"
          onClick={(e) => { e.stopPropagation(); onDismiss?.(); }}
          title="Dismiss"
          aria-label="Dismiss upload status"
        >
          <svg viewBox="0 0 10 10" width="8" height="8" fill="none" aria-hidden>
            <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

/* ============================================================
   Tunnel status indicator (Phase 6)
   ============================================================ */

const STATUS_COLOR: Record<TunnelStatusValue, string> = {
  idle: "#888",
  granting: "#eab308",
  connecting: "#eab308",
  connected: "#22c55e",
  reconnecting: "#f97316",
  error: "#ef4444",
};

const STATUS_LABEL: Record<TunnelStatusValue, string> = {
  idle: "Tunnel idle",
  granting: "Tunnel — requesting access…",
  connecting: "Tunnel — connecting…",
  connected: "Tunnel connected",
  reconnecting: "Tunnel reconnecting…",
  error: "Tunnel error",
};

function TunnelStatusDot() {
  const status = useTunnelStatus();
  if (!status) return null; // outside Electron, or pre-first-status paint
  const color = STATUS_COLOR[status.status];
  const label = status.error
    ? `${STATUS_LABEL[status.status]} — ${status.error}`
    : STATUS_LABEL[status.status];
  return (
    <span
      className="overlay-tunnel-status"
      title={label}
      aria-label={label}
      style={{ background: color }}
    />
  );
}

/* ============================================================
   Inline icons
   ============================================================ */

function IconReload() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
      <path
        d="M3 8a5 5 0 0 1 9-3M13 3v3h-3M13 8a5 5 0 0 1-9 3M3 13v-3h3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconUpload() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
      <path
        d="M8 10V2.5M5 5.5L8 2.5l3 3M3 10.5v2A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconChevronRight() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6 3l5 5-5 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconChevronLeft() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M10 3L5 8l5 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCross() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconPointer() {
  // Rectangle drawing tool icon.
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect
        x="2"
        y="3.5"
        width="12"
        height="9"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="2" cy="3.5" r="1.4" fill="currentColor" />
    </svg>
  );
}

function IconSend() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 13.5L14 8 2 2.5l2.5 5.5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        fill="currentColor"
      />
      <path
        d="M4.5 8H14"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconVisualEdit() {
  // Cursor pointing at a styled box — "edit the element you point at".
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="2" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8.5 8.5l5 2-2 .8-.8 2z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function IconComments() {
  // Round chat bubble with three dots.
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle
        cx="8"
        cy="7.5"
        r="5.5"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M5.5 12l-1.5 2 .5-2.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        fill="currentColor"
      />
      <circle cx="6" cy="7.5" r="0.9" fill="currentColor" />
      <circle cx="8" cy="7.5" r="0.9" fill="currentColor" />
      <circle cx="10" cy="7.5" r="0.9" fill="currentColor" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M5 3.5l8 4.5-8 4.5V3.5z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function IconAlertDot() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 5v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="8" cy="11" r="0.9" fill="currentColor" />
    </svg>
  );
}

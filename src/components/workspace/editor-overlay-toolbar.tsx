"use client";

export type EditorOverlayTool = "pointer" | "comments";

type EditorOverlayToolbarProps = {
  /** Whether the toolbar is showing its full toolset (true) or just the
   *  collapsed handle (false). Controlled by the parent so the open/close
   *  state survives any mid-flow re-mounts (e.g. during the screen-grab
   *  hand-off when this component briefly unmounts). Only matters when
   *  annotation tools are visible — the refresh button stays put either
   *  way. */
  expanded: boolean;
  /** Currently active tool (if any). `null` means no tool is selected —
   *  cursor is left untouched so the user can interact with the iframe. */
  activeTool: EditorOverlayTool | null;
  onChangeTool: (tool: EditorOverlayTool | null) => void;
  /** Reload the active tab's iframe. Always shown — works for any URL
   *  (code-server, live preview, external sites). */
  onReload: () => void;
  /** When false, hide marker / comments / send buttons. The refresh
   *  button still renders. Set to true only when the active tab is a
   *  port-bearing preview where annotation actually makes sense. */
  showAnnotationTools?: boolean;
  /** Fires when the user clicks the collapsed handle. Parent should
   *  capture the iframe snapshot and arm the marker tool. */
  onExpand?: () => void;
  /** Fires when the user clicks the collapse arrow in the expanded
   *  toolbar. Parent should discard the snapshot. */
  onCollapse?: () => void;
  /** Fires when the user clicks the Send button — parent should composite
   *  the snapshot + drawings and push them into chat as an attachment. */
  onSend?: () => void;
  /** Whether a snapshot is currently captured for this tab — controls
   *  whether the Send button is shown / enabled. */
  hasSnapshot?: boolean;
  className?: string;
};

/**
 * Floating toolbar that sits under the editor tabs whenever a tab has a
 * URL loaded. Two layers of buttons:
 *
 *   1. Refresh — always visible. Reloads the active iframe in place
 *      (works for code-server, dev-server previews, external sites,
 *      anything). Lives at the leading edge so it's still reachable when
 *      annotation tools are hidden or the bar is collapsed.
 *
 *   2. Marker / Comments / Send — only meaningful for port-bearing
 *      previews (live web app), so they're gated behind
 *      `showAnnotationTools`. Inside that subset, the bar can collapse
 *      down to a chevron handle for users who want maximum unobstructed
 *      view of the preview.
 */
export function EditorOverlayToolbar({
  expanded,
  activeTool,
  onChangeTool,
  onReload,
  showAnnotationTools = false,
  onExpand,
  onCollapse,
  onSend,
  hasSnapshot,
  className,
}: EditorOverlayToolbarProps) {
  // Click the active tool again to deselect it — gives the user a way to
  // restore normal iframe interaction without leaving the toolbar.
  const toggleTool = (tool: EditorOverlayTool) => {
    onChangeTool(activeTool === tool ? null : tool);
  };

  // Collapsed view: only meaningful when annotation tools are part of
  // the picture. When there's nothing to collapse to but the refresh
  // button, we always render the full bar.
  if (showAnnotationTools && !expanded) {
    return (
      <div className={`editor-overlay-toolbar collapsed${className ? ` ${className}` : ""}`}>
        <button
          type="button"
          className="overlay-toolbar-btn"
          onClick={onReload}
          title="Reload this tab"
          aria-label="Reload this tab"
        >
          <IconReload />
        </button>
        <button
          type="button"
          className="overlay-toolbar-handle"
          onClick={onExpand}
          title="Show drawing toolbar"
          aria-label="Show drawing toolbar"
          aria-expanded={false}
        >
          <IconChevronLeft />
        </button>
      </div>
    );
  }

  return (
    <div className={`editor-overlay-toolbar${className ? ` ${className}` : ""}`}>
      {/* Refresh — always visible. Works for any tab URL: code-server,
          dev-server previews, external sites, etc. */}
      <button
        type="button"
        className="overlay-toolbar-btn"
        onClick={onReload}
        title="Reload this tab"
        aria-label="Reload this tab"
      >
        <IconReload />
      </button>

      {/* Annotation tools — gated behind showAnnotationTools so they only
          appear on port-bearing previews where drawing on a web app
          actually makes sense. */}
      {showAnnotationTools && (
        <>
          <div className="overlay-toolbar-divider" aria-hidden />

          {/* Collapse arrow — hides the annotation tools (parent swaps in
              the small "Annotate" pill so the page is unobstructed). */}
          <button
            type="button"
            className="overlay-toolbar-collapse"
            onClick={onCollapse}
            title="Hide annotation tools"
            aria-label="Hide annotation tools"
          >
            <IconChevronRight />
          </button>

          <div className="overlay-toolbar-divider" aria-hidden />

          <button
            type="button"
            className={`overlay-toolbar-btn${activeTool === "pointer" ? " active" : ""}`}
            onClick={() => toggleTool("pointer")}
            title="Marker"
            aria-label="Marker"
            aria-pressed={activeTool === "pointer"}
          >
            <IconPointer />
          </button>
          <button
            type="button"
            className={`overlay-toolbar-btn${activeTool === "comments" ? " active" : ""}`}
            onClick={() => toggleTool("comments")}
            title="Comments"
            aria-label="Comments"
            aria-pressed={activeTool === "comments"}
          >
            <IconComments />
          </button>

          {hasSnapshot && (
            <>
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
    </div>
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

function IconPointer() {
  // Highlighter marker — diagonal body with a colored tip.
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M11 2.5l2.5 2.5-6.5 6.5-2.5.5.5-2.5 6-7z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M9 4.5l2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M3 14h4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.6"
      />
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

"use client";

export type EditorOverlayTool = "pointer" | "comments";

type EditorOverlayToolbarProps = {
  /** Whether the toolbar is showing its full toolset (true) or just the
   *  collapsed handle (false). Controlled by the parent so the open/close
   *  state survives any mid-flow re-mounts (e.g. during the screen-grab
   *  hand-off when this component briefly unmounts). */
  expanded: boolean;
  /** Currently active tool (if any). `null` means no tool is selected —
   *  cursor is left untouched so the user can interact with the iframe. */
  activeTool: EditorOverlayTool | null;
  onChangeTool: (tool: EditorOverlayTool | null) => void;
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
 * Floating toolbar that sits just under the editor tabs whenever a port-
 * bearing URL is loaded in the active tab (i.e. a running web app — the
 * tools below are meant to operate on that preview).
 *
 * Collapse behaviour: clicking the left arrow shrinks the bar down to a
 * single chevron handle. Clicking the handle expands it back. The width
 * + opacity transition makes the open/close feel smooth instead of pop-in.
 */
export function EditorOverlayToolbar({
  expanded,
  activeTool,
  onChangeTool,
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

  if (!expanded) {
    return (
      <div className={`editor-overlay-toolbar collapsed${className ? ` ${className}` : ""}`}>
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
      {/* Collapse arrow — hides the whole toolbar (parent swaps in the
          small "Annotate" pill so the page is unobstructed). */}
      <button
        type="button"
        className="overlay-toolbar-collapse"
        onClick={onCollapse}
        title="Hide toolbar"
        aria-label="Hide toolbar"
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
    </div>
  );
}

/* ============================================================
   Inline icons
   ============================================================ */

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

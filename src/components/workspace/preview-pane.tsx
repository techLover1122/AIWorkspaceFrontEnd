"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { NewTabPage, TERMINAL_VIEW_URL } from "./new-tab-page";
import { PortsView } from "./PortsView";
import { TerminalView } from "./TerminalView";
import { BlockedServicePanel } from "./blocked-service-panel";
import { useWorkspaceTab } from "../../contexts/WorkspaceTabContext";
import {
  checkIframeCompat,
  openInBrowserTab,
  openManagedPopup,
} from "../../utils/iframeCompat";
import { getElectronTabs } from "../../utils/electronTabs";
import type { EditorOverlayTool } from "./editor-overlay-toolbar";

export type DrawingPoint = { x: number; y: number };
export type Drawing = {
  id: string;
  /** Polyline points in CSS pixels relative to the iframe's rendered box
   *  (i.e. the preview-content container — same size as the iframe). */
  points: DrawingPoint[];
};

/** A numbered comment pin placed on the snapshot. The position is in the
 *  same coord space as Drawing.points (CSS px relative to iframe box). */
export type Comment = {
  id: string;
  x: number;
  y: number;
  text: string;
};

type PreviewPaneProps = {
  tabId: string;
  url: string;
  codeServerUrl: string;
  isActive: boolean;
  /** Current overlay tool (marker / select / comments). `null` = no tool
   *  selected. */
  overlayTool?: EditorOverlayTool | null;
  /** User-drawn annotations for this tab. Persisted in the parent so they
   *  survive tab switches. Stored in iframe-viewport coords. */
  drawings?: Drawing[];
  onAddDrawing?: (points: DrawingPoint[]) => void;
  onRemoveDrawing?: (id: string) => void;
  /** Numbered comment pins placed by the user while the comments tool is
   *  active. Same per-tab persistence model as drawings. */
  comments?: Comment[];
  onAddComment?: (comment: { x: number; y: number; text: string }) => void;
  onRemoveComment?: (id: string) => void;
  /** When set, the live iframe is hidden and this PNG data URL is shown
   *  in its place — used by the annotation flow to freeze the iframe at
   *  the moment the user opened the toolbar. */
  snapshot?: string;
  /** Reports the tab-content host element + drawings SVG element back to the
   *  parent so the screen-capture + composite helpers can find them. In
   *  Electron mode this is the `.preview-content` div whose rect represents
   *  where the WebContentsView sits; in the browser fallback it's the same
   *  div, but the rect is also the iframe's rect (they coincide). */
  onElementsReady?: (els: {
    contentEl: HTMLElement | null;
    svg: SVGSVGElement | null;
  }) => void;
  /** Fires whenever the iframe starts/stops loading. Drives the tab strip's
   *  sweep animation — see `.editor-tab.loading` in globals.css. */
  onLoadingChange?: (tabId: string, loading: boolean) => void;
  onNavigate: (tabId: string, url: string, label: string) => void;
};

export const PORTS_VIEW_URL = "aiide://ports";

/** Speech-bubble cursor used while the comments tool is active. Hotspot
 *  sits at the tail tip (~8, 28) so clicks land where the bubble points. */
const COMMENT_CURSOR =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32' fill='none'><path d='M4 5h22a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3H14l-6 6v-6H4a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z' fill='%23fff' stroke='black' stroke-width='1.6' stroke-linejoin='round'/><circle cx='10' cy='14' r='1.3' fill='black'/><circle cx='15' cy='14' r='1.3' fill='black'/><circle cx='20' cy='14' r='1.3' fill='black'/></svg>\") 8 28, crosshair";

const MARKER_STROKE_COLOR = "#ef4444";
const MARKER_STROKE_WIDTH = 4;

// Every tab renders simultaneously and is hidden via `display:none` when
// inactive — that keeps each iframe mounted across tab switches so its DOM,
// scroll position, and any in-page state survive instead of triggering a full
// reload every time the user comes back to the tab.
export function PreviewPane({
  tabId,
  url,
  codeServerUrl,
  isActive,
  overlayTool,
  drawings,
  onAddDrawing,
  onRemoveDrawing,
  comments,
  onAddComment,
  onRemoveComment,
  snapshot,
  onElementsReady,
  onLoadingChange,
  onNavigate,
}: PreviewPaneProps) {
  const tabCtx = useWorkspaceTab();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const drawingsSvgRef = useRef<SVGSVGElement>(null);

  // Electron WebContentsView path. When the preload exposes __AIIDE__.tab,
  // every tab with a real URL is hosted by a main-process WebContentsView
  // (one CDP page target per tab) instead of a DOM <iframe>. Falls back to
  // <iframe> when running in a regular browser — keeps `next dev` workable.
  const electron = getElectronTabs();
  const isExternalContent = !!url && url !== PORTS_VIEW_URL;
  const useView = !!electron && isExternalContent;

  // Mark the tab as loading the moment its URL changes (the iframe will
  // refetch) and clear it again on the next `load` event. Empty URL = the
  // "new tab" page, which doesn't fetch anything, so we never enter the
  // loading state for it. In Electron mode, the main process owns the
  // loading signal — the workspace shell subscribes via __AIIDE__.tab.
  const onLoadingChangeRef = useRef(onLoadingChange);
  useEffect(() => {
    onLoadingChangeRef.current = onLoadingChange;
  }, [onLoadingChange]);
  useEffect(() => {
    if (useView) return; // main-process events drive loading state
    if (!url || url === PORTS_VIEW_URL) {
      onLoadingChangeRef.current?.(tabId, false);
      return;
    }
    onLoadingChangeRef.current?.(tabId, true);
  }, [tabId, url, useView]);

  // ── Electron tab lifecycle ───────────────────────────────────────────
  // open on mount / close on unmount; navigate / setVisible as props change.
  // No effect if useView is false.
  useEffect(() => {
    if (!useView || !electron) return;
    electron.open(tabId, url).catch(() => { /* logged in main */ });
    return () => {
      electron.close(tabId).catch(() => { /* tab already gone */ });
    };
    // open is intentionally per-tabId only — URL changes go through navigate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, useView]);

  useEffect(() => {
    if (!useView || !electron) return;
    electron.navigate(tabId, url).catch(() => {});
  }, [tabId, url, useView, electron]);

  // Show this tab's view only while it's the active tab AND no snapshot
  // overlay is up. Snapshot mode renders a static <img> + drawings in the
  // DOM; the live view must be hidden behind it.
  useEffect(() => {
    if (!useView || !electron) return;
    const shouldShow = isActive && !snapshot;
    electron.setVisible(tabId, shouldShow).catch(() => {});
  }, [tabId, isActive, snapshot, useView, electron]);
  // Position of an in-flight comment that hasn't been committed yet — the
  // popover lives at this point until the user types and confirms, or
  // dismisses with Esc / empty submit.
  const [draftPos, setDraftPos] = useState<{ x: number; y: number } | null>(
    null
  );
  const hiddenStyle = isActive ? undefined : { display: "none" as const };

  // Cancel any in-flight draft when the user leaves comments mode (e.g.
  // by switching to marker or collapsing the toolbar).
  useEffect(() => {
    if (overlayTool !== "comments" && draftPos) {
      setDraftPos(null);
    }
  }, [overlayTool, draftPos]);

  // Report element refs whenever they're attached. Plain effect on every
  // render keeps the parent's map in sync — the workspace shell reads
  // these at capture / composite time. tabId / url change re-runs to
  // catch the host element re-creation on URL switch.
  useEffect(() => {
    onElementsReady?.({
      contentEl: contentRef.current ?? iframeRef.current,
      svg: drawingsSvgRef.current,
    });
  });

  // Iframe-compat check. MUST sit before the early returns so the hook
  // count stays stable across url-state transitions (empty → ports →
  // terminal → http) — React enforces same-order hook calls per render.
  // checkIframeCompat is a pure URL match against a small registry; the
  // useMemo just dedupes work on re-renders where url didn't change.
  const compat = useMemo(() => checkIframeCompat(url), [url]);

  if (!url) {
    return (
      <div className="preview-frame" style={hiddenStyle}>
        <NewTabPage
          codeServerUrl={codeServerUrl}
          onNavigate={(u, label) => onNavigate(tabId, u, label)}
        />
      </div>
    );
  }

  if (url === PORTS_VIEW_URL) {
    return (
      <div className="preview-frame" style={hiddenStyle}>
        <PortsView
          onOpen={(u, label) => {
            if (tabCtx) tabCtx.openTab(u, label);
            else onNavigate(tabId, u, label);
          }}
        />
      </div>
    );
  }

  if (url === TERMINAL_VIEW_URL) {
    return (
      <div className="preview-frame" style={hiddenStyle}>
        <TerminalView />
      </div>
    );
  }

  // Known-blocked-host check (compat memoised above with the other
  // hooks). Services like Stripe Checkout, OAuth providers, banks,
  // etc. refuse iframe embedding via X-Frame-Options or CSP
  // frame-ancestors. Render the BlockedServicePanel instead of the
  // iframe — the panel gives the user one-click "open externally"
  // options without their workspace ever unloading.
  //
  // Skipped in Electron mode: a WebContentsView is a top-level page, not
  // an embedded frame, so X-Frame-Options and frame-ancestors don't apply.
  // Anything that's only blocked because of embedding restrictions loads
  // fine inside the view.
  if (compat.blocked && !useView) {
    return (
      <div className="preview-frame" style={hiddenStyle}>
        <BlockedServicePanel url={url} info={compat} />
      </div>
    );
  }

  // Layered (low → high z-index):
  //   1. <iframe> — the live preview (browser fallback only)
  //      OR an empty .preview-content div whose rect drives the
  //      WebContentsView's setBounds (Electron mode)
  //   2. <img snapshot> — frozen pixels when snapshot mode is active
  //   3. comments surface — when comments tool is active (catches clicks)
  //   4. drawing surface — when marker tool is active (catches clicks)
  //   5. <svg> annotations layer — pins + drawings sit ON TOP of the
  //      surfaces so existing pins remain hoverable for delete-X even
  //      while a tool is active
  //   6. comment draft popover — text input attached to the draft pin
  //
  // Note: the reload button used to live here as a floating top-right
  // overlay; it's now a first-class button in the EditorOverlayToolbar
  // (rendered by workspace-shell) so it sits next to the marker /
  // comments tools and stays consistently placed across tabs.
  return (
    <div className="preview-frame" style={hiddenStyle}>
      <div className="preview-content" ref={contentRef}>
        {useView ? (
          // The WebContentsView is composited above the renderer by Electron.
          // Nothing to render here — the preview-content div is just a layout
          // anchor whose rect drives setBounds (read by the workspace shell).
          null
        ) : (
          <iframe
            className="preview-iframe"
            src={url}
            title="Preview"
            loading="lazy"
            ref={iframeRef}
            onLoad={() => onLoadingChangeRef.current?.(tabId, false)}
            // While a snapshot is being annotated, keep the iframe in the
            // DOM (so unmounting doesn't lose its state) but invisible
            // behind the static image.
            style={snapshot ? { visibility: "hidden" } : undefined}
          />
        )}

        {/*
          Escape-hatch overlay: every iframe gets a tiny "open externally"
          button so the user can pop the URL into a window/tab if the
          embedded view turns out to be blocked / broken / blank. Hidden
          while a snapshot is being annotated (the user isn't trying to
          navigate then). The known-blocked registry handles the common
          cases up-front; this button is the catch-all for everything
          else (custom paywalls, frame-buster JS, etc.).
        */}
        {!snapshot && (
          <div className="preview-open-externally" aria-hidden={false}>
            <button
              type="button"
              className="preview-open-externally-btn"
              onClick={() => openManagedPopup(url)}
              title="Open in a workspace popup window"
              aria-label="Open in workspace popup"
            >
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden>
                <rect
                  x="2"
                  y="3"
                  width="12"
                  height="10"
                  rx="1.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <path
                  d="M2 6h12"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <button
              type="button"
              className="preview-open-externally-btn"
              onClick={() => openInBrowserTab(url)}
              title="Open in a new browser tab"
              aria-label="Open in new browser tab"
            >
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden>
                <path
                  d="M10 3h3v3M13 3l-6 6"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M6.5 4H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V9.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )}

        {snapshot && (
          <img
            className="preview-snapshot"
            src={snapshot}
            alt="Preview snapshot"
            draggable={false}
          />
        )}

        {overlayTool === "comments" && (
          <CommentsSurface
            disabled={!!draftPos}
            onPlace={(pos) => setDraftPos(pos)}
          />
        )}

        {overlayTool === "pointer" && (
          <DrawingSurface onCommit={(points) => onAddDrawing?.(points)} />
        )}

        <AnnotationsLayer
          drawings={drawings ?? []}
          comments={comments ?? []}
          interactive={overlayTool !== "pointer"}
          onRemoveDrawing={onRemoveDrawing}
          onRemoveComment={onRemoveComment}
          svgRef={drawingsSvgRef}
        />

        {draftPos && (
          <CommentDraftPopover
            x={draftPos.x}
            y={draftPos.y}
            onCommit={(text) => {
              onAddComment?.({ x: draftPos.x, y: draftPos.y, text });
              setDraftPos(null);
            }}
            onCancel={() => setDraftPos(null)}
          />
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Annotations layer — drawings + numbered comment pins share one <svg>
   so the composite-to-PNG flow only has to serialize a single element.
   ============================================================ */

function AnnotationsLayer({
  drawings,
  comments,
  interactive,
  onRemoveDrawing,
  onRemoveComment,
  svgRef,
}: {
  drawings: Drawing[];
  comments: Comment[];
  /** When false, the layer is purely visual — the marker drawing surface
   *  above swallows pointer events while the user is in draw mode. */
  interactive: boolean;
  onRemoveDrawing?: (id: string) => void;
  onRemoveComment?: (id: string) => void;
  svgRef?: React.Ref<SVGSVGElement>;
}) {
  return (
    <svg
      ref={svgRef}
      className="preview-drawings"
      // Transparent to pointer events at the root; individual polylines,
      // pins, and the X-delete circle opt back in. Keeps the surfaces
      // below catching clicks on empty areas.
      style={{ pointerEvents: "none" }}
    >
      {drawings.map((d) => (
        <DrawingShape
          key={d.id}
          drawing={d}
          interactive={interactive}
          onRemove={() => onRemoveDrawing?.(d.id)}
        />
      ))}
      {comments.map((c, i) => (
        <CommentPin
          key={c.id}
          index={i + 1}
          comment={c}
          interactive={interactive}
          onRemove={() => onRemoveComment?.(c.id)}
        />
      ))}
    </svg>
  );
}

function CommentPin({
  index,
  comment,
  interactive,
  onRemove,
}: {
  index: number;
  comment: Comment;
  interactive: boolean;
  onRemove: () => void;
}) {
  const [hover, setHover] = useState(false);
  // Pin radius and where the delete X floats relative to the pin centre.
  const r = 12;
  return (
    <g
      transform={`translate(${comment.x}, ${comment.y})`}
      onMouseEnter={() => interactive && setHover(true)}
      onMouseLeave={() => setHover(false)}
      pointerEvents={interactive ? "all" : "none"}
    >
      <title>{comment.text}</title>
      <circle
        r={r}
        fill="#7c3aed"
        stroke="#ffffff"
        strokeWidth={2}
        opacity={0.96}
      />
      <text
        textAnchor="middle"
        dominantBaseline="central"
        fill="#ffffff"
        fontSize={12}
        fontWeight={600}
        style={{ userSelect: "none" }}
      >
        {index}
      </text>
      {interactive && hover && (
        <g
          transform={`translate(${r}, ${-r})`}
          style={{ cursor: "pointer" }}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          pointerEvents="all"
        >
          <circle r={8} fill="#1f1f1f" stroke="#fff" strokeWidth={1.4} />
          <path
            d="M-3 -3 L3 3 M3 -3 L-3 3"
            stroke="#fff"
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        </g>
      )}
    </g>
  );
}

function DrawingShape({
  drawing,
  interactive,
  onRemove,
}: {
  drawing: Drawing;
  interactive: boolean;
  onRemove: () => void;
}) {
  const [hover, setHover] = useState(false);
  if (drawing.points.length < 2) return null;

  const DeleteHandle = ({ cx, cy }: { cx: number; cy: number }) =>
    interactive && hover ? (
      <g
        transform={`translate(${cx}, ${cy})`}
        style={{ cursor: "pointer" }}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        pointerEvents="all"
      >
        <circle r={9} fill="#1f1f1f" stroke="#fff" strokeWidth={1.4} />
        <path
          d="M-3.5 -3.5 L3.5 3.5 M3.5 -3.5 L-3.5 3.5"
          stroke="#fff"
          strokeWidth={1.6}
          strokeLinecap="round"
        />
      </g>
    ) : null;

  // Rectangle: exactly 2 stored points = [start corner, end corner].
  if (drawing.points.length === 2) {
    const [p1, p2] = drawing.points;
    const x = Math.min(p1.x, p2.x);
    const y = Math.min(p1.y, p2.y);
    const w = Math.abs(p2.x - p1.x);
    const h = Math.abs(p2.y - p1.y);
    return (
      <g
        onMouseEnter={() => interactive && setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <rect
          x={x} y={y} width={w} height={h}
          fill="none"
          stroke={MARKER_STROKE_COLOR}
          strokeWidth={MARKER_STROKE_WIDTH}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.92}
          pointerEvents={interactive ? "stroke" : "none"}
        />
        {/* wider invisible hit area */}
        <rect
          x={x} y={y} width={w} height={h}
          fill="none"
          stroke="transparent"
          strokeWidth={20}
          pointerEvents={interactive ? "stroke" : "none"}
        />
        <DeleteHandle cx={x + w} cy={Math.max(y, 10)} />
      </g>
    );
  }

  // Legacy: polyline for any freehand strokes with more than 2 points.
  const pointsStr = drawing.points.map((p) => `${p.x},${p.y}`).join(" ");
  let maxX = -Infinity, minY = Infinity;
  for (const p of drawing.points) {
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
  }
  return (
    <g
      onMouseEnter={() => interactive && setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <polyline
        points={pointsStr}
        fill="none"
        stroke={MARKER_STROKE_COLOR}
        strokeWidth={MARKER_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.92}
        pointerEvents={interactive ? "stroke" : "none"}
      />
      <polyline
        points={pointsStr}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        strokeLinecap="round"
        pointerEvents={interactive ? "stroke" : "none"}
      />
      <DeleteHandle cx={maxX} cy={Math.max(minY, 10)} />
    </g>
  );
}

/* ============================================================
   Drawing surface
   ============================================================ */

function DrawingSurface({
  onCommit,
}: {
  onCommit: (points: DrawingPoint[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [liveRect, setLiveRect] = useState<{ start: DrawingPoint; end: DrawingPoint } | null>(null);
  const drawingRef = useRef(false);
  const startRef = useRef<DrawingPoint | null>(null);
  const endRef = useRef<DrawingPoint | null>(null);
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  const getPoint = (clientX: number, clientY: number): DrawingPoint => {
    const rect = ref.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  const handleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drawingRef.current = true;
    const p = getPoint(e.clientX, e.clientY);
    startRef.current = p;
    endRef.current = p;
    setLiveRect({ start: p, end: p });
  };

  // Window-level listeners so drag continues even when the cursor leaves
  // the surface (e.g. fast mouse moves, iframe focus steal).
  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      if (!drawingRef.current || !startRef.current) return;
      const end = getPoint(e.clientX, e.clientY);
      endRef.current = end;
      setLiveRect({ start: startRef.current, end });
    };
    const handleUp = () => {
      if (!drawingRef.current || !startRef.current) return;
      drawingRef.current = false;
      const start = startRef.current;
      const end = endRef.current ?? start;
      startRef.current = null;
      endRef.current = null;
      setLiveRect(null);
      // Only commit if the rectangle has some size
      if (Math.abs(end.x - start.x) > 4 || Math.abs(end.y - start.y) > 4) {
        onCommitRef.current([start, end]);
      }
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={ref}
      className="preview-drawing-surface"
      style={{ cursor: "crosshair" }}
      onPointerDown={handleDown}
    >
      {liveRect && (
        <svg className="preview-drawing-live">
          <rect
            x={Math.min(liveRect.start.x, liveRect.end.x)}
            y={Math.min(liveRect.start.y, liveRect.end.y)}
            width={Math.abs(liveRect.end.x - liveRect.start.x)}
            height={Math.abs(liveRect.end.y - liveRect.start.y)}
            fill="none"
            stroke={MARKER_STROKE_COLOR}
            strokeWidth={MARKER_STROKE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.92}
          />
        </svg>
      )}
    </div>
  );
}

/* ============================================================
   Comments surface — captures clicks while the comments tool is active
   and reports the click position to the parent so it can open a draft
   popover at that point.
   ============================================================ */

function CommentsSurface({
  disabled,
  onPlace,
}: {
  /** True while a draft popover is already open — second clicks should
   *  fall through to the popover itself, not place another pin. */
  disabled: boolean;
  onPlace: (pos: { x: number; y: number }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled) return;
    const rect = ref.current!.getBoundingClientRect();
    onPlace({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };
  return (
    <div
      ref={ref}
      className="preview-comments-surface"
      style={{
        cursor: COMMENT_CURSOR,
        pointerEvents: disabled ? "none" : "auto",
      }}
      onClick={handleClick}
    />
  );
}

/* ============================================================
   Comment draft popover — a small textarea + Add/cancel buttons that
   sits attached to the draft pin position. Enter commits, Esc cancels.
   ============================================================ */

function CommentDraftPopover({
  x,
  y,
  onCommit,
  onCancel,
}: {
  x: number;
  y: number;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // Which side of the pin the card sits on. Computed once after mount by
  // measuring the card against its container's bounds — if the default
  // right-of-pin position would overflow (e.g. pin near the iframe edge
  // gets hidden behind the chat panel), we flip the card to the left;
  // same for vertical overflow.
  const [placement, setPlacement] = useState<{
    flipX: boolean;
    flipY: boolean;
  }>({ flipX: false, flipY: false });

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const card = cardRef.current;
    const parent = root?.parentElement;
    if (!root || !card || !parent) return;
    const parentRect = parent.getBoundingClientRect();
    const cardW = card.offsetWidth || 260;
    const cardH = card.offsetHeight || 120;
    // Default placement extends 28 px to the right of (x, y) and downward.
    // Flip if the card would cross the parent's right / bottom edge
    // (account for a small 8 px gutter so the card never touches the
    // visible boundary).
    const flipX = x + 28 + cardW > parentRect.width - 8;
    const flipY = y + cardH > parentRect.height - 8;
    setPlacement({ flipX, flipY });
  }, [x, y, text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onCommit(trimmed);
  };

  // Card offset relative to the pin centre. Default = 28 right, 0 down.
  // When flipped X, card sits to the left so its right edge is 28 px
  // left of the pin. When flipped Y, the card's bottom sits 0 above the
  // pin's top — keeping it visible.
  const cardStyle: React.CSSProperties = {
    left: placement.flipX ? "auto" : 28,
    right: placement.flipX ? 28 : "auto",
    top: placement.flipY ? "auto" : 0,
    bottom: placement.flipY ? 0 : "auto",
  };

  return (
    <div
      ref={rootRef}
      className="preview-comment-draft"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="preview-comment-draft-pin" aria-hidden />
      <div
        ref={cardRef}
        className="preview-comment-draft-card"
        style={cardStyle}
      >
        <textarea
          ref={textareaRef}
          className="preview-comment-draft-input"
          placeholder="Describe the change you want here…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
        />
        <div className="preview-comment-draft-actions">
          <button
            type="button"
            className="preview-comment-draft-btn cancel"
            onClick={onCancel}
            title="Cancel (Esc)"
          >
            Cancel
          </button>
          <button
            type="button"
            className="preview-comment-draft-btn primary"
            onClick={submit}
            title="Add comment (Enter)"
            disabled={!text.trim()}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

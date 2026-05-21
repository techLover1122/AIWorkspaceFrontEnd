"use client";

import { useEffect, useRef, useState } from "react";
import { NewTabPage } from "./new-tab-page";
import { PortsView } from "./PortsView";
import { useWorkspaceTab } from "../../contexts/WorkspaceTabContext";
import type { EditorOverlayTool } from "./editor-overlay-toolbar";

export type DrawingPoint = { x: number; y: number };
export type Drawing = {
  id: string;
  /** Polyline points in CSS pixels relative to the iframe's rendered box
   *  (i.e. the preview-content container — same size as the iframe). */
  points: DrawingPoint[];
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
  /** When set, the live iframe is hidden and this PNG data URL is shown
   *  in its place — used by the annotation flow to freeze the iframe at
   *  the moment the user opened the toolbar. */
  snapshot?: string;
  /** Reports the iframe element + drawings SVG element back to the parent
   *  so the screen-capture + composite helpers can find them. */
  onElementsReady?: (els: {
    iframe: HTMLIFrameElement | null;
    svg: SVGSVGElement | null;
  }) => void;
  onNavigate: (tabId: string, url: string, label: string) => void;
};

export const PORTS_VIEW_URL = "aiide://ports";

/** Inline-SVG `cursor: url(...)` data URIs. Hotspot follows after the URL. */
const MARKER_CURSOR =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32' fill='none'><path d='M22 4l5 5-13 13-5 1 1-5 12-14z' stroke='black' stroke-width='2' stroke-linejoin='round' fill='%23fff7c8'/><path d='M18 8l5 5' stroke='black' stroke-width='2' stroke-linecap='round'/><path d='M6 28h7' stroke='black' stroke-width='2.4' stroke-linecap='round'/></svg>\") 3 29, crosshair";

const ARROW_CURSOR =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28' fill='none'><path d='M4 3l18 10-8 2-3 9z' fill='black' stroke='white' stroke-width='1.6' stroke-linejoin='round'/></svg>\") 4 3, default";

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
  snapshot,
  onElementsReady,
  onNavigate,
}: PreviewPaneProps) {
  const tabCtx = useWorkspaceTab();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const drawingsSvgRef = useRef<SVGSVGElement>(null);
  const hiddenStyle = isActive ? undefined : { display: "none" as const };

  // Report element refs whenever they're attached. Plain effect on every
  // render keeps the parent's map in sync — the workspace shell reads
  // these at capture / composite time. tabId / url change re-runs to
  // catch the iframe re-creation on URL switch.
  useEffect(() => {
    onElementsReady?.({
      iframe: iframeRef.current,
      svg: drawingsSvgRef.current,
    });
  });

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

  // Layered above the iframe (low → high z-index):
  //   1. <iframe> — the live preview (or hidden behind snapshot)
  //   2. <img snapshot> — frozen pixels when snapshot mode is active
  //   3. <svg DrawingsLayer> — finalized drawings
  //   4. drawing surface — when marker tool is active
  //   5. cursor overlay — when select tool is active
  return (
    <div className="preview-frame" style={hiddenStyle}>
      <div className="preview-content">
        <iframe
          className="preview-iframe"
          src={url}
          title="Preview"
          loading="lazy"
          ref={iframeRef}
          // While a snapshot is being annotated, keep the iframe in the
          // DOM (so unmounting doesn't lose its state) but invisible
          // behind the static image.
          style={snapshot ? { visibility: "hidden" } : undefined}
        />

        {snapshot && (
          <img
            className="preview-snapshot"
            src={snapshot}
            alt="Preview snapshot"
            draggable={false}
          />
        )}

        <DrawingsLayer
          drawings={drawings ?? []}
          interactive={overlayTool !== "pointer"}
          onRemove={onRemoveDrawing}
          svgRef={drawingsSvgRef}
        />

        {overlayTool === "pointer" && (
          <DrawingSurface onCommit={(points) => onAddDrawing?.(points)} />
        )}

        {overlayTool === "select" && (
          <div
            className="preview-cursor-overlay"
            style={{ cursor: ARROW_CURSOR }}
            aria-hidden
          />
        )}
      </div>
    </div>
  );
}

/* ============================================================
   Drawings layer
   ============================================================ */

function DrawingsLayer({
  drawings,
  interactive,
  onRemove,
  svgRef,
}: {
  drawings: Drawing[];
  /** When false, the layer is purely visual — the marker drawing surface
   *  above swallows pointer events while the user is in draw mode. */
  interactive: boolean;
  onRemove?: (id: string) => void;
  svgRef?: React.Ref<SVGSVGElement>;
}) {
  return (
    <svg
      ref={svgRef}
      className="preview-drawings"
      // Transparent to pointer events at the root; individual polylines
      // and the X-delete circle opt back in. Keeps iframe interaction
      // intact in empty SVG areas.
      style={{ pointerEvents: "none" }}
    >
      {drawings.map((d) => (
        <DrawingShape
          key={d.id}
          drawing={d}
          interactive={interactive}
          onRemove={() => onRemove?.(d.id)}
        />
      ))}
    </svg>
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

  const pointsStr = drawing.points.map((p) => `${p.x},${p.y}`).join(" ");
  let minX = Infinity, maxX = -Infinity, minY = Infinity;
  for (const p of drawing.points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
  }
  // X sits right at the bounding box's top-right corner so it reads as
  // attached to the shape rather than floating off to the side.
  const xCenter = maxX;
  const yCenter = Math.max(minY, 10);

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
      {interactive && hover && (
        <g
          transform={`translate(${xCenter}, ${yCenter})`}
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
      )}
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
  const [livePoints, setLivePoints] = useState<DrawingPoint[]>([]);
  const drawingRef = useRef(false);

  const getPoint = (e: React.PointerEvent<HTMLDivElement>): DrawingPoint => {
    const rect = ref.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    setLivePoints([getPoint(e)]);
  };

  const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawingRef.current) return;
    const p = getPoint(e);
    setLivePoints((prev) => {
      const last = prev[prev.length - 1];
      if (last && Math.abs(last.x - p.x) < 1 && Math.abs(last.y - p.y) < 1) {
        return prev;
      }
      return [...prev, p];
    });
  };

  const finish = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    if (livePoints.length > 1) {
      onCommit(livePoints);
    }
    setLivePoints([]);
  };

  const livePointsStr = livePoints.map((p) => `${p.x},${p.y}`).join(" ");

  return (
    <div
      ref={ref}
      className="preview-drawing-surface"
      style={{ cursor: MARKER_CURSOR }}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      {livePoints.length > 1 && (
        <svg className="preview-drawing-live">
          <polyline
            points={livePointsStr}
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

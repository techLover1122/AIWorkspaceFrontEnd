/**
 * Capture the rendered pixels of the active tab's content area as a PNG data
 * URL. Desktop-only: the main process calls `webContents.capturePage()` on
 * the tab's WebContentsView and returns the PNG. No "what to share" picker,
 * no devicePixelRatio cropping math, no permission prompt — the snapshot is
 * the view's exact on-screen pixel content at the moment of the call.
 *
 * Throws if called outside the Electron host (e.g. plain `npm run dev` in a
 * browser): the previous `getDisplayMedia` browser fallback has been removed
 * because the desktop app is now the only deployment target for the
 * annotation flow.
 */

import { getElectronTabs } from "./electronTabs";

type CaptureOptions = {
  /** The tab being captured. Passed to the main-process capture IPC so
   *  it can resolve the right WebContentsView. */
  tabId: string;
  /** The `.preview-content` placeholder div whose rect represents where the
   *  WebContentsView sits on screen. Kept on the options bag for parity with
   *  the legacy signature; not strictly needed by the Electron path. */
  contentEl: HTMLElement;
  onHideOverlays?: () => void;
  onShowOverlays?: () => void;
};

export async function captureTabSnapshot(opts: CaptureOptions): Promise<string> {
  const electron = getElectronTabs();
  if (!electron) {
    throw new Error(
      "captureTabSnapshot requires the Electron host — no browser fallback."
    );
  }
  // Briefly signal "capturing" so any DOM overlay (e.g. the floating toolbar)
  // can hide itself. The pixels actually come from the WebContentsView's own
  // raster — not the renderer's — so renderer overlays would never bake in,
  // but hiding keeps the visual handoff smooth.
  opts.onHideOverlays?.();
  try {
    const { dataUrl } = await electron.capture(opts.tabId);
    return dataUrl;
  } finally {
    opts.onShowOverlays?.();
  }
}

/**
 * Composite a snapshot data URL with an SVG `<svg>` element's rendered
 * drawings into a single PNG. Used by the "Send" action so the chat
 * attachment is one flat image containing both the background screenshot
 * and the user's annotations.
 *
 * Drawings are rasterised by serialising the SVG and drawing it on top.
 */
export async function compositeSnapshotWithSvg(
  snapshotDataUrl: string,
  svgEl: SVGSVGElement | null,
  cssWidth: number,
  cssHeight: number
): Promise<Blob> {
  // Load the snapshot image first so we know its real pixel dimensions.
  const snapshot = await loadImage(snapshotDataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = snapshot.naturalWidth;
  canvas.height = snapshot.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D context available for compositing");
  ctx.drawImage(snapshot, 0, 0);

  if (svgEl) {
    // The SVG was rendered at CSS-pixel dimensions matching the iframe;
    // the snapshot is at device-pixel dimensions. Scale the SVG up to
    // match the snapshot's resolution.
    const scaleX = canvas.width / cssWidth;
    const scaleY = canvas.height / cssHeight;

    // Clone + set explicit width/height/viewBox on the SVG so the data
    // URL renders at the right size when consumed as an <img>.
    const clone = svgEl.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(cssWidth));
    clone.setAttribute("height", String(cssHeight));
    if (!clone.getAttribute("viewBox")) {
      clone.setAttribute("viewBox", `0 0 ${cssWidth} ${cssHeight}`);
    }

    const svgText = new XMLSerializer().serializeToString(clone);
    const svgUrl =
      "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
    const svgImg = await loadImage(svgUrl);

    ctx.drawImage(
      svgImg,
      0, 0, cssWidth, cssHeight,
      0, 0, cssWidth * scaleX, cssHeight * scaleY
    );
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob returned null"))),
      "image/png"
    );
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image ${src.slice(0, 100)}`));
    img.src = src;
  });
}

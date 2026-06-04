/**
 * Capture the rendered pixels of the active tab's content area as a PNG data
 * URL. Two implementations, picked at call time:
 *
 *   1. Electron mode (`__AIIDE__.tab` exists) — the main process calls
 *      `webContents.capturePage()` on the tab's WebContentsView. No user
 *      permission prompt, no devicePixelRatio cropping math, no "what to
 *      share" picker. The returned PNG is exactly the view's pixel content.
 *
 *   2. Browser fallback (`navigator.mediaDevices.getDisplayMedia`) — the
 *      legacy path for `npm run dev` outside Electron. Caveats:
 *        - Browser shows a "what to share" picker; with `preferCurrentTab`
 *          on Chrome 102+ it's one click.
 *        - We must hide our own overlays (toolbar, etc.) before capture or
 *          they'll bake into the snapshot. The `onHideOverlays` /
 *          `onShowOverlays` callbacks bracket the grab.
 *        - Captured stream is in device pixels; bounding rect is CSS
 *          pixels. We multiply by devicePixelRatio when cropping.
 *        - The user may share a different surface (e.g. whole screen). We
 *          can't reliably tell — we crop to the iframe's viewport rect,
 *          which is correct when sharing the current tab and unhelpful
 *          otherwise. Mitigation: `preferCurrentTab`, accept the rest.
 */

import { getElectronTabs } from "./electronTabs";

type CaptureOptions = {
  /** The tab being captured. Only used in Electron mode (passed to the
   *  main-process capture IPC). */
  tabId: string;
  /** The DOM element whose rect represents where the tab content sits on
   *  screen. In the browser fallback this is the iframe; in Electron mode
   *  it's the `.preview-content` placeholder div. Both have the same rect. */
  contentEl: HTMLElement;
  onHideOverlays?: () => void;
  onShowOverlays?: () => void;
};

export async function captureTabSnapshot(opts: CaptureOptions): Promise<string> {
  const electron = getElectronTabs();
  if (electron) {
    // Electron mode is fundamentally different — no surface picker, no DPR
    // math. Briefly hide overlays so any composited DOM overlay (e.g. the
    // toolbar) doesn't end up double-rendered on screen during the capture
    // animation. The capture itself is pixels from the WebContentsView's
    // own raster, not the renderer's, so technically overlays would never
    // be in it — but hiding keeps the visual handoff smooth.
    opts.onHideOverlays?.();
    try {
      const { dataUrl } = await electron.capture(opts.tabId);
      return dataUrl;
    } finally {
      opts.onShowOverlays?.();
    }
  }
  return captureViaDisplayMedia(opts);
}

async function captureViaDisplayMedia({
  contentEl,
  onHideOverlays,
  onShowOverlays,
}: CaptureOptions): Promise<string> {
  const iframe = contentEl;
  // 1. Request the user's screen / window / tab. preferCurrentTab is a
  //    Chrome extension that auto-selects this tab when the user has
  //    previously granted permission for it.
  //
  //    `cursor: "never"` is what actually keeps the OS cursor out of the
  //    captured pixels — without it, the mouse pointer bakes into the
  //    snapshot. Chrome honors it since ~v92; other browsers ignore
  //    unknown constraints.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      // hint at "browser tab" so the picker emphasises that option
      // @ts-ignore — displaySurface is in the spec but not in all TS libs
      displaySurface: "browser",
      // @ts-ignore — strip the OS cursor from the captured frames
      cursor: "never",
    },
    audio: false,
    // @ts-ignore — Chrome-only constraint
    preferCurrentTab: true,
    // @ts-ignore — also Chrome-only, biases the picker further
    selfBrowserSurface: "include",
    // @ts-ignore — Chrome-only, locks the surface picker after the first
    // grant so the user can't accidentally switch mid-flow.
    surfaceSwitching: "exclude",
  });

  // 2. Hide our overlays (toolbar) so they don't appear in the screenshot.
  //    Wait two animation frames so the browser has actually repainted.
  onHideOverlays?.();
  await nextPaint();
  await nextPaint();

  // 3. Pipe the stream into a video element so we can read a frame.
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;

  try {
    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => resolve();
      const onError = () => reject(new Error("Video element failed to load stream"));
      video.addEventListener("loadedmetadata", onLoaded, { once: true });
      video.addEventListener("error", onError, { once: true });
      void video.play().catch(reject);
    });

    // 4. Draw the current frame into a full-size canvas.
    const fullCanvas = document.createElement("canvas");
    fullCanvas.width = video.videoWidth;
    fullCanvas.height = video.videoHeight;
    const fullCtx = fullCanvas.getContext("2d");
    if (!fullCtx) throw new Error("Couldn't get 2D context for full canvas");
    fullCtx.drawImage(video, 0, 0);

    // 5. Crop to the iframe's viewport rectangle. Adjust for devicePixelRatio
    //    because the captured frame is in device pixels.
    const rect = iframe.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    const cropX = Math.max(0, Math.round(rect.left * dpr));
    const cropY = Math.max(0, Math.round(rect.top * dpr));
    const cropW = Math.min(
      fullCanvas.width - cropX,
      Math.round(rect.width * dpr)
    );
    const cropH = Math.min(
      fullCanvas.height - cropY,
      Math.round(rect.height * dpr)
    );

    if (cropW <= 0 || cropH <= 0) {
      throw new Error(
        "Iframe rect is outside the captured surface. Did you share the wrong window/tab?"
      );
    }

    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = cropW;
    cropCanvas.height = cropH;
    const cropCtx = cropCanvas.getContext("2d");
    if (!cropCtx) throw new Error("Couldn't get 2D context for crop canvas");
    cropCtx.drawImage(
      fullCanvas,
      cropX, cropY, cropW, cropH,
      0, 0, cropW, cropH
    );

    return cropCanvas.toDataURL("image/png");
  } finally {
    // 6. Always stop the stream so the browser drops its "is being shared"
    //    indicator, and restore overlays in case caller forgot.
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    }
    video.srcObject = null;
    onShowOverlays?.();
  }
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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

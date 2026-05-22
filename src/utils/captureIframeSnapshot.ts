/**
 * Capture the rendered pixels of an iframe element via the browser's screen
 * capture API (`getDisplayMedia`). Bypasses the cross-origin DOM access
 * restrictions entirely — we're reading what the user already sees, not
 * peering into the iframe's document.
 *
 * Caveats baked in:
 *   - Browser shows a "what to share" picker. With `preferCurrentTab: true`
 *     on Chrome 102+ this is one click; on Firefox/Safari it's a normal
 *     source picker. Either way the user has to grant once per call.
 *   - We must hide our own overlays (toolbar, etc.) before capture or
 *     they'll bake into the snapshot. The `onHideOverlays` callback fires
 *     just before grabbing the frame; `onShowOverlays` fires after.
 *   - The captured stream is in device pixels. iframe.getBoundingClientRect
 *     is in CSS pixels. We multiply by devicePixelRatio when cropping.
 *   - The user may share a different surface than the current tab (e.g. a
 *     window or whole screen). We can't reliably tell — we just crop to the
 *     iframe's viewport rect, which is correct when sharing the current tab
 *     and unhelpful when sharing something else. Mitigation: provide
 *     `preferCurrentTab` and accept the rest as user error.
 */

type CaptureOptions = {
  iframe: HTMLIFrameElement;
  onHideOverlays?: () => void;
  onShowOverlays?: () => void;
};

export async function captureIframeSnapshot({
  iframe,
  onHideOverlays,
  onShowOverlays,
}: CaptureOptions): Promise<string> {
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

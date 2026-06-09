/**
 * Typed accessor for the Electron preload's visual-edit API
 * (`__AIIDE__.visualEdit`). Returns `null` outside Electron (plain browser
 * during `npm run dev`), so call-sites hide the tool when it's unavailable.
 *
 * The shape mirrors desktop `preload.js`'s `__AIIDE__.visualEdit` exactly;
 * keep in sync. The IPC contract is documented in
 * `ai-workspace-desktopapp/visual-edit/manifest.json`.
 */

/** Real CSS property names → resolved computed values, captured at pick. */
export type ComputedStyles = Record<string, string>;

export type PinFingerprint = {
  tag: string;
  text: string;
  path: string;
  loc: string | null;
};

export type PinAnnotation = {
  /** Real CSS props, e.g. boxShadow, gridTemplateColumns → { from, to }. */
  css: Record<string, { from: string; to: string }>;
  text?: { from: string; to: string };
  note?: string;
};

export type Pin = {
  n: number;
  fingerprint: PinFingerprint;
  computed: ComputedStyles;
  /** Full current textContent of the element, captured at pick. */
  text?: string;
  /** True when the element is a leaf (no child elements) — safe to edit its
   *  textContent without clobbering children. Drives the Content field. */
  textEditable?: boolean;
  annotation: PinAnnotation;
  detached: boolean;
};

/** One edit applied through applyEdit — already composed to real CSS. */
export type EditChange =
  | { kind: "css"; prop: string; value: string; from: string }
  | { kind: "text"; value: string; from: string };

export type EditTask = {
  sessionId: string;
  tabId: string;
  url: string;
  targetScreenshot: string | null; // data:image/png;base64,…
  annotations: Pin[];
};

export type ElectronVisualEdit = {
  start: (tabId: string) => Promise<{ sessionId: string; pins: Pin[]; error?: string }>;
  listPins: (sessionId: string) => Promise<{ pins: Pin[]; error?: string }>;
  applyEdit: (
    sessionId: string,
    n: number,
    change: EditChange
  ) => Promise<{ ok?: boolean; annotation?: PinAnnotation; error?: string }>;
  setNote: (sessionId: string, n: number, note: string) => Promise<{ ok?: boolean; error?: string }>;
  removePin: (sessionId: string, n: number) => Promise<{ ok?: boolean; pins?: Pin[]; error?: string }>;
  pausePicking: (sessionId: string) => Promise<unknown>;
  resumePicking: (sessionId: string) => Promise<unknown>;
  buildEditTask: (sessionId: string) => Promise<EditTask & { error?: string }>;
  end: (sessionId: string) => Promise<{ ok?: boolean }>;

  onPinAdded: (cb: (e: { sessionId: string; pin: Pin }) => void) => () => void;
  onPinSelected: (cb: (e: { sessionId: string; n: number }) => void) => () => void;
  onPinDetached: (cb: (e: { sessionId: string; n: number; detached: boolean }) => void) => () => void;
  onRenumbered: (cb: (e: { sessionId: string; pins: Pin[] }) => void) => () => void;
  onReset: (cb: (e: { sessionId: string }) => void) => () => void;
};

export function getElectronVisualEdit(): ElectronVisualEdit | null {
  if (typeof window === "undefined") return null;
  return (
    (window.__AIIDE__ as { visualEdit?: ElectronVisualEdit } | undefined)?.visualEdit ?? null
  );
}

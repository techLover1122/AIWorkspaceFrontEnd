// Type declarations for the Electron desktop context.
// Populated by desktop/preload.js via Electron's contextBridge before any
// page script runs. Absent in the browser (window.__AIIDE__ is undefined).

interface Window {
  __AIIDE__?: {
    readonly isElectron: boolean;
    readonly electronVersion: string;
  };
}

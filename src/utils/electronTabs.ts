/**
 * Typed accessor for the Electron preload's tab API (`__AIIDE__.tab`).
 *
 * Returns `null` when running outside Electron (regular browser during
 * `npm run dev`), so call-sites can branch on it to fall back to the legacy
 * `<iframe>` rendering path.
 *
 * The shape mirrors `preload.js`'s `__AIIDE__.tab` exactly; keep it in sync.
 */

export type TabRect = { x: number; y: number; width: number; height: number };

export type ElectronTabs = {
  open: (tabId: string, url: string) => Promise<void>;
  close: (tabId: string) => Promise<void>;
  navigate: (tabId: string, url: string) => Promise<void>;
  reload: (tabId: string) => Promise<void>;
  setVisible: (tabId: string, visible: boolean) => Promise<void>;
  setBounds: (tabId: string, rect: TabRect) => Promise<void>;
  capture: (
    tabId: string
  ) => Promise<{ dataUrl: string; width: number; height: number }>;
  setActive: (tabId: string | null) => Promise<void>;
  list: () => Promise<{
    tabs: Array<{ tabId: string; url: string; visible: boolean; bounds: TabRect | null }>;
    activeTabId: string | null;
  }>;
  onLoadingChange: (cb: (tabId: string, loading: boolean) => void) => () => void;
  onTitleChange: (cb: (tabId: string, title: string) => void) => () => void;
  onUrlChange: (cb: (tabId: string, url: string) => void) => () => void;
};

type AIIDEGlobal = {
  readonly isElectron?: boolean;
  readonly electronVersion?: string;
  tab?: ElectronTabs;
  onOpenTab?: (cb: (url: string, label: string) => void) => () => void;
  tunnel?: import("./electronTunnel").ElectronTunnel;
};

declare global {
  interface Window {
    __AIIDE__?: AIIDEGlobal;
  }
}

export function getElectronTabs(): ElectronTabs | null {
  if (typeof window === "undefined") return null;
  return window.__AIIDE__?.tab ?? null;
}

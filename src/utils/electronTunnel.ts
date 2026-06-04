/**
 * Typed accessor for the Electron preload's tunnel status surface
 * (`__AIIDE__.tunnel`). Returns `null` outside Electron — callers can branch
 * on it to hide the status indicator entirely in browser-only dev.
 *
 * Mirrors `preload.js`'s `__AIIDE__.tunnel` exactly; keep in sync.
 */

import { useEffect, useState } from "react";

export type TunnelStatusValue =
  | "idle"
  | "granting"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export type TunnelStatus = {
  status: TunnelStatusValue;
  error: string | null;
  connectedAt: string | null;
};

export type ElectronTunnel = {
  onStatus: (cb: (status: TunnelStatus) => void) => () => void;
};

// `Window.__AIIDE__` is declared in electronTabs.ts and includes our tunnel
// sub-shape via a type-only import. Don't re-declare it here — both files
// merging the same global interface would create a duplicate-property error.

export function getElectronTunnel(): ElectronTunnel | null {
  if (typeof window === "undefined") return null;
  return window.__AIIDE__?.tunnel ?? null;
}

/** Subscribes to status updates and re-renders. Returns null outside Electron. */
export function useTunnelStatus(): TunnelStatus | null {
  const [status, setStatus] = useState<TunnelStatus | null>(null);
  useEffect(() => {
    const tunnel = getElectronTunnel();
    if (!tunnel) return;
    return tunnel.onStatus(setStatus);
  }, []);
  return status;
}

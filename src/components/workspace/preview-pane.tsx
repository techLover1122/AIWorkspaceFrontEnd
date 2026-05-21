"use client";

import { NewTabPage } from "./new-tab-page";
import { PortsView } from "./PortsView";
import { useWorkspaceTab } from "../../contexts/WorkspaceTabContext";

type PreviewPaneProps = {
  tabId: string;
  url: string;
  codeServerUrl: string;
  isActive: boolean;
  onNavigate: (tabId: string, url: string, label: string) => void;
};

export const PORTS_VIEW_URL = "aiide://ports";

// Every tab renders simultaneously and is hidden via `display:none` when
// inactive — that keeps each iframe mounted across tab switches so its DOM,
// scroll position, and any in-page state survive instead of triggering a full
// reload every time the user comes back to the tab.
export function PreviewPane({ tabId, url, codeServerUrl, isActive, onNavigate }: PreviewPaneProps) {
  const tabCtx = useWorkspaceTab();
  const hiddenStyle = isActive ? undefined : { display: "none" as const };

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

  return (
    <div className="preview-frame" style={hiddenStyle}>
      <div className="preview-content">
        <iframe
          className="preview-iframe"
          src={url}
          title="Preview"
          loading="lazy"
        />
      </div>
    </div>
  );
}

"use client";

import { NewTabPage } from "./new-tab-page";
import { PortsView } from "./PortsView";
import { useWorkspaceTab } from "../../contexts/WorkspaceTabContext";

type PreviewPaneProps = {
  tabId: string;
  url: string;
  codeServerUrl: string;
  onNavigate: (tabId: string, url: string, label: string) => void;
};

export const PORTS_VIEW_URL = "aiide://ports";

export function PreviewPane({ tabId, url, codeServerUrl, onNavigate }: PreviewPaneProps) {
  const tabCtx = useWorkspaceTab();

  if (!url) {
    return (
      <div className="preview-frame">
        <NewTabPage
          codeServerUrl={codeServerUrl}
          onNavigate={(u, label) => onNavigate(tabId, u, label)}
        />
      </div>
    );
  }

  if (url === PORTS_VIEW_URL) {
    return (
      <div className="preview-frame">
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
    <div className="preview-frame">
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

"use client";

import { NewTabPage } from "./new-tab-page";

type PreviewPaneProps = {
  tabId: string;
  url: string;
  codeServerUrl: string;
  onNavigate: (tabId: string, url: string, label: string) => void;
};

export function PreviewPane({ tabId, url, codeServerUrl, onNavigate }: PreviewPaneProps) {
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

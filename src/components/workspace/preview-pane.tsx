"use client";

type PreviewPaneProps = {
  codeServerUrl: string;
};

export function PreviewPane({ codeServerUrl }: PreviewPaneProps) {
  return (
    <div className="preview-frame">
      <div className="preview-content">
        <iframe
          className="preview-iframe"
          src={codeServerUrl}
          title="Code Server"
          loading="lazy"
        />
      </div>
    </div>
  );
}

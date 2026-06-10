"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  buildZipFromDrop,
  buildZipFromFolderInput,
  type BuiltZip,
} from "../../utils/projectUpload";
import {
  uploadProjectUrl,
  runProjectUrl,
  runProjectStreamUrl,
} from "../../constant/api";

/**
 * Local project upload + auto-run UI.
 *
 * Two entry points share one pipeline (build zip → upload → run → stream):
 *   • toolbar button → opens the chooser (folder / .zip)
 *   • global drag-drop → `handleDrop(dataTransfer)` via the imperative ref
 *
 * On a successful upload we switch the workspace working directory to the
 * extracted project, then kick off the run; the backend auto-opens a preview
 * tab when the dev server prints a localhost URL.
 */

export type ProjectUploadHandle = {
  /** Open the chooser modal (folder / zip buttons). */
  openChooser: () => void;
  /** Start the pipeline from a drag-and-drop DataTransfer. */
  handleDrop: (dataTransfer: DataTransfer) => void;
  /** Re-open the modal without resetting state (use while a run is in progress). */
  reopen: () => void;
  /** Clear a finished/errored run from the toolbar widget. */
  dismiss: () => void;
};

export type UploadStatus = {
  phase: Phase;
  progress: number;
  projectName: string;
  previewUrl: string | null;
  error: string | null;
};

type ProjectUploadProps = {
  /** Current IDE working directory; uploads extract into a subfolder here. */
  workingDirectory?: string;
  onChangeProject?: (path: string) => void;
  /** Fires whenever the upload/run phase changes — drives the toolbar widget. */
  onStatusChange?: (status: UploadStatus) => void;
  /** Called when the modal becomes visible — used to hide WebContentsView tabs
   *  in Electron so the modal isn't obscured by the compositor. */
  onModalOpen?: () => void;
  /** Called when the modal is hidden — restores tab visibility. */
  onModalClose?: () => void;
  /** Called when the user clicks "Open Preview" after a successful run. */
  onOpenPreview?: (url: string) => void;
};

type Phase = "idle" | "zipping" | "uploading" | "running" | "done" | "error";

type LogLine = { id: number; text: string; kind: "log" | "info" | "error" };

export const ProjectUpload = forwardRef<ProjectUploadHandle, ProjectUploadProps>(
  function ProjectUpload({ workingDirectory, onChangeProject, onStatusChange, onModalOpen, onModalClose, onOpenPreview }, ref) {
    const [open, setOpen] = useState(false);
    const [phase, setPhase] = useState<Phase>("idle");
    const [progress, setProgress] = useState(0);
    const [projectName, setProjectName] = useState<string>("");
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [logs, setLogs] = useState<LogLine[]>([]);
    const [error, setError] = useState<string | null>(null);

    const folderInputRef = useRef<HTMLInputElement>(null);
    const zipInputRef = useRef<HTMLInputElement>(null);
    const esRef = useRef<EventSource | null>(null);
    const logIdRef = useRef(0);
    const logBodyRef = useRef<HTMLDivElement>(null);

    const pushLog = useCallback((text: string, kind: LogLine["kind"] = "log") => {
      setLogs((prev) => {
        const next = [...prev, { id: logIdRef.current++, text, kind }];
        // Cap the rendered log to keep the DOM light.
        return next.length > 600 ? next.slice(next.length - 600) : next;
      });
    }, []);

    // Auto-scroll the log to the bottom as lines arrive.
    useEffect(() => {
      const el = logBodyRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, [logs]);

    // Mirror state up to the toolbar widget.
    useEffect(() => {
      onStatusChange?.({ phase, progress, projectName, previewUrl, error });
    }, [phase, progress, projectName, previewUrl, error, onStatusChange]);

    // Hide the active Electron WebContentsView tab when the modal opens so it
    // doesn't composite over the modal (WebContentsView renders above HTML at
    // the OS compositor level). Restore when closed.
    useEffect(() => {
      if (open) {
        onModalOpen?.();
      } else {
        onModalClose?.();
      }
    // onModalOpen/onModalClose are stable callbacks — only re-run when open changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const closeStream = useCallback(() => {
      esRef.current?.close();
      esRef.current = null;
    }, []);

    const reset = useCallback(() => {
      closeStream();
      setPhase("idle");
      setProgress(0);
      setProjectName("");
      setPreviewUrl(null);
      setLogs([]);
      setError(null);
    }, [closeStream]);

    const closeModal = useCallback(() => {
      setOpen(false);
      // Leave a finished run's logs intact until the next open; only a fresh
      // start clears them (reset runs at the top of runPipeline).
      if (phase === "running" || phase === "uploading" || phase === "zipping") return;
      closeStream();
    }, [phase, closeStream]);

    const startRunStream = useCallback(
      (runId: string) => {
        const es = new EventSource(runProjectStreamUrl(runId));
        esRef.current = es;
        es.onmessage = (ev) => {
          try {
            const e = JSON.parse(ev.data) as {
              phase: string;
              data?: string;
              url?: string;
              port?: number;
              code?: number | null;
            };
            switch (e.phase) {
              case "detected":
                pushLog(`Detected project type: ${e.data}`, "info");
                break;
              case "installing":
                pushLog(`Installing dependencies → ${e.data}`, "info");
                break;
              case "starting":
                pushLog(`Starting → ${e.data}`, "info");
                break;
              case "port":
                pushLog(`Preview ready at ${e.url} — opening tab…`, "info");
                if (e.url) setPreviewUrl(e.url);
                break;
              case "log":
                if (e.data) pushLog(e.data, "log");
                break;
              case "error":
                pushLog(e.data ?? "Error", "error");
                setError(e.data ?? "Run error");
                break;
              case "exit":
                pushLog(`Process exited (code ${e.code ?? "?"}).`, "info");
                setPhase((p) => (p === "error" ? p : "done"));
                closeStream();
                break;
            }
          } catch {
            /* ignore malformed frame */
          }
        };
        es.onerror = () => {
          // The stream closes itself on exit; an error here usually means the
          // run already finished. Don't surface it as a hard failure.
          closeStream();
        };
      },
      [pushLog, closeStream]
    );

    const runPipeline = useCallback(
      async (built: BuiltZip | null) => {
        if (!built) {
          setOpen(true);
          setPhase("error");
          setError("Nothing to upload — the drop was empty or all files were ignored.");
          return;
        }

        reset();
        setOpen(true);
        setProjectName(built.suggestedName);

        try {
          // 1) Upload the zip bytes.
          setPhase("uploading");
          setProgress(0);
          const res = await fetch(uploadProjectUrl(built.suggestedName, workingDirectory), {
            method: "POST",
            headers: { "Content-Type": "application/zip" },
            body: built.zipBlob,
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new Error(body?.error ?? `Upload failed (HTTP ${res.status})`);
          }
          const uploaded = (await res.json()) as { ok: boolean; projectPath: string; name: string };
          if (!uploaded.ok || !uploaded.projectPath) throw new Error("Upload rejected by server");

          setProjectName(uploaded.name);
          pushLog(`Uploaded → ${uploaded.projectPath}`, "info");
          // Note: we intentionally do NOT call onChangeProject here — uploading a
          // project should not re-root the workspace. The new folder appears in
          // the current working directory without navigating away.

          // 3) Kick off the run and stream its output.
          setPhase("running");
          const runRes = await fetch(runProjectUrl(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectPath: uploaded.projectPath }),
          });
          if (!runRes.ok) {
            const body = (await runRes.json().catch(() => null)) as { error?: string } | null;
            throw new Error(body?.error ?? `Run failed to start (HTTP ${runRes.status})`);
          }
          const runData = (await runRes.json()) as { ok: boolean; runId: string };
          if (!runData.ok || !runData.runId) throw new Error("Run rejected by server");
          startRunStream(runData.runId);
        } catch (err) {
          setPhase("error");
          setError((err as Error).message);
          pushLog((err as Error).message, "error");
        }
      },
      [reset, onChangeProject, pushLog, startRunStream]
    );

    const startFromBuilder = useCallback(
      async (build: () => Promise<BuiltZip | null>) => {
        reset();
        setOpen(true);
        setPhase("zipping");
        setProgress(0);
        try {
          const built = await build();
          await runPipeline(built);
        } catch (err) {
          setPhase("error");
          setError((err as Error).message);
        }
      },
      [reset, runPipeline]
    );

    useImperativeHandle(
      ref,
      () => ({
        openChooser: () => {
          if (phase === "zipping" || phase === "uploading" || phase === "running") {
            setOpen(true);
            return;
          }
          reset();
          setOpen(true);
        },
        handleDrop: (dataTransfer: DataTransfer) => {
          void startFromBuilder(() =>
            buildZipFromDrop(dataTransfer, (pct) => setProgress(pct))
          );
        },
        reopen: () => setOpen(true),
        dismiss: () => reset(),
      }),
      [phase, reset, startFromBuilder]
    );

    const onFolderPicked = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (files && files.length > 0) {
          void startFromBuilder(() => buildZipFromFolderInput(files, (pct) => setProgress(pct)));
        }
        e.target.value = "";
      },
      [startFromBuilder]
    );

    const onZipPicked = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
          void startFromBuilder(async () => ({
            zipBlob: file,
            suggestedName: file.name.replace(/\.zip$/i, "") || "project",
            fileCount: 0,
            passthrough: true,
          }));
        }
        e.target.value = "";
      },
      [startFromBuilder]
    );

    const busy = phase === "zipping" || phase === "uploading" || phase === "running";

    return (
      <>
        {/* Hidden pickers */}
        <input
          ref={folderInputRef}
          type="file"
          // @ts-expect-error — non-standard but widely supported folder picker attrs
          webkitdirectory=""
          directory=""
          multiple
          hidden
          onChange={onFolderPicked}
        />
        <input
          ref={zipInputRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={onZipPicked}
        />

        {open && (
          <div className="project-upload-backdrop" onClick={closeModal}>
            <div
              className="project-upload-modal"
              role="dialog"
              aria-label="Upload project"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="project-upload-head">
                <span className="project-upload-title">
                  {phase === "idle"
                    ? "Upload a project"
                    : projectName
                    ? `Project: ${projectName}`
                    : "Upload a project"}
                </span>
                <div className="project-upload-head-actions">
                  {/* Minimize — hides the modal but keeps the run going; the
                      toolbar widget stays live and shows progress. */}
                  {busy && (
                    <button
                      type="button"
                      className="project-upload-close"
                      onClick={() => setOpen(false)}
                      aria-label="Minimize to toolbar"
                      title="Minimize to toolbar — run continues in the background"
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
                        <path d="M3 8h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                  <button
                    type="button"
                    className="project-upload-close"
                    onClick={closeModal}
                    aria-label="Close"
                    title="Close"
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
                      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              </div>

              {phase === "idle" && (
                <div className="project-upload-chooser">
                  <p className="project-upload-hint">
                    Drag &amp; drop a folder or a <code>.zip</code> anywhere, or choose below.
                    Heavy folders (node_modules, .git…) are skipped automatically.
                  </p>
                  <div className="project-upload-actions">
                    <button
                      type="button"
                      className="project-upload-btn primary"
                      onClick={() => folderInputRef.current?.click()}
                    >
                      Choose folder
                    </button>
                    <button
                      type="button"
                      className="project-upload-btn"
                      onClick={() => zipInputRef.current?.click()}
                    >
                      Choose .zip
                    </button>
                  </div>
                </div>
              )}

              {phase !== "idle" && (
                <div className="project-upload-progress-wrap">
                  <div className="project-upload-steps">
                    <Step label="Package" active={phase === "zipping"} done={phaseRank(phase) > 1} />
                    <Step label="Upload" active={phase === "uploading"} done={phaseRank(phase) > 2} />
                    <Step
                      label="Run"
                      active={phase === "running"}
                      done={phase === "done"}
                      failed={phase === "error"}
                    />
                  </div>

                  {(phase === "zipping" || phase === "uploading") && (
                    <div className="project-upload-bar">
                      <div
                        className="project-upload-bar-fill"
                        style={{ width: `${phase === "uploading" ? 100 : progress}%` }}
                      />
                    </div>
                  )}

                  {error && <div className="project-upload-error">{error}</div>}

                  {logs.length > 0 && (
                    <div className="project-upload-log" ref={logBodyRef}>
                      {logs.map((l) => (
                        <div key={l.id} className={`project-upload-log-line ${l.kind}`}>
                          {l.text}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="project-upload-foot">
                    {busy ? (
                      <span className="project-upload-busy">
                        {phase === "zipping"
                          ? `Packaging… ${progress}%`
                          : phase === "uploading"
                          ? "Uploading…"
                          : "Running… (minimize to keep working)"}
                      </span>
                    ) : phase === "done" && previewUrl ? (
                      <div className="project-upload-foot-row">
                        <button
                          type="button"
                          className="project-upload-btn primary"
                          onClick={() => { onOpenPreview?.(previewUrl); setOpen(false); }}
                        >
                          ▶ Open Preview
                        </button>
                        <button type="button" className="project-upload-btn" onClick={() => reset()}>
                          Upload another
                        </button>
                      </div>
                    ) : phase === "done" ? (
                      <div className="project-upload-foot-row">
                        <span className="project-upload-busy">Done — no preview URL detected</span>
                        <button type="button" className="project-upload-btn" onClick={() => reset()}>
                          Upload another
                        </button>
                      </div>
                    ) : (
                      <button type="button" className="project-upload-btn" onClick={() => reset()}>
                        Upload another
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </>
    );
  }
);

function phaseRank(phase: Phase): number {
  switch (phase) {
    case "idle":
      return 0;
    case "zipping":
      return 1;
    case "uploading":
      return 2;
    case "running":
      return 3;
    case "done":
    case "error":
      return 4;
  }
}

function Step({
  label,
  active,
  done,
  failed,
}: {
  label: string;
  active?: boolean;
  done?: boolean;
  failed?: boolean;
}) {
  const cls = ["project-upload-step", active ? "active" : "", done ? "done" : "", failed ? "failed" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls}>
      <span className="project-upload-step-dot" />
      <span className="project-upload-step-label">{label}</span>
    </div>
  );
}

/**
 * Full-workspace overlay shown while files are dragged over the window.
 * Purely presentational — the drop handling lives in workspace-shell so it can
 * gate on `dataTransfer.types` and avoid clashing with tab-reorder drags.
 */
export function ProjectDropOverlay() {
  return (
    <div className="project-drop-overlay" aria-hidden>
      <div className="project-drop-overlay-inner">
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" aria-hidden>
          <path
            d="M12 16V4M7 9l5-5 5 5M5 16v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>Drop a folder or .zip to upload &amp; run</span>
      </div>
    </div>
  );
}

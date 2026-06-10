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
  collectFromDataTransfer,
  collectFromFileList,
  type FileEntry,
} from "../../utils/projectUpload";
import { uploadFilesUrl } from "../../constant/api";

/**
 * Upload panel — drops or picker → files land in workingDirectory with their
 * original folder structure intact. No zipping, no running, no project
 * detection. Just bytes → disk.
 *
 * Two entry points:
 *   • toolbar button  → openChooser()
 *   • global drag-drop → handleDrop(dataTransfer) via the imperative ref
 */

export type ProjectUploadHandle = {
  openChooser: () => void;
  handleDrop: (dataTransfer: DataTransfer) => void;
  reopen: () => void;
  dismiss: () => void;
};

export type UploadStatus = {
  phase: "idle" | "uploading" | "done" | "error";
  /** 0–100 upload progress (byte-level via XHR). */
  progress: number;
  fileCount: number;
  error: string | null;
};

type ProjectUploadProps = {
  workingDirectory?: string;
  onStatusChange?: (s: UploadStatus) => void;
  /** Hide active Electron WebContentsView so the modal isn't occluded. */
  onModalOpen?: () => void;
  onModalClose?: () => void;
};

/** Auto-close the success state after this many ms if user doesn't close it. */
const AUTO_CLOSE_MS = 60_000;

export const ProjectUpload = forwardRef<ProjectUploadHandle, ProjectUploadProps>(
  function ProjectUpload({ workingDirectory, onStatusChange, onModalOpen, onModalClose }, ref) {
    const [open, setOpen] = useState(false);
    const [phase, setPhase] = useState<UploadStatus["phase"]>("idle");
    const [progress, setProgress] = useState(0);
    const [fileCount, setFileCount] = useState(0);
    const [doneCount, setDoneCount] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const folderInputRef = useRef<HTMLInputElement>(null);
    const filesInputRef = useRef<HTMLInputElement>(null);
    const xhrRef = useRef<XMLHttpRequest | null>(null);
    const autoCloseRef = useRef<number | null>(null);

    // ── helpers ──────────────────────────────────────────────────────────────

    const clearAutoClose = () => {
      if (autoCloseRef.current != null) {
        window.clearTimeout(autoCloseRef.current);
        autoCloseRef.current = null;
      }
    };

    const reset = useCallback(() => {
      clearAutoClose();
      xhrRef.current?.abort();
      xhrRef.current = null;
      setPhase("idle");
      setProgress(0);
      setFileCount(0);
      setDoneCount(0);
      setError(null);
    }, []);

    const closeModal = useCallback(() => {
      setOpen(false);
      if (phase !== "uploading") reset();
    }, [phase, reset]);

    // Mirror status to toolbar widget.
    useEffect(() => {
      onStatusChange?.({ phase, progress, fileCount, error });
    }, [phase, progress, fileCount, error, onStatusChange]);

    // Hide/restore Electron WebContentsView when modal opens/closes.
    useEffect(() => {
      if (open) onModalOpen?.();
      else onModalClose?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // ── upload pipeline ───────────────────────────────────────────────────────

    const runUpload = useCallback(
      (entries: FileEntry[]) => {
        if (!entries.length) return;

        reset();
        setOpen(true);
        setPhase("uploading");
        setFileCount(entries.length);
        setProgress(0);

        const fd = new FormData();
        // Send relative paths alongside the binary data so the backend can
        // reconstruct the directory tree.
        fd.append("paths", JSON.stringify(entries.map((e) => e.path)));
        entries.forEach((e, i) => fd.append(`file_${i}`, e.file));

        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;

        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) {
            setProgress(Math.round((ev.loaded / ev.total) * 100));
          }
        };

        xhr.onload = () => {
          xhrRef.current = null;
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const res = JSON.parse(xhr.responseText) as { ok: boolean; count?: number; error?: string };
              if (res.ok) {
                setDoneCount(res.count ?? entries.length);
                setProgress(100);
                setPhase("done");
                // Auto-close after 1 minute if the user hasn't dismissed yet.
                autoCloseRef.current = window.setTimeout(() => {
                  reset();
                  setOpen(false);
                }, AUTO_CLOSE_MS);
                return;
              }
              throw new Error(res.error ?? "Upload failed");
            } catch (e) {
              setPhase("error");
              setError((e as Error).message);
            }
          } else {
            setPhase("error");
            setError(`Upload failed (HTTP ${xhr.status})`);
          }
        };

        xhr.onerror = () => {
          xhrRef.current = null;
          setPhase("error");
          setError("Network error");
        };

        xhr.onabort = () => {
          xhrRef.current = null;
        };

        xhr.open("POST", uploadFilesUrl(workingDirectory));
        xhr.send(fd);
      },
      [reset, workingDirectory]
    );

    // ── pickers ───────────────────────────────────────────────────────────────

    const onFolderPicked = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const entries = collectFromFileList(e.target.files ?? []);
        if (entries.length) runUpload(entries);
        e.target.value = "";
      },
      [runUpload]
    );

    const onFilesPicked = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const entries = collectFromFileList(e.target.files ?? []);
        if (entries.length) runUpload(entries);
        e.target.value = "";
      },
      [runUpload]
    );

    // ── imperative handle ─────────────────────────────────────────────────────

    useImperativeHandle(
      ref,
      () => ({
        openChooser: () => {
          if (phase === "uploading") { setOpen(true); return; }
          reset();
          setOpen(true);
        },
        handleDrop: (dataTransfer: DataTransfer) => {
          // Collect entries synchronously, then kick off the async walk + upload.
          void collectFromDataTransfer(dataTransfer).then((entries) => {
            if (entries.length) runUpload(entries);
          });
        },
        reopen: () => setOpen(true),
        dismiss: () => { reset(); setOpen(false); },
      }),
      [phase, reset, runUpload]
    );

    // ── render ────────────────────────────────────────────────────────────────

    const busy = phase === "uploading";

    return (
      <>
        {/* Hidden pickers */}
        <input
          ref={folderInputRef}
          type="file"
          // @ts-expect-error — webkitdirectory is non-standard but widely supported
          webkitdirectory=""
          directory=""
          multiple
          hidden
          onChange={onFolderPicked}
        />
        <input
          ref={filesInputRef}
          type="file"
          multiple
          hidden
          onChange={onFilesPicked}
        />

        {open && (
          <div className="project-upload-backdrop" onClick={closeModal}>
            <div
              className="project-upload-modal"
              role="dialog"
              aria-label="Upload files"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="project-upload-head">
                <span className="project-upload-title">
                  {phase === "idle"
                    ? "Upload"
                    : phase === "uploading"
                    ? `Uploading ${fileCount} file${fileCount !== 1 ? "s" : ""}…`
                    : phase === "done"
                    ? `Done — ${doneCount} file${doneCount !== 1 ? "s" : ""} uploaded`
                    : "Upload failed"}
                </span>
                <div className="project-upload-head-actions">
                  {/* Minimize while uploading */}
                  {busy && (
                    <button
                      type="button"
                      className="project-upload-close"
                      onClick={() => setOpen(false)}
                      aria-label="Minimize"
                      title="Minimize — upload continues in the background"
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

              {/* Idle — chooser */}
              {phase === "idle" && (
                <div className="project-upload-chooser">
                  <p className="project-upload-hint">
                    Drag &amp; drop anywhere, or choose below. Folders are
                    uploaded with their structure intact.
                    Heavy dirs (node_modules, .git…) are skipped.
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
                      onClick={() => filesInputRef.current?.click()}
                    >
                      Choose files
                    </button>
                  </div>
                </div>
              )}

              {/* Uploading — progress bar */}
              {phase === "uploading" && (
                <div className="project-upload-progress-wrap">
                  <div className="project-upload-bar">
                    <div
                      className="project-upload-bar-fill"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <div className="project-upload-foot">
                    <span className="project-upload-busy">{progress}% — minimize to keep working</span>
                  </div>
                </div>
              )}

              {/* Done — green tick */}
              {phase === "done" && (
                <div className="project-upload-progress-wrap">
                  <div className="project-upload-done-icon" aria-hidden>
                    <svg viewBox="0 0 40 40" width="40" height="40" fill="none">
                      <circle cx="20" cy="20" r="18" stroke="#22c55e" strokeWidth="2.5" />
                      <path
                        d="M12 20l6 6 10-12"
                        stroke="#22c55e"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                  <p className="project-upload-done-msg">
                    Files saved to{" "}
                    <code>{workingDirectory ?? "workspace"}</code>.
                    Closing automatically in 1 min.
                  </p>
                  <div className="project-upload-foot">
                    <button
                      type="button"
                      className="project-upload-btn primary"
                      onClick={() => { clearAutoClose(); reset(); }}
                    >
                      Upload more
                    </button>
                    <button
                      type="button"
                      className="project-upload-btn"
                      onClick={() => { clearAutoClose(); reset(); setOpen(false); }}
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}

              {/* Error */}
              {phase === "error" && (
                <div className="project-upload-progress-wrap">
                  <div className="project-upload-error">{error}</div>
                  <div className="project-upload-foot">
                    <button type="button" className="project-upload-btn" onClick={reset}>
                      Try again
                    </button>
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

/**
 * Full-workspace overlay shown while files are dragged over the window.
 * Purely presentational — drop handling lives in workspace-shell.
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
        <span>Drop a folder or files to upload</span>
      </div>
    </div>
  );
}

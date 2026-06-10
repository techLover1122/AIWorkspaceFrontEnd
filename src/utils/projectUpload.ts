/**
 * Client-side project packaging.
 *
 * The backend runs remote, so we can't hand it a local path — we ship bytes.
 * To keep the server side to a single code path, the frontend ALWAYS produces
 * a zip:
 *   - a dropped `.zip`        → passed through unchanged
 *   - a dropped/picked folder → zipped here with JSZip
 *
 * Heavy / generated dirs (node_modules, .git, …) are skipped so the upload
 * stays small and reliable; the server reinstalls deps fresh.
 */
import JSZip from "jszip";

/** Directory names skipped at every level when zipping a folder. */
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".cache",
  "coverage",
  ".turbo",
  ".svelte-kit",
]);

const IGNORE_FILES = new Set([".DS_Store", "Thumbs.db"]);

export type BuiltZip = {
  /** The zip bytes to upload (a Blob/File). */
  zipBlob: Blob;
  /** Cleaned-up base name to suggest as the project name. */
  suggestedName: string;
  /** Number of files included (0 for a passthrough zip — unknown). */
  fileCount: number;
  /** True when the user dropped a ready-made .zip we passed through. */
  passthrough: boolean;
};

function isZipFile(file: File): boolean {
  return /\.zip$/i.test(file.name) || file.type === "application/zip" || file.type === "application/x-zip-compressed";
}

function shouldSkipPath(relPath: string): boolean {
  const segments = relPath.split("/");
  const fileName = segments[segments.length - 1];
  if (IGNORE_FILES.has(fileName)) return true;
  // Skip if any directory segment is in the ignore list.
  return segments.slice(0, -1).some((seg) => IGNORE_DIRS.has(seg));
}

/* ───────── FileSystemEntry helpers (drag-and-drop) ───────── */

type FsEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
};
type FsFileEntry = FsEntry & { file: (cb: (f: File) => void, err: (e: unknown) => void) => void };
type FsDirEntry = FsEntry & {
  createReader: () => { readEntries: (cb: (entries: FsEntry[]) => void, err: (e: unknown) => void) => void };
};

function readFile(entry: FsFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** readEntries returns at most ~100 entries per call — loop until empty. */
function readAllEntries(dir: FsDirEntry): Promise<FsEntry[]> {
  const reader = dir.createReader();
  const all: FsEntry[] = [];
  return new Promise((resolve, reject) => {
    const pump = () => {
      reader.readEntries((entries) => {
        if (entries.length === 0) {
          resolve(all);
          return;
        }
        all.push(...entries);
        pump();
      }, reject);
    };
    pump();
  });
}

/**
 * Recursively add a FileSystemEntry tree to the zip. `prefix` is the path
 * already consumed (relative to the zip root).
 */
async function addEntryToZip(zip: JSZip, entry: FsEntry, prefix: string): Promise<number> {
  if (IGNORE_DIRS.has(entry.name) && entry.isDirectory) return 0;
  const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

  if (entry.isFile) {
    if (shouldSkipPath(relPath)) return 0;
    const file = await readFile(entry as FsFileEntry);
    zip.file(relPath, file);
    return 1;
  }

  if (entry.isDirectory) {
    const children = await readAllEntries(entry as FsDirEntry);
    let count = 0;
    for (const child of children) {
      count += await addEntryToZip(zip, child, relPath);
    }
    return count;
  }
  return 0;
}

/* ───────── public API ───────── */

function cleanName(raw: string): string {
  return raw.replace(/\.zip$/i, "").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^[._]+/, "") || "project";
}

async function finalizeZip(zip: JSZip, name: string, count: number, onProgress?: (pct: number) => void): Promise<BuiltZip> {
  const blob = await zip.generateAsync(
    { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
    (meta) => onProgress?.(Math.round(meta.percent))
  );
  return { zipBlob: blob, suggestedName: cleanName(name), fileCount: count, passthrough: false };
}

/**
 * Build a zip from a drag-and-drop DataTransfer. Handles a single dropped
 * `.zip` (passthrough), one folder, or a mix of files/folders.
 * Returns null when the drop contained nothing usable.
 */
export async function buildZipFromDrop(
  dataTransfer: DataTransfer,
  onProgress?: (pct: number) => void
): Promise<BuiltZip | null> {
  const items = Array.from(dataTransfer.items).filter((i) => i.kind === "file");

  // Resolve entries up-front (webkitGetAsEntry must be called synchronously
  // during the drop event, before any await).
  const entries: FsEntry[] = [];
  const looseFiles: File[] = [];
  for (const item of items) {
    const getEntry = (item as unknown as { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry;
    const entry = getEntry ? getEntry.call(item) : null;
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) looseFiles.push(f);
    }
  }

  // Single dropped .zip → passthrough (no re-zipping).
  if (entries.length === 1 && entries[0].isFile) {
    const file = await readFile(entries[0] as FsFileEntry);
    if (isZipFile(file)) {
      return { zipBlob: file, suggestedName: cleanName(file.name), fileCount: 0, passthrough: true };
    }
  }
  if (entries.length === 0 && looseFiles.length === 1 && isZipFile(looseFiles[0])) {
    const f = looseFiles[0];
    return { zipBlob: f, suggestedName: cleanName(f.name), fileCount: 0, passthrough: true };
  }

  const zip = new JSZip();
  let count = 0;
  let rootName = "project";

  if (entries.length > 0) {
    // If a single top-level folder was dropped, zip its *contents* at the root
    // and name the project after it.
    if (entries.length === 1 && entries[0].isDirectory) {
      rootName = entries[0].name;
      const children = await readAllEntries(entries[0] as FsDirEntry);
      for (const child of children) count += await addEntryToZip(zip, child, "");
    } else {
      rootName = entries[0]?.name ?? "project";
      for (const entry of entries) count += await addEntryToZip(zip, entry, "");
    }
  } else if (looseFiles.length > 0) {
    rootName = looseFiles[0].name;
    for (const f of looseFiles) {
      if (shouldSkipPath(f.name)) continue;
      zip.file(f.name, f);
      count += 1;
    }
  }

  if (count === 0) return null;
  return finalizeZip(zip, rootName, count, onProgress);
}

/**
 * Build a zip from a `<input type="file" webkitdirectory>` FileList. Each
 * File carries a `webkitRelativePath` like "myapp/src/index.ts".
 */
export async function buildZipFromFolderInput(
  files: FileList | File[],
  onProgress?: (pct: number) => void
): Promise<BuiltZip | null> {
  const list = Array.from(files);
  if (list.length === 0) return null;

  // Derive the top folder name from the common first path segment.
  const firstRel = (list[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? list[0].name;
  const rootName = firstRel.split("/")[0] || "project";

  const zip = new JSZip();
  let count = 0;
  for (const f of list) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    // Strip the leading top-folder segment so contents sit at the zip root.
    const stripped = rel.includes("/") ? rel.slice(rel.indexOf("/") + 1) : rel;
    if (!stripped || shouldSkipPath(stripped)) continue;
    zip.file(stripped, f);
    count += 1;
  }

  if (count === 0) return null;
  return finalizeZip(zip, rootName, count, onProgress);
}

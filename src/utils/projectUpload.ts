/**
 * File/folder collection utilities for the upload panel.
 *
 * Collects files together with their relative paths so the backend can
 * reconstruct the directory structure under the target working directory.
 * No zipping, no project detection, no running — just bytes + paths.
 */

export type FileEntry = { file: File; path: string };

/** Directory names skipped at every level. */
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

function shouldSkip(relPath: string): boolean {
  const segments = relPath.split("/");
  const fileName = segments[segments.length - 1];
  if (IGNORE_FILES.has(fileName)) return true;
  return segments.slice(0, -1).some((seg) => IGNORE_DIRS.has(seg));
}

/* ── FileSystemEntry helpers (drag-and-drop) ── */

/** Recursively collect all FileEntry objects from a FileSystemEntry tree. */
async function collectFromEntry(
  entry: FileSystemEntry,
  prefix: string
): Promise<FileEntry[]> {
  if (entry.isFile) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (shouldSkip(path)) return [];
    const file = await new Promise<File>((res, rej) =>
      (entry as FileSystemFileEntry).file(res, rej)
    );
    return [{ file, path }];
  }

  if (entry.isDirectory) {
    if (IGNORE_DIRS.has(entry.name)) return [];
    const dirPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const all: FileSystemEntry[] = [];
    // readEntries returns at most ~100 entries per call — loop until empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
        reader.readEntries(res, rej)
      );
      if (!batch.length) break;
      all.push(...batch);
    }
    const results: FileEntry[] = [];
    for (const child of all) {
      results.push(...(await collectFromEntry(child, dirPath)));
    }
    return results;
  }

  return [];
}

/**
 * Collect all droppable files from a DataTransfer object, preserving
 * relative paths (folders arrive as trees, plain files arrive flat).
 * Must be called synchronously in the drop event (before any await),
 * then awaited for the async tree walk.
 */
export async function collectFromDataTransfer(
  dataTransfer: DataTransfer
): Promise<FileEntry[]> {
  const items = Array.from(dataTransfer.items).filter((i) => i.kind === "file");

  // Collect entries synchronously — webkitGetAsEntry must be called during
  // the drop event before the DataTransfer is cleared.
  const entries: FileSystemEntry[] = [];
  const looseFiles: File[] = [];
  for (const item of items) {
    const entry = (
      item as unknown as { webkitGetAsEntry?: () => FileSystemEntry | null }
    ).webkitGetAsEntry?.();
    if (entry) {
      entries.push(entry);
    } else {
      const f = item.getAsFile();
      if (f) looseFiles.push(f);
    }
  }

  const result: FileEntry[] = [];
  for (const entry of entries) {
    result.push(...(await collectFromEntry(entry, "")));
  }
  for (const f of looseFiles) {
    if (!shouldSkip(f.name)) result.push({ file: f, path: f.name });
  }
  return result;
}

/**
 * Collect files from a `<input webkitdirectory>` or plain multi-file
 * FileList, preserving the webkitRelativePath (includes the top folder name).
 */
export function collectFromFileList(fileList: FileList | File[]): FileEntry[] {
  return Array.from(fileList)
    .map((f) => {
      const rel =
        (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
        f.name;
      return { file: f, path: rel };
    })
    .filter(({ path }) => !shouldSkip(path));
}

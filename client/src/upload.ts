import * as api from "./api";
import { formatMb } from "./formatSize";

export interface DroppedFile {
  file: File;
  relativePath: string;
}

export interface DroppedItems {
  files: DroppedFile[];
  // Relative dir paths seen during traversal (includes dirs that turn out to
  // be empty, and parents of files) so empty folders can be recreated too.
  dirs: string[];
}

function readEntryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readEntriesBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

// readEntries returns at most ~100 entries per call and must be called
// repeatedly until it resolves empty to get the full directory listing.
async function readAllEntries(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await readEntriesBatch(reader);
    if (batch.length === 0) break;
    all.push(...batch);
  }
  return all;
}

async function walk(
  entry: FileSystemEntry,
  relativePath: string,
  files: DroppedFile[],
  dirs: string[],
): Promise<void> {
  if (entry.isFile) {
    files.push({ file: await readEntryFile(entry as FileSystemFileEntry), relativePath });
  } else if (entry.isDirectory) {
    dirs.push(relativePath);
    const children = await readAllEntries(entry as FileSystemDirectoryEntry);
    await Promise.all(
      children.map((child) => walk(child, `${relativePath}/${child.name}`, files, dirs)),
    );
  }
}

// webkitGetAsEntry() must be called synchronously in the drop handler before
// any await — browsers invalidate the DataTransferItemList once the event
// handler yields, so entries are grabbed up front and only walked after.
export async function collectDropped(dataTransfer: DataTransfer): Promise<DroppedItems> {
  const files: DroppedFile[] = [];
  const dirs: string[] = [];

  const items = Array.from(dataTransfer.items);
  if (items.length > 0 && typeof items[0].webkitGetAsEntry === "function") {
    const entries = items
      .map((item) => item.webkitGetAsEntry())
      .filter((e): e is FileSystemEntry => e != null);
    await Promise.all(entries.map((entry) => walk(entry, entry.name, files, dirs)));
    return { files, dirs };
  }

  // Fallback for browsers without the entries API: flat files only, no
  // folder structure (dropped folders can't be represented this way).
  for (const file of Array.from(dataTransfer.files)) {
    files.push({ file, relativePath: file.name });
  }
  return { files, dirs };
}

export interface UploadCallbacks {
  onProgress?: (loadedBytes: number, totalBytes: number, currentName: string) => void;
  // Called on a 409 when conflictSetting is "ask"; true = overwrite, false = skip.
  onConflict?: (relativePath: string) => Promise<boolean>;
}

export interface UploadOutcome {
  errors: { relativePath: string; message: string }[];
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// settings.uploadMaxSizeMb as a byte count; 0 (the default) stays 0, which
// every caller reads as "no limit".
export function uploadMaxBytes(maxSizeMb: number): number {
  return maxSizeMb > 0 ? maxSizeMb * 1024 * 1024 : 0;
}

// Returns the skip reason for a file the size limit rejects, or null when
// it's allowed. Shared by every upload entry point (the FILES tree's
// drop/picker below, TerminalView's terminal paste/drop) so an oversized
// file is refused with the same wording wherever it was dropped.
export function oversizeReason(size: number, maxBytes: number): string | null {
  if (maxBytes <= 0 || size <= maxBytes) return null;
  return `too large (${formatMb(size)} MB, limit ${formatMb(maxBytes)} MB)`;
}

export async function uploadAll(
  items: DroppedItems,
  destDir: string,
  conflictSetting: "rename" | "overwrite" | "ask",
  maxBytes: number,
  callbacks: UploadCallbacks = {},
): Promise<UploadOutcome> {
  const errors: UploadOutcome["errors"] = [];

  // Size-filter up front so oversized files never reach the wire and the
  // progress total below reflects only what's actually being sent — a
  // folder drop with one huge file still uploads the rest, reporting the
  // skip like any other per-file failure.
  const files: DroppedFile[] = [];
  for (const item of items.files) {
    const reason = oversizeReason(item.file.size, maxBytes);
    if (reason) errors.push({ relativePath: item.relativePath, message: reason });
    else files.push(item);
  }

  // Create directories (including empty ones) before files, so a file whose
  // parent was an empty sibling dir still has somewhere to land.
  for (const dir of items.dirs) {
    try {
      await api.makeDir(destDir, dir);
    } catch (err) {
      errors.push({ relativePath: dir, message: errMessage(err) });
    }
  }

  const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);
  let doneBytes = 0;
  const apiConflict = conflictSetting === "ask" ? "fail" : conflictSetting;

  for (const { file, relativePath } of files) {
    const onFileProgress = (loaded: number) => {
      callbacks.onProgress?.(doneBytes + loaded, totalBytes, relativePath);
    };
    try {
      await api.uploadFile(destDir, relativePath, file, apiConflict, onFileProgress);
    } catch (err) {
      if (err instanceof api.UploadConflictError) {
        const overwrite = (await callbacks.onConflict?.(relativePath)) ?? false;
        if (overwrite) {
          try {
            await api.uploadFile(destDir, relativePath, file, "overwrite", onFileProgress);
          } catch (err2) {
            errors.push({ relativePath, message: errMessage(err2) });
          }
        } else {
          errors.push({ relativePath, message: "skipped (already exists)" });
        }
      } else {
        errors.push({ relativePath, message: errMessage(err) });
      }
    }
    doneBytes += file.size;
    callbacks.onProgress?.(doneBytes, totalBytes, relativePath);
  }

  return { errors };
}

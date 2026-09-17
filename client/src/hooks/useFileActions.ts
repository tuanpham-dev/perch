import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import * as api from "../api";
import { copyText } from "../clipboard";
import {
  extensionFileMenuItems,
  findFileViewerFor,
  findPreviewCapableViewerFor,
  requestFindInFolder,
  type RegisteredFileViewer,
} from "../extensions";
import type { AppSettings } from "../settings";
import type { MenuItem } from "../types";
import { collectDropped, uploadAll, uploadMaxBytes, type DroppedItems } from "../upload";

// Used only by refreshClipboardMirror's poll-driven update below, to keep
// the same state object identity (and skip the re-render it'd otherwise
// cause) when an idle tick's answer matches what's already mirrored.
function sameClipboard(
  a: { paths: string[]; mode: "copy" | "cut" } | null,
  b: { paths: string[]; mode: "copy" | "cut" } | null,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.mode !== b.mode || a.paths.length !== b.paths.length) return false;
  return a.paths.every((p, i) => p === b.paths[i]);
}

// File-entry actions (rename/delete/create/copy/download), the FILES-tree
// context menus built on them, and the upload/drop pipeline. Takes
// setFilesRefreshKey as a parameter rather than owning that state itself —
// useSessions' onAfterRefresh callback and useFileOpeners' extension wiring
// both need the setter before this hook (which depends on their outputs:
// openFileInEditor/openPreviewViewerTab) can be called, so the state has
// to live in App instead.
export function useFileActions(
  showError: (err: unknown) => void,
  confirmDialog: (message: string, confirmLabel?: string) => Promise<boolean>,
  promptDialog: (message: string, defaultValue?: string) => Promise<string | null>,
  settingsRef: MutableRefObject<AppSettings>,
  setFilesRefreshKey: Dispatch<SetStateAction<number>>,
  extFileViewers: RegisteredFileViewer[],
  // Opens in whichever editor the `editor` setting selects — nvim by
  // default. See useFileOpeners' openFileInEditor.
  openFileInEditor: (filePath: string, line?: number) => Promise<void>,
  openPreviewViewerTab: (filePath: string) => void,
) {
  const [uploadProgress, setUploadProgress] = useState<{
    currentName: string;
    loadedBytes: number;
    totalBytes: number;
  } | null>(null);
  // Set whenever a delete/rename (single or bulk) lands, so FileTree can drop
  // the now-stale paths (and their descendants) from its expanded/dirCache/
  // selection state instead of waiting for a refetch to notice they're gone.
  const [prunePath, setPrunePath] = useState<{ paths: string[] } | null>(null);

  // Local mirror of the server-held FILES-tree clipboard (see api.ts's
  // setFsClipboard/getFsClipboard) — used only to dim cut rows in FileTree.
  // Paste itself never reads this; it always defers to the server's own
  // state, which is what makes paste correct across browsers/tabs. Refreshed
  // on the existing 3s session poll (see App.tsx's onAfterRefresh piggyback)
  // so a cut made in another browser dims here within one tick too.
  const [fsClipboard, setFsClipboardState] = useState<{
    paths: string[];
    mode: "copy" | "cut";
  } | null>(null);

  const renameFileEntry = useCallback(
    async (entryPath: string) => {
      const base = entryPath.slice(entryPath.lastIndexOf("/") + 1);
      const newName = (await promptDialog("New name", base))?.trim();
      if (!newName || newName === base) return;
      try {
        await api.renameEntry(entryPath, newName);
        setPrunePath({ paths: [entryPath] });
        setFilesRefreshKey((k) => k + 1);
      } catch (err) {
        showError(err);
      }
    },
    [promptDialog, showError, setFilesRefreshKey],
  );

  const deleteFileEntry = useCallback(
    async (entryPath: string, isDir: boolean) => {
      const base = entryPath.slice(entryPath.lastIndexOf("/") + 1);
      if (!(await confirmDialog(`Delete ${isDir ? "folder" : "file"} "${base}"?`, "Delete")))
        return;
      try {
        await api.deleteEntry(entryPath);
        setPrunePath({ paths: [entryPath] });
        setFilesRefreshKey((k) => k + 1);
      } catch (err) {
        showError(err);
      }
    },
    [confirmDialog, showError, setFilesRefreshKey],
  );

  const deleteFileEntries = useCallback(
    async (entries: { path: string; isDir: boolean }[]) => {
      if (entries.length === 0) return;
      const label =
        entries.length === 1
          ? `Delete ${entries[0].isDir ? "folder" : "file"} "${entries[0].path.slice(entries[0].path.lastIndexOf("/") + 1)}"?`
          : `Delete ${entries.length} items?`;
      if (!(await confirmDialog(label, "Delete"))) return;
      const succeeded: string[] = [];
      const errors: string[] = [];
      for (const { path } of entries) {
        try {
          await api.deleteEntry(path);
          succeeded.push(path);
        } catch {
          errors.push(path);
        }
      }
      if (succeeded.length > 0) {
        setPrunePath({ paths: succeeded });
        setFilesRefreshKey((k) => k + 1);
      }
      if (errors.length === 1) {
        showError(`Delete failed: ${errors[0]}`);
      } else if (errors.length > 1) {
        showError(`${errors.length} items failed to delete`);
      }
    },
    [confirmDialog, showError, setFilesRefreshKey],
  );

  // Copy/Cut also best-effort write the path list as plain text to the OS
  // clipboard (same mechanism as "Copy Path") — a browser can't put real
  // files on the OS clipboard, so this is the closest a paste into e.g. a
  // terminal can get. Failures are swallowed: the server-side clipboard
  // write above is what actually matters for FILES-tree paste.
  const copyEntries = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      try {
        await api.setFsClipboard(paths, "copy");
        setFsClipboardState({ paths, mode: "copy" });
        copyText(paths.join("\n")).catch(() => {});
      } catch (err) {
        showError(err);
      }
    },
    [showError],
  );

  const cutEntries = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      try {
        await api.setFsClipboard(paths, "cut");
        setFsClipboardState({ paths, mode: "cut" });
        copyText(paths.join("\n")).catch(() => {});
      } catch (err) {
        showError(err);
      }
    },
    [showError],
  );

  const clearClipboard = useCallback(() => {
    setFsClipboardState(null);
    api.clearFsClipboard().catch(() => {});
  }, []);

  // Called on the existing 3s session poll (see App.tsx) so a copy/cut made
  // in another browser/tab against this same server shows up here too —
  // dimming only, paste itself always defers to the server's own state.
  const refreshClipboardMirror = useCallback(() => {
    api
      .getFsClipboard()
      .then(({ paths, mode }) => {
        const next = mode ? { paths, mode } : null;
        // Keeps the same object identity (skipping the re-render) when an
        // idle tick's answer matches what's already mirrored.
        setFsClipboardState((prev) => (sameClipboard(prev, next) ? prev : next));
      })
      .catch(() => {
        // Offline tick — leave the mirror as-is, don't toast.
      });
  }, []);

  const pasteIntoDir = useCallback(
    async (destDir: string) => {
      try {
        const { pasted, errors } = await api.pasteFsClipboard(destDir);
        if (fsClipboard?.mode === "cut" && pasted.length > 0) {
          setPrunePath({ paths: fsClipboard.paths });
          setFsClipboardState(null);
        }
        if (pasted.length > 0) setFilesRefreshKey((k) => k + 1);
        if (errors.length === 1) {
          showError(`Paste failed: ${errors[0].path} - ${errors[0].message}`);
        } else if (errors.length > 1) {
          showError(`${errors.length} items failed to paste`);
        }
      } catch (err) {
        showError(err);
      }
    },
    [fsClipboard, showError, setFilesRefreshKey],
  );

  // Backs FILES-tree drag-and-drop (drag = move, Ctrl+drag = copy). Separate
  // from the clipboard actions above by design — a drag leaves whatever the
  // user has cut/copied on the server clipboard untouched.
  const transferEntries = useCallback(
    async (paths: string[], destDir: string, mode: "move" | "copy") => {
      if (paths.length === 0) return;
      try {
        const { done, errors } = await api.transferEntries(paths, destDir, mode);
        // A move leaves the source paths behind as stale tree state (expanded /
        // dirCache / selection), same as a cut-paste — prune them. A copy adds
        // without removing, so a plain refresh is enough.
        if (mode === "move" && done.length > 0) setPrunePath({ paths });
        if (done.length > 0) setFilesRefreshKey((k) => k + 1);
        const verb = mode === "move" ? "Move" : "Copy";
        if (errors.length === 1) {
          showError(`${verb} failed: ${errors[0].path} - ${errors[0].message}`);
        } else if (errors.length > 1) {
          showError(`${errors.length} items failed to ${mode}`);
        }
      } catch (err) {
        showError(err);
      }
    },
    [showError, setFilesRefreshKey],
  );

  const createFileInDir = useCallback(
    async (dirPath: string) => {
      const name = (await promptDialog("New file name"))?.trim();
      if (!name) return;
      try {
        await api.createFile(dirPath, name);
        setFilesRefreshKey((k) => k + 1);
      } catch (err) {
        showError(err);
      }
    },
    [promptDialog, showError, setFilesRefreshKey],
  );

  const createFolderInDir = useCallback(
    async (dirPath: string) => {
      const name = (await promptDialog("New folder name"))?.trim();
      if (!name) return;
      try {
        await api.makeDir(dirPath, name);
        setFilesRefreshKey((k) => k + 1);
      } catch (err) {
        showError(err);
      }
    },
    [promptDialog, showError, setFilesRefreshKey],
  );

  const copyFilePath = useCallback(
    (entryPath: string) => {
      copyText(entryPath).catch(showError);
    },
    [showError],
  );

  const copyFileRelativePath = useCallback(
    (entryPath: string, rootDir: string) => {
      const rel = entryPath.startsWith(rootDir + "/")
        ? entryPath.slice(rootDir.length + 1)
        : entryPath === rootDir
          ? "."
          : entryPath;
      copyText(rel).catch(showError);
    },
    [showError],
  );

  // Backs files.copyPath/files.copyRelativePath (FileTree's keyboard
  // dispatch): selection-aware like copy/cut/delete, newline-joined to match
  // the bulk context menu's existing "Copy Paths" item.
  const copyFilePaths = useCallback(
    (paths: string[]) => {
      copyText(paths.join("\n")).catch(showError);
    },
    [showError],
  );

  const copyFileRelativePaths = useCallback(
    (paths: string[], rootDir: string) => {
      const rels = paths.map((entryPath) =>
        entryPath.startsWith(rootDir + "/")
          ? entryPath.slice(rootDir.length + 1)
          : entryPath === rootDir
            ? "."
            : entryPath,
      );
      copyText(rels.join("\n")).catch(showError);
    },
    [showError],
  );

  const downloadFileEntry = useCallback((entryPath: string) => {
    const a = document.createElement("a");
    a.href = api.downloadUrl(entryPath);
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const handleUpload = useCallback(
    async (items: DroppedItems, destDir: string) => {
      if (items.files.length === 0 && items.dirs.length === 0) return;
      const maxBytes = uploadMaxBytes(settingsRef.current.uploadMaxSizeMb);
      setUploadProgress({
        currentName: "",
        loadedBytes: 0,
        // Oversized files are dropped by uploadAll, not sent — but the first
        // onProgress call corrects this total anyway, and a drop that's
        // entirely oversized finishes before it can be seen.
        totalBytes: items.files.reduce((sum, f) => sum + f.file.size, 0),
      });
      const result = await uploadAll(items, destDir, settingsRef.current.uploadConflict, maxBytes, {
        onProgress: (loadedBytes, totalBytes, currentName) => {
          setUploadProgress({ currentName, loadedBytes, totalBytes });
        },
        onConflict: (relativePath) =>
          confirmDialog(`"${relativePath}" already exists. Overwrite?`, "Overwrite"),
      });
      setUploadProgress(null);
      setFilesRefreshKey((k) => k + 1);
      if (result.errors.length === 1) {
        showError(`Upload failed: ${result.errors[0].relativePath} - ${result.errors[0].message}`);
      } else if (result.errors.length > 1) {
        showError(`${result.errors.length} files failed to upload`);
      }
    },
    [confirmDialog, showError, setFilesRefreshKey, settingsRef],
  );

  // Folder drops target a specific FILES-panel folder; the drop's DataTransfer
  // is read synchronously (before any await) since browsers invalidate it once
  // the event handler yields.
  const handleFileTreeDrop = useCallback(
    (destDir: string, dataTransfer: DataTransfer) => {
      collectDropped(dataTransfer)
        .then((items) => handleUpload(items, destDir))
        .catch(showError);
    },
    [handleUpload, showError],
  );

  // Opens a native multi-file picker from a context-menu click (a user
  // gesture, so <input>.click() is allowed) and uploads the picked files into
  // destDir through the same pipeline as a drop — flat files only, no folder
  // structure (a plain file picker can't carry directories).
  const pickAndUpload = useCallback(
    (destDir: string) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.onchange = () => {
        const items: DroppedItems = {
          files: Array.from(input.files ?? []).map((file) => ({ file, relativePath: file.name })),
          dirs: [],
        };
        if (items.files.length > 0) void handleUpload(items, destDir);
      };
      input.click();
    },
    [handleUpload],
  );

  const fileTreeRootMenuItems = useCallback(
    (rootDir: string): MenuItem[] => [
      { label: "New File…", shortcutCommand: "files.newFile", onClick: () => createFileInDir(rootDir) },
      { label: "New Folder…", shortcutCommand: "files.newFolder", onClick: () => createFolderInDir(rootDir) },
      { label: "Upload…", onClick: () => pickAndUpload(rootDir) },
      // Always offered rather than disabled when empty: knowing the server
      // clipboard's emptiness synchronously would need a fetch per menu open
      // (it may have been set from another browser). An empty paste just
      // shows the "clipboard is empty" error toast.
      { label: "Paste", shortcutCommand: "files.paste", onClick: () => pasteIntoDir(rootDir) },
    ],
    [createFileInDir, createFolderInDir, pickAndUpload, pasteIntoDir],
  );

  const findInFolder = useCallback((entryPath: string, rootDir: string) => {
    const rel = entryPath.startsWith(rootDir + "/")
      ? entryPath.slice(rootDir.length + 1)
      : entryPath === rootDir
        ? "."
        : entryPath;
    // rel === "." (the root folder itself) needs no include-glob restriction
    // — that's already the search panel's unscoped default.
    requestFindInFolder(rel === "." ? "" : `${rel}/**`);
  }, []);

  const fileMenuItems = useCallback(
    (entryPath: string, isDir: boolean, rootDir: string): MenuItem[] => {
      const items: MenuItem[] = [];
      if (isDir) {
        items.push(
          { label: "New File…", shortcutCommand: "files.newFile", onClick: () => createFileInDir(entryPath) },
          {
            label: "New Folder…",
            shortcutCommand: "files.newFolder",
            onClick: () => createFolderInDir(entryPath),
          },
          {
            label: "Find in Folder…",
            shortcutCommand: "files.findInFolder",
            onClick: () => findInFolder(entryPath, rootDir),
          },
          { label: "Upload…", onClick: () => pickAndUpload(entryPath) },
        );
      }
      items.push(
        { label: "Cut", shortcutCommand: "files.cut", onClick: () => cutEntries([entryPath]) },
        { label: "Copy", shortcutCommand: "files.copy", onClick: () => copyEntries([entryPath]) },
      );
      if (isDir) {
        items.push({
          label: "Paste",
          shortcutCommand: "files.paste",
          onClick: () => pasteIntoDir(entryPath),
        });
      }
      items.push(
        { label: "Rename…", shortcutCommand: "files.rename", onClick: () => renameFileEntry(entryPath) },
        { label: "Copy Path", shortcutCommand: "files.copyPath", onClick: () => copyFilePath(entryPath) },
        {
          label: "Copy Relative Path",
          shortcutCommand: "files.copyRelativePath",
          onClick: () => copyFileRelativePath(entryPath, rootDir),
        },
        { label: "Download", onClick: () => downloadFileEntry(entryPath) },
      );
      // Images/media/PDFs open in their viewer by default (see
      // openFileOrViewer) — editorFallback is the escape hatch to edit e.g.
      // an SVG's source in nvim; media/PDF opt out of it (nvim on binary
      // content isn't useful) via their own registration.
      const defaultViewer = !isDir ? findFileViewerFor(entryPath, extFileViewers, "default") : null;
      if (defaultViewer?.editorFallback) {
        items.push({ label: "Open in Editor", onClick: () => openFileInEditor(entryPath) });
      }
      // Markdown/JSON/YAML/CSV get an explicit path to the rendered view.
      // Preview-capable (not resolved-"preview"-mode) so the item survives
      // markdown.clickAction: "preview", where a plain click already opens
      // the preview but the menu should still name the action.
      if (!isDir && findPreviewCapableViewerFor(entryPath, extFileViewers)) {
        items.push({ label: "Preview", onClick: () => openPreviewViewerTab(entryPath) });
      }
      items.push({
        label: "Delete",
        shortcutCommand: "files.delete",
        danger: true,
        onClick: () => deleteFileEntry(entryPath, isDir),
      });
      // Extension contributions last, behind a separator. Read from the
      // module-level registry at menu-open time (not captured in this
      // callback's deps) so a just-activated extension's items show up
      // without waiting for a re-render — menus are built on demand.
      const extItems = extensionFileMenuItems
        .filter((item) => {
          try {
            return item.isVisible(entryPath, isDir);
          } catch {
            // A throwing isVisible hides its own item rather than breaking
            // the whole menu — same fail-safe posture as the file-open
            // interceptors.
            return false;
          }
        })
        .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
      if (extItems.length > 0) {
        items.push({ label: "", separator: true, onClick: () => {} });
        for (const item of extItems) {
          items.push({ label: item.label, icon: item.icon, onClick: () => item.onClick(entryPath) });
        }
      }
      return items;
    },
    [
      createFileInDir,
      createFolderInDir,
      findInFolder,
      pickAndUpload,
      cutEntries,
      copyEntries,
      pasteIntoDir,
      renameFileEntry,
      copyFilePath,
      copyFileRelativePath,
      downloadFileEntry,
      openFileInEditor,
      openPreviewViewerTab,
      deleteFileEntry,
      extFileViewers,
    ],
  );

  // Bulk counterpart of fileMenuItems, shown when the FILES-tree right-click
  // target is part of a multi-row selection — a smaller action set (no
  // rename/preview/find-in-folder, which don't make sense across a mixed
  // selection of files and folders).
  const fileMultiMenuItems = useCallback(
    (entries: { path: string; isDir: boolean }[]): MenuItem[] => [
      { label: "Cut", shortcutCommand: "files.cut", onClick: () => cutEntries(entries.map((e) => e.path)) },
      {
        label: "Copy",
        shortcutCommand: "files.copy",
        onClick: () => copyEntries(entries.map((e) => e.path)),
      },
      {
        label: "Copy Paths",
        shortcutCommand: "files.copyPath",
        onClick: () => copyFilePaths(entries.map((e) => e.path)),
      },
      { label: "Download", onClick: () => entries.forEach((e) => downloadFileEntry(e.path)) },
      {
        label: `Delete ${entries.length} items`,
        shortcutCommand: "files.delete",
        danger: true,
        onClick: () => deleteFileEntries(entries),
      },
    ],
    [downloadFileEntry, deleteFileEntries, cutEntries, copyEntries, copyFilePaths],
  );

  return {
    uploadProgress,
    prunePath,
    fsClipboard,
    handleUpload,
    handleFileTreeDrop,
    renameFileEntry,
    deleteFileEntry,
    deleteFileEntries,
    createFileInDir,
    createFolderInDir,
    copyFilePath,
    copyFileRelativePath,
    copyFilePaths,
    copyFileRelativePaths,
    findInFolder,
    downloadFileEntry,
    copyEntries,
    cutEntries,
    pasteIntoDir,
    clearClipboard,
    refreshClipboardMirror,
    transferEntries,
    fileTreeRootMenuItems,
    fileMenuItems,
    fileMultiMenuItems,
  };
}

import { useCallback, useRef } from "react";
import * as api from "../api";
import { resolveEditor } from "../editors";
import {
  extensionFileOpenInterceptors,
  findFileViewerFor,
  findPreviewCapableViewerFor,
  type RegisteredFileViewer,
} from "../extensions";
import type { OpenTargetPayload } from "../types";

// `perch open` bridge (plans/cli-open-command.md): turns a broadcast
// open-target event (or an equivalent `?folder=`/`?file=` deep link) into
// the same UI actions a PROJECTS-panel click or FILES-tree click would
// trigger. A directory opens/focuses its project; a file's default
// (`payload.action` unset) is the exact primary-action dispatch
// useFileOpeners' openFileOrViewer uses for a plain FILES-tree click —
// "default"-mode viewer first, then file-open interceptors, then nvim.
// `editor`/`preview` force one branch, mirroring the quick switcher's
// Enter/Shift+Enter split.
export function useOpenTarget(
  openProject: (cwd: string) => Promise<string | undefined>,
  extFileViewers: RegisteredFileViewer[],
  openExtViewerTab: (viewerId: string, filePath: string, title?: string) => void,
  openWindowTab: (session: string, index: number) => Promise<string | null>,
  refresh: () => Promise<void>,
  showError: (err: unknown) => void,
  // The `editor` setting — a CLI/deep-link open lands in the same editor a
  // FILES-tree click would (see useFileOpeners' openFileInEditor).
  selectedEditor: string,
) {
  const selectedEditorRef = useRef(selectedEditor);
  selectedEditorRef.current = selectedEditor;
  const openInEditor = useCallback(
    async (path: string, projectCwd: string, line: number | undefined) => {
      const session = await openProject(projectCwd);
      if (!session) return;
      // A non-nvim editor renders in a tab of its own and needs no session —
      // but the project still had to be opened above, so the file lands in
      // the same project context a click would have used.
      const editor = await resolveEditor("file", selectedEditorRef.current);
      if (editor && editor.extensionId !== null) {
        await editor.openFile(path, line);
        return;
      }
      const { windowIndex, deferredPane } = await api.openFile(session, path, undefined, line);
      if (windowIndex !== null) {
        await refresh();
        await openWindowTab(session, windowIndex);
      }
      if (deferredPane) {
        // nvim's RPC socket wasn't reachable yet — the server held off the
        // keystroke-based open until its window's tab was visible (see
        // useFileOpeners' openFileInSession); complete it now.
        await api.openFile(session, path, deferredPane, line);
      }
    },
    [openProject, refresh, openWindowTab],
  );

  const handleOpenTarget = useCallback(
    async (payload: OpenTargetPayload) => {
      try {
        if (payload.kind === "dir") {
          await openProject(payload.path);
          return;
        }
        if (payload.action === "preview") {
          const viewer = findPreviewCapableViewerFor(payload.path, extFileViewers);
          if (viewer) {
            await openProject(payload.projectCwd);
            openExtViewerTab(viewer.id, payload.path);
            return;
          }
          // No preview-capable viewer registered — fall through to the
          // editor, same as useFileOpeners' openPreviewViewerTab no-op.
          await openInEditor(payload.path, payload.projectCwd, payload.line);
          return;
        }
        if (payload.action === "editor") {
          await openInEditor(payload.path, payload.projectCwd, payload.line);
          return;
        }
        // Default: the primary action, identical to a FILES-tree plain
        // click (openFileOrViewer's dispatch).
        const viewer = findFileViewerFor(payload.path, extFileViewers, "default");
        if (viewer) {
          await openProject(payload.projectCwd);
          openExtViewerTab(viewer.id, payload.path);
          return;
        }
        for (const { intercept } of [...extensionFileOpenInterceptors]) {
          try {
            if (await intercept(payload.path)) return;
          } catch {
            // fall through to the next interceptor / the editor
          }
        }
        await openInEditor(payload.path, payload.projectCwd, payload.line);
      } catch (err) {
        showError(err);
      }
    },
    [openProject, extFileViewers, openExtViewerTab, openInEditor, showError],
  );

  return { handleOpenTarget };
}

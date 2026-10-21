// "Unsaved Changes…": every file with a saved draft (server drafts.ts), to
// open it with the draft restored or throw the draft away. A draft kept for
// a file never reopened would otherwise sit unseen until it's pruned.
import * as api from "../api";
import type { PickItem } from "./pickFilter";

type Pick = (opts: { title: string; items: PickItem[]; placeholder?: string }) => Promise<string | null>;

function age(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

// A draft's key names its file when it looks like a path; other keys
// (an extension's own records) can only be discarded.
const isPath = (key: string) => key.startsWith("/") || key.startsWith("~") || /^[A-Za-z]:[\\/]/.test(key);

export async function showUnsavedChanges(deps: {
  pick: Pick;
  openFile: (path: string) => void;
  showError: (err: unknown) => void;
}): Promise<void> {
  let drafts: { extId: string; key: string; savedAt: number }[];
  try {
    drafts = await api.listDrafts();
  } catch (err) {
    deps.showError(err);
    return;
  }
  if (drafts.length === 0) {
    await deps.pick({ title: "Unsaved Changes", items: [{ id: "", label: "No unsaved changes are waiting", icon: "check" }] });
    return;
  }
  const chosen = await deps.pick({
    title: "Unsaved Changes",
    placeholder: "Filter by file",
    items: drafts.map((d, i) => ({
      id: String(i),
      label: d.key.split(/[\\/]/).pop() || d.key,
      detail: `${d.key} · ${age(d.savedAt)}`,
      icon: "circle-filled",
    })),
  });
  const draft = chosen ? drafts[Number(chosen)] : undefined;
  if (!draft) return;
  const action = await deps.pick({
    title: draft.key,
    items: [
      ...(isPath(draft.key) ? [{ id: "open", label: "Open with the unsaved changes", icon: "go-to-file" }] : []),
      { id: "discard", label: "Discard the unsaved changes", icon: "trash" },
    ],
  });
  if (action === "open") deps.openFile(draft.key);
  else if (action === "discard") {
    try {
      await api.deleteDraft(draft.extId, draft.key);
    } catch (err) {
      deps.showError(err);
    }
  }
}

// Saving over a file that changed on disk since it was opened (an agent
// edited it while its tab stayed open): asks before the save overwrites
// those changes. Every editor-like view asks the same way, so the choice
// reads the same everywhere: Overwrite (keep mine), Reload (take the disk
// version, dropping my edits) or Cancel.
//
// Registry extensions carry their own copy (they can't import from here);
// keep the wording the same.

export type DiskChoice = "overwrite" | "reload" | "cancel";

type PickItem = { id: string; label: string; detail?: string; icon?: string };
type Pick = (opts: { title: string; items: PickItem[] }) => Promise<string | null>;

// Compares what's on disk now with what the view loaded. "none" when nothing
// changed (or the file is gone: saving recreates it); otherwise what the
// user chose. `readDisk` returns the file's current text.
export async function checkDiskConflict(opts: {
  name: string;
  loaded: string;
  readDisk: () => Promise<string>;
  pick: Pick | undefined;
}): Promise<DiskChoice | "none"> {
  let current: string;
  try {
    current = await opts.readDisk();
  } catch {
    return "none";
  }
  if (current === opts.loaded) return "none";
  if (!opts.pick) return "overwrite";
  const choice = await opts.pick({
    title: `${opts.name} changed on disk since you opened it.`,
    items: [
      { id: "overwrite", label: "Overwrite", detail: "Save your version over the changes on disk", icon: "save" },
      { id: "reload", label: "Reload", detail: "Take the version on disk; your unsaved changes are lost", icon: "refresh" },
      { id: "cancel", label: "Cancel", detail: "Don't save", icon: "close" },
    ],
  });
  return choice === "overwrite" || choice === "reload" ? choice : "cancel";
}

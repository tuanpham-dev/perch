// Delete in FILES moves to the operating system's trash, so a mistake is
// recovered the usual way (Files' Trash, Finder's Trash, the Recycle Bin).
//
//   Linux    `gio trash` when GLib's tools are there (it knows each volume's
//            own .Trash-<uid>), else the freedesktop.org trash in
//            $XDG_DATA_HOME/Trash written directly, for a file on the same
//            filesystem as that folder.
//   macOS    a move into ~/.Trash (a clashing name gets a number).
//   Windows  the Recycle Bin, through PowerShell's VisualBasic FileIO.
//
// Where none of these can take a path (a headless server's other disk, a
// network mount) trashAvailable says so, and the app asks before deleting
// it for good.
import { execFile } from "node:child_process";
import { cp, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

let gio: Promise<boolean> | null = null;
function hasGio(): Promise<boolean> {
  gio ??= run("gio", ["--version"], { timeout: 5000 }).then(
    () => true,
    () => false,
  );
  return gio;
}

function xdgTrashDir(): string {
  const data = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
  return path.join(data, "Trash");
}

async function sameDevice(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    return sa.dev === sb.dev;
  } catch {
    return false;
  }
}

// The nearest existing folder at or above `p`, for checking which disk a
// trash folder that doesn't exist yet would live on.
async function existingAncestor(p: string): Promise<string> {
  let dir = p;
  for (;;) {
    try {
      await stat(dir);
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return dir;
      dir = parent;
    }
  }
}

// Whether a delete of `target` can go to the trash instead of being final.
export async function trashAvailable(target: string): Promise<boolean> {
  if (process.platform === "win32" || process.platform === "darwin") return true;
  if (process.platform !== "linux") return false;
  if (await hasGio()) return true;
  return sameDevice(path.dirname(target), await existingAncestor(xdgTrashDir()));
}

// A name in `dir` that isn't taken: "name", "name 2", "name 3", …
async function freeName(dir: string, base: string): Promise<string> {
  const ext = path.extname(base);
  const stem = ext && ext !== base ? base.slice(0, -ext.length) : base;
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${stem} ${i}${ext}`;
    try {
      await stat(path.join(dir, name));
    } catch {
      return name;
    }
  }
}

function deletionDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// The freedesktop.org trash, written by hand: the item moves into
// Trash/files and a Trash/info/<name>.trashinfo records where it came from,
// which is what file managers read to offer "Restore".
async function freedesktopTrash(target: string): Promise<void> {
  const trash = xdgTrashDir();
  const files = path.join(trash, "files");
  const info = path.join(trash, "info");
  await mkdir(files, { recursive: true, mode: 0o700 });
  await mkdir(info, { recursive: true, mode: 0o700 });
  if (!(await sameDevice(path.dirname(target), files))) throw new Error("the Trash is on another disk");
  const name = await freeName(files, path.basename(target));
  const encoded = path
    .resolve(target)
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  await writeFile(path.join(info, `${name}.trashinfo`), `[Trash Info]\nPath=${encoded}\nDeletionDate=${deletionDate()}\n`, {
    flag: "wx",
  });
  try {
    await rename(target, path.join(files, name));
  } catch (err) {
    await rm(path.join(info, `${name}.trashinfo`), { force: true });
    throw err;
  }
}

async function macTrash(target: string): Promise<void> {
  const trash = path.join(homedir(), ".Trash");
  await mkdir(trash, { recursive: true });
  const dest = path.join(trash, await freeName(trash, path.basename(target)));
  try {
    await rename(target, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    // Another volume: copy, then remove the original.
    await cp(target, dest, { recursive: true, preserveTimestamps: true });
    await rm(target, { recursive: true });
  }
}

async function windowsRecycle(target: string): Promise<void> {
  const isDir = (await stat(target)).isDirectory();
  // The path travels as an environment variable, never spliced into the
  // command line.
  const script =
    "Add-Type -AssemblyName Microsoft.VisualBasic; " +
    `[Microsoft.VisualBasic.FileIO.FileSystem]::${isDir ? "DeleteDirectory" : "DeleteFile"}(` +
    "$env:PERCH_TRASH_TARGET, 'OnlyErrorDialogs', 'SendToRecycleBin')";
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 60_000,
    env: { ...process.env, PERCH_TRASH_TARGET: target },
    windowsHide: true,
  });
}

// Moves `target` to the trash. Rejects (leaving it where it was) when the
// trash can't take it.
export async function moveToTrash(target: string): Promise<void> {
  await stat(target);
  if (process.platform === "win32") return windowsRecycle(target);
  if (process.platform === "darwin") return macTrash(target);
  if (process.platform !== "linux") throw new Error("this system has no trash Perch can use");
  if (await hasGio()) {
    try {
      await run("gio", ["trash", "--", target], { timeout: 60_000 });
      return;
    } catch (err) {
      // gio can't trash on some filesystems; the direct way may still work.
      try {
        await freedesktopTrash(target);
        return;
      } catch {
        throw new Error(`couldn't move it to the Trash: ${(err as { stderr?: string }).stderr?.trim() || (err as Error).message}`);
      }
    }
  }
  return freedesktopTrash(target);
}

export const _test = { freedesktopTrash, deletionDate, freeName };

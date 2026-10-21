// Reloading an extension's server code in place, after an update, without
// restarting the server. ES modules are cached by URL for the life of the
// process, and the server's loader (tsx) ignores a cache-busting query, so
// importing the updated entry from the same folder would hand back the old
// module. Instead, an updated extension runs from a fresh copy of its folder
// (new URLs, so a whole new module graph: its entry, its own modules and its
// node_modules), and later mounts keep using that copy. Installed extensions
// are self-contained packages, so a copy runs exactly as the original would.
//
// Copies live in <configDir>/extension-runtime/ and are removed when they're
// replaced, and all of them when the server starts (a fresh process loads
// every extension from its own folder again).
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { configDir } from "./configDir.js";

const runtimeRoot = path.join(configDir, "extension-runtime");
// Extension id → the copy its server code currently runs from.
const runningFrom = new Map<string, string>();
let seq = 0;

// Where an extension's server entry should be imported from: its current
// copy after an update, else its own folder.
export function serverFolder(id: string, folderPath: string): string {
  return runningFrom.get(id) ?? folderPath;
}

// Copies the extension's folder to a new runtime folder and makes it the one
// its server code runs from. The previous copy, if any, is removed.
export async function freshServerCopy(id: string, folderPath: string): Promise<string> {
  const safeId = id.replace(/[^A-Za-z0-9._-]/g, "_");
  const dest = path.join(runtimeRoot, `${safeId}-${Date.now().toString(36)}-${++seq}`);
  await mkdir(runtimeRoot, { recursive: true });
  await cp(folderPath, dest, { recursive: true });
  const previous = runningFrom.get(id);
  runningFrom.set(id, dest);
  if (previous) await rm(previous, { recursive: true, force: true }).catch(() => {});
  return dest;
}

// Forgets an extension's copy (it was uninstalled) and removes it.
export async function dropServerCopy(id: string): Promise<void> {
  const previous = runningFrom.get(id);
  runningFrom.delete(id);
  if (previous) await rm(previous, { recursive: true, force: true }).catch(() => {});
}

// At start-up: copies left by an earlier process are never used again.
export async function clearServerCopies(): Promise<void> {
  runningFrom.clear();
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
}

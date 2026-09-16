// Which Claude Code session is running in which terminal window. Claude Code
// writes one ~/.claude/sessions/<pid>.json per running CLI, carrying its
// current sessionId and its real cwd. The CLI inherits $PERCH_WINDOW
// from the window it was started in, so its pid leads to its window. Resolving
// a window through its CLI is what keeps two Claude windows open in the same
// directory apart: the older rule, "the most recently written transcript in
// that cwd's project dir", handed both windows whichever session had written
// last.
//
// Files are left behind by CLIs that exited (hundreds accumulate), so a file
// only counts while its pid is alive; the pid is the filename, so dead ones
// are skipped without being read. The agent-monitor extension (in the
// separate perch-extensions registry repo) vendors a copy of this
// file, since extensions can't import each other.
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const CLAUDE_SESSIONS_DIR = path.join(homedir(), ".claude", "sessions");

// The window a process was started in, from its own environment. Null for a
// CLI started outside the app's terminals, one owned by another user, or a
// host with no /proc.
export async function windowIdOfPid(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/environ`, "utf8");
    for (const entry of raw.split("\0")) {
      if (entry.startsWith("PERCH_WINDOW=")) return entry.slice("PERCH_WINDOW=".length) || null;
    }
  } catch {
    // Exited, foreign, or no /proc.
  }
  return null;
}

// Pure core of the lookup: parsed session records plus each record pid's
// window id in, windowId -> session out. When a window somehow has more than
// one live record, the most recently updated one wins.
export function sessionsByWindow(records, isAlive, windowOfPid) {
  const byWindow = new Map();
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    if (typeof record.sessionId !== "string" || !record.sessionId) continue;
    if (typeof record.pid !== "number" || !isAlive(record.pid)) continue;
    const windowId = windowOfPid.get(record.pid);
    if (!windowId) continue;
    const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : 0;
    const existing = byWindow.get(windowId);
    if (existing && existing.updatedAt >= updatedAt) continue;
    byWindow.set(windowId, {
      sessionId: record.sessionId,
      cwd: typeof record.cwd === "string" ? record.cwd : null,
      updatedAt,
    });
  }
  return byWindow;
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists, it just isn't ours to signal.
    return err?.code === "EPERM";
  }
}

const CACHE_TTL_MS = 2_000;
let cache = null; // { at, value: Promise<Map> }

async function readSessionsByWindow(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return new Map();
  }
  const records = await Promise.all(
    names.map(async (name) => {
      const m = /^(\d+)\.json$/.exec(name);
      if (!m || !isPidAlive(Number(m[1]))) return null;
      try {
        return JSON.parse(await readFile(path.join(dir, name), "utf8"));
      } catch {
        return null; // Mid-write or malformed: skip this poll.
      }
    }),
  );
  const windowOfPid = new Map();
  await Promise.all(
    records.map(async (record) => {
      if (record && typeof record.pid === "number") windowOfPid.set(record.pid, await windowIdOfPid(record.pid));
    }),
  );
  return sessionsByWindow(records, isPidAlive, windowOfPid);
}

// windowId -> { sessionId, cwd, updatedAt } for every live Claude CLI in one of
// the app's terminals. Cached briefly so one poll resolving many windows reads
// the directory once.
export function claudeSessionsByWindow(dir = CLAUDE_SESSIONS_DIR) {
  const now = Date.now();
  if (!cache || now - cache.at >= CACHE_TTL_MS) {
    cache = { at: now, value: readSessionsByWindow(dir) };
  }
  return cache.value;
}

import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scrollbackDir, statePath, stateDir } from '../util/paths.ts';
import type { SessionStore } from './session-store.ts';
import type { Window } from './window.ts';

// 2 added each session's rootCwd. A snapshot without it can't say which
// project its sessions belong to, and there is no answer to invent, so an
// older one is not read at all. 3 added each window's autoName and running
// processes, and each session's id and creation time.
export const SNAPSHOT_VERSION = 3;

export type WindowSnapshot = {
  windowId: string;
  name: string;
  autoName: boolean;
  cwd: string;
  command?: string;
  /** Process names running under the shell when saved (see Window.descendantCommands). */
  running: string[];
  cols: number;
  rows: number;
};
export type SessionSnapshot = { id: string; name: string; createdAt: number; rootCwd: string; currentIndex: number; windows: WindowSnapshot[] };
export type Snapshot = { version: number; savedAt: number; serverUrl?: string | null; sessions: SessionSnapshot[] };

function atomicWrite(path: string, data: string | Buffer): void {
  // Same-directory temp keeps rename() on one filesystem (never EXDEV).
  const tmp = `${path}.${process.pid}.tmp`;
  // Owner-only: history can hold anything that was ever printed, secrets included.
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

function scrollbackFile(windowId: string): string {
  return join(scrollbackDir(), `${windowId}.txt`);
}

function rawScrollbackFile(windowId: string): string {
  return join(scrollbackDir(), `${windowId}.raw`);
}

export class Snapshotter {
  #store: SessionStore<Window>;
  #persistLines: () => number;
  #debounceMs: () => number;
  #serverUrl: () => string | null;
  #persistScrollback: () => boolean;
  #writeIntervalMs: () => number;
  #timer: NodeJS.Timeout | null = null;
  /** Armed when a debounced write skipped a window that was dirty but saved
   *  too recently: fires when the earliest such window is due, so its output
   *  reaches disk without waiting for more activity. */
  #dueTimer: NodeJS.Timeout | null = null;
  /** When each window's scrollback files were last written, by window id.
   *  Empty on daemon start, so the first snapshot writes every window. */
  #savedAt = new Map<string, number>();

  constructor(
    store: SessionStore<Window>,
    persistLines: () => number,
    debounceMs: () => number,
    serverUrl: () => string | null = () => null,
    persistScrollback: () => boolean = () => true,
    writeIntervalMs: () => number = () => 30000,
  ) {
    this.#store = store;
    this.#persistLines = persistLines;
    this.#debounceMs = debounceMs;
    this.#serverUrl = serverUrl;
    this.#persistScrollback = persistScrollback;
    this.#writeIntervalMs = writeIntervalMs;
  }

  /** Coalesces bursty PTY output into at most one write per debounce window. */
  schedule(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#write(false);
    }, this.#debounceMs());
    this.#timer.unref();
  }

  /** Immediate write, for structural changes and shutdown. Every changed
   *  window is saved now, however recently it was saved last. */
  now(): void {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    this.#write(true);
  }

  #write(force: boolean): void {
    if (this.#dueTimer) { clearTimeout(this.#dueTimer); this.#dueTimer = null; }
    const now = Date.now();
    const lines = this.#persistLines();
    const withScrollback = this.#persistScrollback();
    const interval = this.#writeIntervalMs();
    // Ids whose scrollback files stay; everything else in the directory is
    // swept — which is also how turning scrollback off removes what was saved.
    const live = new Set<string>();
    let earliestDue = Infinity;
    const snapshot: Snapshot = { version: SNAPSHOT_VERSION, savedAt: now, serverUrl: this.#serverUrl(), sessions: [] };
    for (const session of this.#store.sessions.values()) {
      const windows: WindowSnapshot[] = [];
      for (const w of session.windows) {
        if (w.exited) continue;
        if (withScrollback) live.add(w.id);
        // A restored window whose restore hasn't been acknowledged keeps
        // reporting what ran before it, even across another restart.
        const running = w.restoredCommands ?? w.descendantCommands().slice(1);
        windows.push({ windowId: w.id, name: w.name, autoName: w.autoName, running, cwd: w.liveCwd(), command: w.command, cols: w.cols, rows: w.rows });
        if (!withScrollback) continue;
        // A window that printed nothing since its last save is current on disk.
        if (!w.scrollbackDirty) continue;
        const last = this.#savedAt.get(w.id) ?? 0;
        if (!force && now - last < interval) {
          earliestDue = Math.min(earliestDue, last + interval);
          continue;
        }
        // Serialized replay (fallback) + raw sidecar (byte-exact, T1.6), written
        // together or not at all: a window whose write fails stays dirty and
        // is retried by the next snapshot.
        try {
          const replay = w.serializeState(lines);
          const raw = w.rawBytes();
          atomicWrite(scrollbackFile(w.id), replay);
          atomicWrite(rawScrollbackFile(w.id), raw);
          w.scrollbackDirty = false;
          this.#savedAt.set(w.id, now);
        } catch { /* still dirty; the next snapshot tries again */ }
      }
      if (windows.length > 0) {
        snapshot.sessions.push({ id: session.id, name: session.name, createdAt: session.createdAt, rootCwd: session.rootCwd, currentIndex: Math.min(session.currentIndex, windows.length - 1), windows });
      }
    }
    try { atomicWrite(statePath(), JSON.stringify(snapshot, null, 2)); } catch { /* best effort */ }
    this.#sweepOrphans(live);
    for (const id of this.#savedAt.keys()) if (!live.has(id)) this.#savedAt.delete(id);
    if (earliestDue !== Infinity) {
      this.#dueTimer = setTimeout(() => {
        this.#dueTimer = null;
        this.#write(false);
      }, Math.max(0, earliestDue - now));
      this.#dueTimer.unref();
    }
  }

  /** Drop scrollback files whose window no longer exists. */
  #sweepOrphans(live: Set<string>): void {
    let entries: string[];
    try { entries = readdirSync(scrollbackDir()); } catch { return; }
    for (const name of entries) {
      const isTxt = name.endsWith('.txt');
      const isRaw = name.endsWith('.raw');
      if (!isTxt && !isRaw) continue;
      if (!live.has(name.slice(0, -4))) {
        try { unlinkSync(join(scrollbackDir(), name)); } catch { /* already gone */ }
      }
    }
  }
}

/** Reads and validates the snapshot; a corrupt one is set aside so startup proceeds. */
export function loadSnapshot(): Snapshot | null {
  const path = statePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
    if (parsed.version !== SNAPSHOT_VERSION || !Array.isArray(parsed.sessions)) throw new Error('unrecognized snapshot');
    return parsed;
  } catch {
    try { renameSync(path, join(stateDir(), 'state.json.bad')); } catch { /* leave it */ }
    return null;
  }
}

export function readScrollback(windowId: string): string | undefined {
  try { return readFileSync(scrollbackFile(windowId), 'utf8'); } catch { return undefined; }
}

/** Raw sidecar bytes for byte-exact replay after restore; undefined if absent. */
export function readRawScrollback(windowId: string): Buffer | undefined {
  try {
    const buf = readFileSync(rawScrollbackFile(windowId));
    return buf.length > 0 ? buf : undefined;
  } catch { return undefined; }
}

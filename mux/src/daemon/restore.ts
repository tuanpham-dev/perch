import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Config } from '../util/config.ts';
import { Window } from './window.ts';
import type { DaemonServer } from './server.ts';
import { loadSnapshot, readScrollback, readRawScrollback } from './persistence.ts';
import { bannerText, appendBanner, appendBannerRaw } from './restore-banner.ts';

/**
 * Rebuild the session tree from the last snapshot. Each window gets its saved
 * scrollback replayed into the headless terminal ONLY, then a fresh shell at
 * the saved cwd underneath it. Declared commands re-run unless suppressed.
 * Returns the number of sessions restored.
 */
export function restoreSessions(server: DaemonServer, config: Config, runCommands: boolean, log: (m: string) => void): number {
  const snapshot = loadSnapshot();
  if (!snapshot) return 0;
  const stamp = new Date(snapshot.savedAt).toLocaleString();
  server.seedNotifyUrl(snapshot.serverUrl);
  let restored = 0;
  for (const s of snapshot.sessions) {
    const windows: Window[] = [];
    for (const w of s.windows) {
      const cwd = existsSync(w.cwd) ? w.cwd : homedir();
      const saved = readScrollback(w.windowId);
      const rawSaved = readRawScrollback(w.windowId);
      // A restore banner separates old history from the new shell's first
      // prompt. Any banner already at the end is replaced rather than added to
      // — see restore-banner.ts for why that matters over many reboots.
      const banner = bannerText(new Date(snapshot.savedAt));
      const restoredScrollback = saved !== undefined ? appendBanner(saved, banner) : undefined;
      // The raw sidecar gets the same treatment, so byte-exact replay shows
      // what the serialize path shows.
      const restoredRaw = rawSaved !== undefined ? appendBannerRaw(rawSaved, banner) : undefined;
      windows.push(new Window({
        id: w.windowId,
        name: w.name,
        autoName: w.autoName,
        serverUrl: server.notifyUrl,
        sessionName: s.name,
        cwd,
        command: w.command,
        cols: w.cols,
        rows: w.rows,
        shell: config.shell,
        scrollbackLines: config.scrollbackLines,
        rawScrollbackBytes: config.rawScrollbackBytes,
        restoredScrollback,
        restoredRaw,
        runCommand: runCommands,
        restoredCommands: w.running,
      }));
    }
    if (windows.length === 0) continue;
    server.adoptSession(s.id, s.name, windows, Math.min(s.currentIndex, windows.length - 1), s.rootCwd, s.createdAt);
    restored++;
  }
  if (restored > 0) log(`restored ${restored} session(s) from snapshot saved ${stamp}`);
  return restored;
}

// Small process helpers shared by the commands.
import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Absolute path of a command on PATH, or null. */
export function which(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Runs a command quietly; true when it exits 0. */
export function succeeds(cmd: string, args: string[], cwd?: string): boolean {
  const r = spawnSync(cmd, args, { stdio: 'ignore', cwd });
  return r.status === 0;
}

/** A command's stdout, trimmed, or "" when it fails. */
export function output(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.trim() : '';
}

// npm is a .cmd script on Windows, which Node only runs through a shell.
export const needsShell = (cmd: string) => process.platform === 'win32' && cmd === 'npm';

/** Runs a command with the terminal attached; returns its exit status. */
export function inherit(cmd: string, args: string[], cwd?: string): number {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd, shell: needsShell(cmd) });
  return r.status ?? 1;
}

export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when the server answers on this port within the timeout. */
export async function responding(port: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

// node-pty spawns every terminal on macOS through a small `spawn-helper`
// binary next to its native addon. node-pty 1.1.0's npm tarball ships that
// file without its execute bit, and its install scripts don't restore it, so
// every spawn fails with "posix_spawnp failed." Restored once at daemon start,
// for a source checkout, the installer and the desktop app's bundle alike.
import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** The spawn-helper binaries node-pty may load on this platform. */
export function spawnHelperCandidates(ptyDir: string, platform = process.platform, arch = process.arch): string[] {
  return [
    path.join(ptyDir, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
    path.join(ptyDir, 'build', 'Release', 'spawn-helper'),
  ];
}

/** Makes each existing spawn-helper executable; returns the ones it fixed. */
export function ensureExecutable(files: string[]): string[] {
  const fixed: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      accessSync(file, constants.X_OK);
    } catch {
      chmodSync(file, statSync(file).mode | 0o755);
      fixed.push(file);
    }
  }
  return fixed;
}

export function ensureSpawnHelperExecutable(log: (msg: string) => void): void {
  if (process.platform === 'win32') return;
  try {
    const ptyDir = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
    for (const file of ensureExecutable(spawnHelperCandidates(ptyDir))) log(`made ${file} executable`);
  } catch (err) {
    log(`couldn't check node-pty's spawn-helper: ${(err as Error).message}`);
  }
}

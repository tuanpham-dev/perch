import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { daemonEntryPath } from '../util/paths.ts';

const MARKER = '# perch-mux (daemon autostart)';
const SERVICE_NAME = 'perch-mux.service';

export type InstallResult = { mechanism: 'systemd' | 'crontab'; detail: string };

function systemdAvailable(): boolean {
  // Not "does systemctl exist" but "can it reach a live user bus": a container
  // may ship systemctl yet have no --user instance (no $DBUS/$XDG_RUNTIME_DIR),
  // where every --user call fails. show-environment needs that bus, so it is a
  // faithful probe; any failure means fall through to another mechanism.
  try {
    execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function crontabAvailable(): boolean {
  try {
    execFileSync('crontab', ['-l'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { status?: number };
    // ENOENT = no crontab binary. A non-zero exit (empty crontab) is fine.
    return e.code !== 'ENOENT';
  }
}

function systemdUnitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', SERVICE_NAME);
}

function installSystemd(): InstallResult {
  const dir = join(homedir(), '.config', 'systemd', 'user');
  mkdirSync(dir, { recursive: true });
  const unit = [
    '[Unit]',
    'Description=sp persistent terminal session daemon',
    'After=default.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${process.execPath} ${daemonEntryPath()}`,
    'Restart=on-failure',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
  writeFileSync(systemdUnitPath(), unit);
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', SERVICE_NAME], { stdio: 'ignore' });
  } catch (err) {
    try { unlinkSync(systemdUnitPath()); } catch { /* leave it */ }
    throw new Error(`systemd unit written but activation failed: ${String(err)}`);
  }
  return { mechanism: 'systemd', detail: systemdUnitPath() };
}

function readCrontab(): string {
  try {
    return execFileSync('crontab', ['-l']).toString();
  } catch {
    return ''; // no crontab yet
  }
}

function writeCrontab(text: string): void {
  const tmp = join(homedir(), `.sp-crontab.${process.pid}.tmp`);
  writeFileSync(tmp, text.endsWith('\n') || text === '' ? text : text + '\n');
  try {
    execFileSync('crontab', [tmp]);
  } finally {
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
}

/** Strip any prior sp block (marker line + the @reboot line under it). */
function stripCrontabBlock(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === MARKER) {
      if (lines[i + 1]?.includes(daemonEntryPath()) || lines[i + 1]?.startsWith('@reboot')) i++;
      continue;
    }
    out.push(lines[i] as string);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

function installCrontab(): InstallResult {
  const existing = stripCrontabBlock(readCrontab());
  const entry = `${MARKER}\n@reboot ${process.execPath} ${daemonEntryPath()} --quiet`;
  const next = existing.trim() === '' ? entry + '\n' : `${existing.replace(/\n+$/, '')}\n${entry}\n`;
  writeCrontab(next);
  return { mechanism: 'crontab', detail: '@reboot entry in your user crontab' };
}

export function installBootHook(): InstallResult {
  // On Windows the app's own logon task starts the server, which starts the
  // daemon; there is nothing separate to install for it.
  if (process.platform === 'win32') {
    throw new Error('on Windows, run `perch enable` instead: the logon task it adds starts the daemon too');
  }
  if (systemdAvailable()) return installSystemd();
  if (crontabAvailable()) return installCrontab();
  throw new Error(
    'no supported autostart mechanism found (need systemctl --user or crontab).\n' +
    `Add this to your shell rc instead:\n  ${process.execPath} ${daemonEntryPath()} --quiet 2>/dev/null &`,
  );
}

export function uninstallBootHook(): string[] {
  const removed: string[] = [];
  if (existsSync(systemdUnitPath())) {
    try { execFileSync('systemctl', ['--user', 'disable', SERVICE_NAME], { stdio: 'ignore' }); } catch { /* not enabled */ }
    try { unlinkSync(systemdUnitPath()); removed.push(systemdUnitPath()); } catch { /* gone */ }
    try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  if (crontabAvailable()) {
    const current = readCrontab();
    if (current.includes(MARKER)) {
      writeCrontab(stripCrontabBlock(current));
      removed.push('crontab @reboot entry');
    }
  }
  return removed;
}

export function bootHookStatus(): string {
  const bits: string[] = [];
  if (existsSync(systemdUnitPath())) bits.push(`systemd unit at ${systemdUnitPath()}`);
  try {
    if (readCrontab().includes(MARKER)) bits.push('crontab @reboot entry');
  } catch { /* no crontab */ }
  return bits.length ? bits.join(', ') : 'no boot hook installed';
}

export { MARKER as _CRONTAB_MARKER };

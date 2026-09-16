// systemd user unit (~/.config/systemd/user/perch.service), copied from
// the repo's systemd/ directory so `update` ships unit changes too.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { REPO_DIR } from './paths.ts';
import { inherit, output, succeeds, which } from './run.ts';
import type { ServiceManager } from './serviceManager.ts';

export const UNIT_NAME = 'perch.service';
const unitSource = () => join(REPO_DIR, 'systemd', UNIT_NAME);
const unitDest = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', UNIT_NAME);

const systemctl = (...args: string[]) => inherit('systemctl', ['--user', ...args]);

export const systemd: ServiceManager = {
  kind: 'systemd',
  available: () => which('systemctl') !== null && succeeds('systemctl', ['--user', 'list-units']),
  installed: () => existsSync(unitDest()),
  install: () => {
    const source = readFileSync(unitSource(), 'utf8');
    const dest = unitDest();
    if (existsSync(dest) && readFileSync(dest, 'utf8') === source) return;
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, source);
    systemctl('daemon-reload');
  },
  start: () => void systemctl('start', UNIT_NAME),
  stop: () => void systemctl('stop', UNIT_NAME),
  restart: () => void systemctl('restart', UNIT_NAME),
  enable: () => void systemctl('enable', '--now', UNIT_NAME),
  disable: () => void spawnSync('systemctl', ['--user', 'disable', '--now', UNIT_NAME], { stdio: 'ignore' }),
  active: () => succeeds('systemctl', ['--user', 'is-active', '--quiet', UNIT_NAME]),
  enabled: () => succeeds('systemctl', ['--user', 'is-enabled', '--quiet', UNIT_NAME]),
  mainPid: () => {
    const pid = Number(output('systemctl', ['--user', 'show', UNIT_NAME, '-p', 'MainPID', '--value']));
    return pid > 0 ? pid : null;
  },
  printStatus: () => void inherit('systemctl', ['--user', 'status', UNIT_NAME, '--no-pager']),
  followLogs: () => void inherit('journalctl', ['--user', '-u', UNIT_NAME, '-f', '--no-pager']),
  doctor: (report) => {
    if (output('loginctl', ['show-user', userInfo().username, '-p', 'Linger']).includes('Linger=yes')) {
      report.ok('linger enabled (starts on boot without login)');
    } else {
      report.warn(`linger not enabled - the service only runs while you're logged in. Run: loginctl enable-linger ${userInfo().username}`);
    }
  },
};

/** Lets the service start at boot without a login session. */
export function enableLinger(): boolean {
  return which('loginctl') !== null && succeeds('loginctl', ['enable-linger', userInfo().username]);
}

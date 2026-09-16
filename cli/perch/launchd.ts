// launchd agent (~/Library/LaunchAgents/dev.perch.plist): starts at
// login, restarts on crash, logs to ~/Library/Logs/perch.log.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { SELF } from './paths.ts';
import { inherit, output, succeeds, which } from './run.ts';
import type { ServiceManager } from './serviceManager.ts';

export const LABEL = 'dev.perch';
const plistPath = () => join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
export const launchdLogPath = () => join(homedir(), 'Library', 'Logs', 'perch.log');
const domain = () => `gui/${userInfo().uid}`;
const target = () => `${domain()}/${LABEL}`;

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The agent definition. AbandonProcessGroup keeps launchd from killing the
 * terminal daemon when the service stops or restarts: the server starts it
 * and it has to outlive the server. PATH is carried over because launchd
 * starts agents with a minimal one that has no node or npm on it.
 */
export function plist(self: string, logPath: string, path: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(self)}</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

const loaded = () => succeeds('launchctl', ['print', target()]);

export const launchd: ServiceManager = {
  kind: 'launchd',
  available: () => which('launchctl') !== null,
  installed: () => existsSync(plistPath()),
  install: () => {
    const text = plist(SELF, launchdLogPath(), process.env.PATH ?? '/usr/bin:/bin');
    const dest = plistPath();
    if (existsSync(dest) && readFileSync(dest, 'utf8') === text) return;
    mkdirSync(join(dest, '..'), { recursive: true });
    mkdirSync(join(launchdLogPath(), '..'), { recursive: true });
    if (loaded()) inherit('launchctl', ['bootout', target()]);
    writeFileSync(dest, text);
  },
  start: () => {
    if (!loaded()) inherit('launchctl', ['bootstrap', domain(), plistPath()]);
    else inherit('launchctl', ['kickstart', target()]);
  },
  stop: () => {
    if (loaded()) inherit('launchctl', ['bootout', target()]);
  },
  restart: () => {
    if (loaded()) inherit('launchctl', ['kickstart', '-k', target()]);
    else inherit('launchctl', ['bootstrap', domain(), plistPath()]);
  },
  enable: () => {
    inherit('launchctl', ['enable', target()]);
    if (!loaded()) inherit('launchctl', ['bootstrap', domain(), plistPath()]);
  },
  disable: () => {
    if (loaded()) inherit('launchctl', ['bootout', target()]);
    inherit('launchctl', ['disable', target()]);
  },
  active: () => /\bstate = running\b/.test(output('launchctl', ['print', target()])),
  enabled: () => !output('launchctl', ['print-disabled', domain()]).includes(`"${LABEL}" => disabled`),
  mainPid: () => {
    const m = /\bpid = (\d+)/.exec(output('launchctl', ['print', target()]));
    return m ? Number(m[1]) : null;
  },
  printStatus: () => void inherit('launchctl', ['print', target()]),
  followLogs: () => void inherit('tail', ['-n', '50', '-f', launchdLogPath()]),
  doctor: () => {},
};

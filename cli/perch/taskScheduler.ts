// Windows: a Task Scheduler task that starts Perch at logon. It runs
// under conhost's headless mode so no console window opens, with output
// appended to %LOCALAPPDATA%\perch\perch.log.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { SELF } from './paths.ts';
import { inherit, output, succeeds } from './run.ts';
import type { ServiceManager } from './serviceManager.ts';

export const TASK_NAME = 'perch';
export const taskLogPath = () => join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'perch', 'perch.log');

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The task definition (Task Scheduler's XML schema). Starts at the user's
 * logon, restarts a few times if it exits with an error, never times out,
 * and keeps running on battery.
 */
export function taskXml(opts: { user: string; node: string; self: string; logPath: string }): string {
  const command = `set PERCH_LAUNCHER=service&& "${opts.node}" "${opts.self}" run >> "${opts.logPath}" 2>&1`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Perch: web UI for your terminals</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(opts.user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(opts.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>--headless cmd.exe /d /c ${xml(`"${command}"`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

const schtasks = (...args: string[]) => inherit('schtasks', args);
const queryCsv = () => output('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/NH']);

export const taskScheduler: ServiceManager = {
  kind: 'Task Scheduler',
  available: () => process.platform === 'win32' && succeeds('schtasks', ['/?']),
  installed: () => succeeds('schtasks', ['/Query', '/TN', TASK_NAME]),
  install: () => {
    const user = `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ''}${userInfo().username}`;
    mkdirSync(join(taskLogPath(), '..'), { recursive: true });
    const file = join(tmpdir(), `perch-task-${process.pid}.xml`);
    // schtasks reads the declared UTF-16 encoding; write it that way.
    writeFileSync(file, Buffer.from(`\ufeff${taskXml({ user, node: process.execPath, self: SELF, logPath: taskLogPath() })}`, 'utf16le'));
    try {
      spawnSync('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', file, '/F'], { stdio: 'inherit' });
    } finally {
      rmSync(file, { force: true });
    }
  },
  start: () => void schtasks('/Run', '/TN', TASK_NAME),
  stop: () => void schtasks('/End', '/TN', TASK_NAME),
  restart: () => {
    schtasks('/End', '/TN', TASK_NAME);
    schtasks('/Run', '/TN', TASK_NAME);
  },
  enable: () => {
    schtasks('/Change', '/TN', TASK_NAME, '/ENABLE');
    schtasks('/Run', '/TN', TASK_NAME);
  },
  disable: () => {
    schtasks('/End', '/TN', TASK_NAME);
    schtasks('/Change', '/TN', TASK_NAME, '/DISABLE');
  },
  active: () => /"Running"/.test(queryCsv()),
  enabled: () => queryCsv() !== '' && !/"Disabled"/.test(queryCsv()),
  // Task Scheduler reports no process id for a running task.
  mainPid: () => null,
  printStatus: () => void schtasks('/Query', '/TN', TASK_NAME, '/V', '/FO', 'LIST'),
  followLogs: () => void inherit('powershell.exe', ['-NoProfile', '-Command', `Get-Content -Tail 50 -Wait -Path '${taskLogPath()}'`]),
  doctor: () => {},
};

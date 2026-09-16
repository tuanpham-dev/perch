// Windows. There is no /proc, no signals worth the name and no unix socket,
// so: a per-user named pipe for the daemon, taskkill for process trees, and
// a process list kept by a long-lived PowerShell helper while it is being read
// (asking PowerShell synchronously would stall the daemon for half a second
// every listing, and starting it every second costs more than the daemon).
// A window's working directory can't be read from outside the process at
// all; it comes from the shell integration's OSC 7 report instead (see
// Window.liveCwd), so cwdOf answers null.
import { createHash } from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Platform } from './types.ts';

/** The pipe for a state dir: per user and per state dir, so two instances don't meet. */
export function pipeName(user: string, stateDir: string): string {
  const hash = createHash('sha1').update(`${user}\0${stateDir.toLowerCase()}`).digest('hex').slice(0, 12);
  return `\\\\.\\pipe\\perch-${hash}`;
}

export interface ProcEntry { pid: number; ppid: number; name: string }

/**
 * Parses `Get-CimInstance Win32_Process | ConvertTo-Csv` output with the
 * columns ProcessId, ParentProcessId, Name. Names lose their ".exe" so they
 * match what a POSIX system reports ("pwsh", "nvim", "claude").
 */
export function parseProcessCsv(csv: string): ProcEntry[] {
  const out: ProcEntry[] = [];
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return out;
  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const pidAt = header.indexOf('processid');
  const ppidAt = header.indexOf('parentprocessid');
  const nameAt = header.indexOf('name');
  if (pidAt < 0 || ppidAt < 0 || nameAt < 0) return out;
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const pid = Number(cells[pidAt]);
    const ppid = Number(cells[ppidAt]);
    const name = (cells[nameAt] ?? '').replace(/\.exe$/i, '');
    if (Number.isInteger(pid) && Number.isInteger(ppid)) out.push({ pid, ppid, name });
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells;
}

// Console hosts ConPTY starts beside a shell: never "what's running".
const CONSOLE_HOSTS = new Set(['conhost', 'openconsole']);

export function childrenOf(entries: readonly ProcEntry[], pid: number): number[] {
  return entries
    .filter((e) => e.ppid === pid && !CONSOLE_HOSTS.has(e.name.toLowerCase()))
    .map((e) => e.pid)
    .sort((a, b) => a - b);
}

/** pwsh, then Windows PowerShell, then whatever COMSPEC names. */
export function pickShell(onPath: (name: string) => boolean, comspec: string | undefined): string {
  if (onPath('pwsh.exe')) return 'pwsh.exe';
  if (onPath('powershell.exe')) return 'powershell.exe';
  return comspec || 'cmd.exe';
}

function onPath(name: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => {
    if (!dir) return false;
    try {
      closeSync(openSync(join(dir, name), 'r'));
      return true;
    } catch {
      return false;
    }
  });
}

// ---- process snapshot -------------------------------------------------------

const SNAPSHOT_MS = 1_000;
const HELPER_IDLE_MS = 30_000;
const HELPER_TIMEOUT_MS = 5_000;
const SNAPSHOT_END = '--perch-snapshot-end--';
const PROCESS_QUERY = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation';

type HelperProcess = {
  stdin: { write(data: string): unknown; end(): unknown; on(event: 'error', cb: () => void): unknown };
  stdout: { setEncoding(enc: 'utf8'): unknown; on(event: 'data', cb: (data: string) => void): unknown };
  on(event: 'exit' | 'error', cb: () => void): unknown;
  kill(): unknown;
  unref?(): unknown;
};

/**
 * The process list, kept fresh only while somebody reads it. Starting
 * PowerShell is what costs (hundreds of ms of CPU each time), so one helper
 * stays running and prints a snapshot per line it reads; it is asked at most
 * once a second, only when a caller wants the list, and exits after half a
 * minute without questions. A helper that stops answering is replaced by a
 * one-off query. Callers get the latest finished snapshot straight away.
 */
export class ProcessSnapshots {
  #snapshot: ProcEntry[] = [];
  #helper: HelperProcess | null = null;
  #buf = '';
  #waiting = false;
  #askedAt = 0;
  #idle: NodeJS.Timeout | null = null;
  #watchdog: NodeJS.Timeout | null = null;
  #spawnHelper: () => HelperProcess;
  #oneShot: (done: (csv: string | null) => void) => void;

  constructor(spawnHelper: () => HelperProcess, oneShot: (done: (csv: string | null) => void) => void) {
    this.#spawnHelper = spawnHelper;
    this.#oneShot = oneShot;
  }

  get(): ProcEntry[] {
    if (!this.#waiting && Date.now() - this.#askedAt >= SNAPSHOT_MS) this.#ask();
    return this.#snapshot;
  }

  /** Stops the helper now (daemon shutdown, tests). */
  dispose(): void {
    this.#stopHelper();
  }

  #ask(): void {
    this.#waiting = true;
    this.#askedAt = Date.now();
    try {
      if (!this.#helper) this.#startHelper();
      this.#helper!.stdin.write('\n');
    } catch {
      this.#fallback();
      return;
    }
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.#stopHelper(), HELPER_IDLE_MS);
    this.#idle.unref?.();
    this.#watchdog = setTimeout(() => {
      this.#stopHelper();
      this.#fallback();
    }, HELPER_TIMEOUT_MS);
    this.#watchdog.unref?.();
  }

  #startHelper(): void {
    const helper = this.#spawnHelper();
    this.#helper = helper;
    this.#buf = '';
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', (data) => {
      if (this.#helper !== helper) return;
      this.#buf += data;
      const end = this.#buf.indexOf(SNAPSHOT_END);
      if (end === -1) return;
      this.#snapshot = parseProcessCsv(this.#buf.slice(0, end));
      this.#buf = this.#buf.slice(end + SNAPSHOT_END.length);
      this.#answered();
    });
    const gone = () => {
      if (this.#helper !== helper) return;
      this.#helper = null;
      if (this.#waiting) {
        this.#clearWatchdog();
        this.#fallback();
      }
    };
    helper.on('exit', gone);
    helper.on('error', gone);
    helper.stdin.on('error', () => {});
    helper.unref?.();
  }

  #fallback(): void {
    this.#waiting = true;
    this.#oneShot((csv) => {
      if (csv !== null) this.#snapshot = parseProcessCsv(csv);
      this.#answered();
    });
  }

  #answered(): void {
    this.#clearWatchdog();
    this.#waiting = false;
  }

  #clearWatchdog(): void {
    if (this.#watchdog) clearTimeout(this.#watchdog);
    this.#watchdog = null;
  }

  #stopHelper(): void {
    const helper = this.#helper;
    this.#helper = null;
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    this.#clearWatchdog();
    if (!helper) return;
    try {
      helper.stdin.end();
      helper.kill();
    } catch {
      // Already gone.
    }
  }
}

const snapshots = new ProcessSnapshots(
  () =>
    spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference = 'SilentlyContinue'; while ($null -ne [Console]::In.ReadLine()) { ${PROCESS_QUERY} | Out-String -Width 4096 | Write-Output; '${SNAPSHOT_END}' }`,
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    ) as unknown as HelperProcess,
  (done) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PROCESS_QUERY],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => done(err ? null : stdout),
    ),
);

/** The latest process list; asks for a fresher one in the background. */
function processes(): ProcEntry[] {
  return snapshots.get();
}

function taskkill(pid: number, force: boolean): void {
  if (pid <= 0) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { stdio: 'ignore', windowsHide: true });
}

export const windows: Platform = {
  socketAddress: (stateDir) => pipeName(userInfo().username, stateDir),
  addressProblem: () => null,
  // A named pipe disappears with its last handle; nothing is left behind.
  clearStaleAddress: () => {},
  // Node can't set a pipe's ACL. The default grants write access only to the
  // creating user, SYSTEM and administrators, which is what's wanted.
  secureAddress: () => {},

  acquireLock: (lockPath, isLiveDaemon) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const fd = openSync(lockPath, 'wx');
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return true;
      } catch {
        let pid = NaN;
        try { pid = Number(readFileSync(lockPath, 'utf8').trim()); } catch { continue; }
        if (Number.isFinite(pid) && pid > 0 && pid !== process.pid && isLiveDaemon(pid)) return false;
        try { unlinkSync(lockPath); } catch { /* lost a race; retry */ }
      }
    }
    return false;
  },

  isDaemonProcess: (pid, entryPath) => {
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)}").CommandLine`],
      { encoding: 'utf8', windowsHide: true },
    );
    return (r.stdout ?? '').toLowerCase().includes(entryPath.toLowerCase());
  },

  spawnDetached: (execPath, args, env) => {
    spawn(execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env: env ?? process.env }).unref();
  },

  // There's no polite signal to send another process; `daemon stop` asks the
  // daemon over its pipe first, and this is only the fallback.
  terminate: (pid) => taskkill(pid, true),

  onStopRequest: (cb) => {
    process.on('SIGINT', cb);
    process.on('SIGBREAK', cb);
  },

  hangUpTree: (pid) => taskkill(pid, false),
  killTree: (pid) => taskkill(pid, true),

  childPids: (pid) => childrenOf(processes(), pid),
  processName: (pid) => processes().find((e) => e.pid === pid)?.name,
  cwdOf: () => null,

  defaultShell: () => pickShell(onPath, process.env.ComSpec ?? process.env.COMSPEC),

  onTerminalResize: (cb) => {
    process.stdout.on('resize', cb);
  },

  rawReplaySafe: false,
};

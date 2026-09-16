// Finding running Perch instances, and starting/stopping them when no
// service manager is in charge.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { LOG_FILE, PID_FILE, REPO_DIR, RUNTIME_DIR, SELF } from './paths.ts';
import { fail, info, ok } from './output.ts';
import { alive, responding, sleep } from './run.ts';
import { usableServiceManager } from './serviceManager.ts';

export type ManagedBy = 'service' | 'fallback' | 'external';

export interface Instance {
  pid: number;
  port: string;
  appName: string;
  managedBy: ManagedBy;
}

interface Proc {
  pid: number;
  pgid: number;
  command: string;
}

function processes(): Proc[] {
  const r = spawnSync('ps', ['-axww', '-o', 'pid=,pgid=,command='], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), command: m[3]! }));
}

/**
 * Every server process of this install. tsx always runs the server through its
 * loader, so a process whose command line names that loader and this repo is
 * a server, however it was launched (npm run dev, npm start, the service, a
 * background start).
 */
function serverProcesses(): Proc[] {
  return processes().filter((p) => {
    if (p.pid === process.pid) return false;
    if (!p.command.includes('node_modules/tsx/dist/loader.mjs') || !p.command.includes(REPO_DIR)) return false;
    const exe = p.command.split(/\s+/)[0] ?? '';
    return basename(exe) === 'node';
  });
}

/** One environment variable of another process, or "" when unreadable. */
export function envOf(pid: number, name: string): string {
  if (process.platform === 'linux') {
    try {
      const entries = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      return entries.filter((e) => e.startsWith(`${name}=`)).at(-1)?.slice(name.length + 1) ?? '';
    } catch {
      return '';
    }
  }
  // macOS: `ps -E` appends the environment to the command line.
  const r = spawnSync('ps', ['-wwwE', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  const m = new RegExp(`(?:^|\\s)${name}=(\\S*)`).exec(r.stdout ?? '');
  return m ? m[1]! : '';
}

/** Pids recorded by background starts that are still alive. */
function trackedPids(): Map<number, string> {
  const out = new Map<number, string>();
  let names: string[] = [];
  try {
    names = readdirSync(RUNTIME_DIR);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name !== 'perch.pid' && !/^perch-.+\.pid$/.test(name)) continue;
    const file = join(RUNTIME_DIR, name);
    const pid = Number(readFileSync(file, 'utf8').trim());
    if (alive(pid)) out.set(pid, file);
  }
  return out;
}

interface InstanceRecord { pid: number; port: number; appName: string; repoDir: string; launcher: string }

/**
 * Windows: the records running servers write to the temp folder
 * (server/src/instanceRecord.ts), since another process's command line and
 * environment aren't readable there. A record whose pid is gone is stale.
 */
function recordedInstances(): Instance[] {
  const dir = join(tmpdir(), 'perch-instances');
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Instance[] = [];
  for (const name of names) {
    let record: InstanceRecord;
    try {
      record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as InstanceRecord;
    } catch {
      continue;
    }
    if (!alive(record.pid)) {
      rmSync(join(dir, name), { force: true });
      continue;
    }
    if (resolve(record.repoDir).toLowerCase() !== resolve(REPO_DIR).toLowerCase()) continue;
    out.push({
      pid: record.pid,
      port: String(record.port),
      appName: record.appName || '-',
      managedBy: record.launcher === 'service' ? 'service' : record.launcher === 'cli' ? 'fallback' : 'external',
    });
  }
  return out;
}

export function listInstances(): Instance[] {
  if (process.platform === 'win32') return recordedInstances();
  const servers = serverProcesses();
  if (servers.length === 0) return [];
  const manager = usableServiceManager();
  const servicePid = manager?.installed() ? manager.mainPid() : null;
  const tracked = trackedPids();
  return servers.map((p) => {
    // The recorded pid (the service's main process, or a background start's
    // leader) is never the server process itself: npm and tsx sit in
    // between. They share a process group, so match on that.
    let managedBy: ManagedBy = 'external';
    if (servicePid !== null && (p.pid === servicePid || p.pgid === servicePid || sameTree(p.pid, servicePid))) managedBy = 'service';
    else if (tracked.has(p.pid) || tracked.has(p.pgid) || [...tracked.keys()].some((t) => sameTree(p.pid, t))) managedBy = 'fallback';
    return {
      pid: p.pid,
      port: envOf(p.pid, 'PORT') || '3001',
      appName: envOf(p.pid, 'APP_NAME') || '-',
      managedBy,
    };
  });
}

/** True when `ancestor` is `pid` or one of its parents. */
function sameTree(pid: number, ancestor: number): boolean {
  let current = pid;
  for (let hop = 0; hop < 32 && current > 1; hop++) {
    if (current === ancestor) return true;
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(current)], { encoding: 'utf8' });
    const parent = Number(r.stdout.trim());
    if (!parent || parent === current) return false;
    current = parent;
  }
  return false;
}

export function instanceOnPort(port: string): Instance | null {
  return listInstances().find((i) => i.port === port) ?? null;
}

function pgidOf(pid: number): number | null {
  if (process.platform === 'win32') return null;
  const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
  const pgid = Number(r.stdout.trim());
  return pgid > 0 ? pgid : null;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    // No process groups or signals: end the tree.
    spawnSync('taskkill', ['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], { stdio: 'ignore', windowsHide: true });
    return;
  }
  const pgid = pgidOf(pid);
  try {
    if (pgid) process.kill(-pgid, signal);
    else process.kill(pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

async function terminate(pid: number): Promise<void> {
  signalGroup(pid, 'SIGTERM');
  for (let i = 0; i < 5 && alive(pid); i++) await sleep(1000);
  if (alive(pid)) signalGroup(pid, 'SIGKILL');
}

/** Stops one discovered instance: through the service, or its whole process group. */
export async function stopInstance(instance: Instance): Promise<void> {
  if (instance.managedBy === 'service') {
    usableServiceManager()?.stop();
    ok(`stopped the service-managed instance (port ${instance.port})`);
    return;
  }
  // Found before stopping: once the server is gone, nothing links the pid
  // file's `perch run` process to it any more.
  const tracked = trackedLeader(instance);
  await terminate(instance.pid);
  if (tracked) {
    // `run` exits a moment after the server it runs.
    for (let i = 0; i < 30 && alive(tracked.pid); i++) await sleep(100);
    if (alive(tracked.pid)) signalGroup(tracked.pid, 'SIGKILL');
    rmSync(tracked.file, { force: true });
  }
  ok(`stopped instance (pid ${instance.pid}, port ${instance.port})`);
}

export function runningPid(pidFile = PID_FILE): number | null {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  return alive(pid) ? pid : null;
}

/**
 * Starts `perch run` in the background, in its own process group so a
 * stop can signal the whole server tree at once. Waits for the server to
 * answer on its port rather than for the process merely to exist: a start
 * that is about to die (a port already in use) is alive for a few seconds.
 */
export async function backgroundStart(port: string, pidFile = PID_FILE, logFile = LOG_FILE, env: Record<string, string> = {}): Promise<boolean> {
  const existing = runningPid(pidFile);
  if (existing) {
    info(`already running (pid ${existing}), logs: ${logFile}`);
    return true;
  }
  const log = openSync(logFile, 'a');
  const child = spawn(process.execPath, [SELF, 'run'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, PERCH_LAUNCHER: 'cli', ...env },
    windowsHide: true,
  });
  child.unref();
  const pid = child.pid!;
  writeFileSync(pidFile, String(pid));
  for (let waited = 0; waited < 10; waited++) {
    if (!alive(pid)) {
      fail(`failed to start - check ${logFile}`);
      rmSync(pidFile, { force: true });
      return false;
    }
    if (await responding(port, 1000)) {
      ok(`started (pid ${pid}) - logs: ${logFile}`);
      info(`http://127.0.0.1:${port}`);
      return true;
    }
    await sleep(1000);
  }
  fail(`started (pid ${pid}) but not responding on port ${port} after 10s - check ${logFile}`);
  return false;
}

export async function backgroundStop(pidFile = PID_FILE): Promise<void> {
  const pid = runningPid(pidFile);
  if (!pid) {
    info('not running');
    return;
  }
  await terminate(pid);
  rmSync(pidFile, { force: true });
  ok('stopped');
}

/** The pid file a discovered background instance was started with, if any. */
export function pidFileOf(instance: Instance): string | null {
  return trackedLeader(instance)?.file ?? null;
}

function trackedLeader(instance: Instance): { pid: number; file: string } | null {
  const pgid = pgidOf(instance.pid);
  for (const [pid, file] of trackedPids()) {
    if (pid === instance.pid || pid === pgid || sameTree(instance.pid, pid)) return { pid, file };
  }
  return null;
}

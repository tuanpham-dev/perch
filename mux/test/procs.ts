// Finding and killing the daemons a test started, on Linux and macOS.
//
// Tests spawn a real daemon per temp state dir (via the CLI, so the test never
// holds its pid directly). Cleanup has to find exactly those daemons and no
// others: the machine running the tests may also be running a real perch with
// its own daemon from this same checkout. So a daemon is only ever matched by
// BOTH its script path and the test's own PERCH_STATE_DIR in its environment.
//
// Linux exposes argv and environ through /proc. macOS has no /proc; there `ps`
// reads the same kernel data (KERN_PROCARGS2), and `ps -E` appends the
// environment to the command line.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const hasProc = process.platform === 'linux';

/** Every process as [pid, argv], where argv may be approximate off Linux
 *  (`ps` joins it with spaces, so an argument with a space in it splits). */
function allProcesses(): { pid: number; argv: string[] }[] {
  if (hasProc) {
    const out: { pid: number; argv: string[] }[] = [];
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        out.push({ pid: Number(d), argv: readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0') });
      } catch { /* vanished */ }
    }
    return out;
  }
  const ps = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' });
  return ps.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), argv: m[2]!.split(' ') }] : [];
  });
}

/**
 * A process's environment as `NAME=value` entries, or null if it is gone or
 * unreadable.
 *
 * Off Linux this comes from `ps -E`, which prints argv and then the
 * environment, all space-joined. The command part (what `ps` prints without
 * -E) is stripped off the front, and the rest split before each `NAME=`. A
 * value that itself contains ` NAME=` would be split wrongly; the variables the
 * tests look at (names, uuids, temp paths) never do.
 */
export function processEnviron(pid: number): string[] | null {
  if (hasProc) {
    try {
      return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);
    } catch {
      return null;
    }
  }
  try {
    const cmd = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).replace(/\n$/, '');
    const withEnv = execFileSync('ps', ['-wwE', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).replace(/\n$/, '');
    if (!withEnv.startsWith(cmd)) return null;
    const rest = withEnv.slice(cmd.length).replace(/^ /, '');
    return rest ? rest.split(/ (?=[A-Za-z_][A-Za-z0-9_]*=)/) : [];
  } catch {
    return null; // ps exits non-zero when the pid is gone
  }
}

/** The pids of daemons running `daemonScript` for this exact state dir. */
export function findDaemons(daemonScript: string, stateDir: string): number[] {
  const want = `PERCH_STATE_DIR=${stateDir}`;
  const pids = new Set<number>();
  for (const { pid, argv } of allProcesses()) {
    if (pid === process.pid || argv[1] !== daemonScript) continue;
    if (processEnviron(pid)?.includes(want)) pids.add(pid);
  }
  // The daemon's own pid file, as a second source: still checked against the
  // script and state dir, since a stale file can name a recycled pid.
  try {
    const pid = Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8').trim());
    if (pid > 1 && !pids.has(pid) && processEnviron(pid)?.includes(want)) {
      const argv = allProcesses().find((p) => p.pid === pid)?.argv;
      if (argv?.[1] === daemonScript) pids.add(pid);
    }
  } catch { /* no pid file */ }
  return [...pids];
}

/** SIGKILL every daemon running `daemonScript` for this exact state dir. */
export function killDaemons(daemonScript: string, stateDir: string): void {
  for (const pid of findDaemons(daemonScript, stateDir)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// Linux and macOS. Linux reads /proc; macOS has no /proc, so process facts
// come from ps and lsof there.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, linkSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from './types.ts';

const isLinux = process.platform === 'linux';

function run(cmd: string, args: string[]): string {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; }
}

export const posix: Platform = {
  socketAddress: (stateDir) => join(stateDir, 'daemon.sock'),

  // sun_path in sockaddr_un caps unix socket paths at ~104-108 bytes; past
  // that, listen() fails with an opaque EINVAL. Say so up front instead.
  addressProblem: (address) =>
    address.length > 100
      ? `socket path ${address} exceeds the unix socket path limit (~104 bytes); set PERCH_STATE_DIR to a shorter path`
      : null,

  clearStaleAddress: (address) => {
    try { unlinkSync(address); } catch { /* ENOENT: nothing stale */ }
  },

  secureAddress: (address) => {
    try { chmodSync(address, 0o600); } catch { /* fs without chmod support */ }
  },

  /**
   * Pid-file lock via write-temp-then-link(2): link is atomic AND the target
   * appears with its content already complete, so a concurrent starter can
   * never observe a half-written pid file, mistake it for stale, and unlink a
   * live winner's lock.
   */
  acquireLock: (lockPath, isLiveDaemon) => {
    const tmp = `${lockPath}.${process.pid}.tmp`;
    writeFileSync(tmp, String(process.pid));
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          linkSync(tmp, lockPath);
          return true;
        } catch {
          let pid = NaN;
          try { pid = Number(readFileSync(lockPath, 'utf8').trim()); } catch { continue; /* vanished; retry */ }
          if (Number.isFinite(pid) && pid > 1 && pid !== process.pid && isLiveDaemon(pid)) return false;
          try { unlinkSync(lockPath); } catch { /* lost a race; retry */ }
        }
      }
      return false;
    } finally {
      try { unlinkSync(tmp); } catch { /* best effort */ }
    }
  },

  isDaemonProcess: (pid, entryPath) => {
    if (isLinux) {
      try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(entryPath); } catch { return false; }
    }
    return run('ps', ['-o', 'command=', '-p', String(pid)]).includes(entryPath);
  },

  spawnDetached: (execPath, args, env) => {
    spawn(execPath, args, { detached: true, stdio: 'ignore', env: env ?? process.env }).unref();
  },

  terminate: (pid) => {
    process.kill(pid, 'SIGTERM');
  },

  onStopRequest: (cb) => {
    process.on('SIGTERM', cb);
    process.on('SIGINT', cb);
  },

  // A window's shell leads its own process group (node-pty calls setsid), so
  // signalling the negative pid reaches everything it started.
  hangUpTree: (pid) => {
    if (pid <= 1) return; // never signal group 0 or 1
    try { process.kill(-pid, 'SIGHUP'); } catch { /* group already gone */ }
  },

  killTree: (pid) => {
    if (pid <= 1) return;
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  },

  childPids: (pid) => {
    if (isLinux) {
      try {
        return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
      } catch { return []; }
    }
    return run('pgrep', ['-P', String(pid)]).split('\n').filter(Boolean).map(Number).sort((a, b) => a - b);
  },

  processName: (pid) => {
    if (isLinux) {
      try {
        const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
        // comm is the THREAD name, and Node renames its main thread: every
        // Node program on the box reads "node-MainThread" (Electron and some
        // Python runtimes do the same with a bare "MainThread"). The program
        // it is actually running is argv[0].
        if (!/(^|-)MainThread$/.test(comm)) return comm;
        const argv0 = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0];
        return argv0 ? argv0.split('/').pop() || comm : comm;
      } catch { return undefined; }
    }
    const comm = run('ps', ['-o', 'comm=', '-p', String(pid)]).trim();
    return comm ? comm.split('/').pop()!.replace(/^-/, '') : undefined;
  },

  cwdOf: (pid) => {
    if (isLinux) {
      try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
    }
    const line = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : null;
  },

  defaultShell: () => process.env.SHELL ?? '/bin/bash',

  onTerminalResize: (cb) => {
    process.on('SIGWINCH', cb);
  },

  rawReplaySafe: true,
};

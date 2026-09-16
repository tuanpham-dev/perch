import type { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { connectOrSpawn, tryConnect } from '../client/connection.ts';
import type { StatusInfo } from '../protocol/messages.ts';
import { daemonEntryPath, pidPath } from '../util/paths.ts';
import { platform } from '../platform/index.ts';
import { installBootHook, uninstallBootHook, bootHookStatus } from '../daemon/boot-hook.ts';

function readPidFile(): number | null {
  try {
    const pid = Number(readFileSync(pidPath(), 'utf8').trim());
    return Number.isFinite(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

/** True only when the recorded pid is alive AND is actually a perch daemon. */
function pidIsLiveDaemon(pid: number): boolean {
  return platform.isDaemonProcess(pid, daemonEntryPath());
}

export function registerDaemonCommands(program: Command): void {
  const daemon = program.command('daemon').description('control the terminal daemon');

  daemon
    .command('start')
    .description('start the daemon (and restore saved sessions) if not already running')
    .option('--no-cmd', 'restore layout and scrollback but do not re-run declared commands')
    .option('-q, --quiet', 'print nothing on success')
    .action(async (opts: { cmd: boolean; quiet?: boolean }) => {
      const conn = await connectOrSpawn(opts.cmd ? [] : ['--no-cmd']);
      try {
        const status = await conn.request({ kind: 'daemon.status' }) as StatusInfo;
        if (!opts.quiet) {
          console.log(`daemon running (pid ${status.pid}, ${status.sessions} session${status.sessions === 1 ? '' : 's'})`);
        }
      } finally {
        conn.close();
      }
    });

  daemon
    .command('status')
    .description('report whether the daemon is running (liveness = the socket answers, never the pid file)')
    .action(async () => {
      const conn = await tryConnect();
      if (conn) {
        try {
          const s = await conn.request({ kind: 'daemon.status' }) as StatusInfo;
          const up = Math.floor((Date.now() - s.startedAt) / 1000);
          console.log(`running: pid ${s.pid}, ${s.sessions} sessions, ${s.windows} windows, up ${up}s`);
        } finally {
          conn.close();
        }
        return;
      }
      const pid = readPidFile();
      if (pid !== null && !pidIsLiveDaemon(pid)) console.log('not running (stale pid file)');
      else if (pid !== null) console.log('not running (socket dead; pid file points at an unresponsive daemon)');
      else console.log('not running');
      process.exitCode = 1;
    });

  daemon
    .command('install')
    .description('install a boot hook so the daemon (and your sessions) come back after a reboot')
    .action(() => {
      const r = installBootHook();
      console.log(`installed ${r.mechanism} autostart: ${r.detail}`);
    });

  daemon
    .command('uninstall')
    .description('remove the boot hook installed by `perch-mux daemon install`')
    .action(() => {
      const removed = uninstallBootHook();
      console.log(removed.length ? `removed: ${removed.join(', ')}` : 'no boot hook was installed');
    });

  daemon
    .command('hook-status')
    .description('show whether a boot hook is installed')
    .action(() => {
      console.log(bootHookStatus());
    });

  daemon
    .command('stop')
    .description('snapshot state and stop the daemon (sessions restore on the next perch-mux command)')
    .action(async () => {
      const conn = await tryConnect();
      if (conn) {
        try { await conn.request({ kind: 'daemon.stop' }); } catch { /* daemon exits mid-reply */ }
        conn.close();
        console.log('stopped');
        return;
      }
      const pid = readPidFile();
      if (pid !== null && pidIsLiveDaemon(pid)) {
        // Socket is dead but the process provably is our daemon: signal it.
        platform.terminate(pid);
        console.log(`asked unresponsive daemon (pid ${pid}) to stop`);
        return;
      }
      // Never signal a pid we cannot prove is ours (post-reboot pid reuse).
      if (pid !== null) console.log('not running (stale pid file left alone)');
      else console.log('not running');
    });
}

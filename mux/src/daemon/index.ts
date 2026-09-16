// The terminal daemon. Spawned detached by any `perch-mux` command when no daemon
// answers the socket; owns every PTY; exits when the last session is killed.
import { appendFileSync, existsSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { loadConfig, type Config } from '../util/config.ts';
import { daemonEntryPath, ensureStateDirs, logPath, pidPath, socketPath } from '../util/paths.ts';
import { platform } from '../platform/index.ts';
import { DaemonServer } from './server.ts';
import { Snapshotter } from './persistence.ts';
import { restoreSessions } from './restore.ts';

const noCmd = process.argv.includes('--no-cmd');

ensureStateDirs();
// Synchronous appends: a crashing daemon must not lose its final log lines
// to stream buffering when process.exit() fires.
function log(msg: string): void {
  try { appendFileSync(logPath(), `${new Date().toISOString()} [${process.pid}] ${msg}\n`); } catch { /* logging never kills the daemon */ }
}
// Config warnings and stray library output belong in the log, not a client tty.
console.log = (...args: unknown[]) => log(args.map(String).join(' '));
console.error = (...args: unknown[]) => log(args.map(String).join(' '));

function probeSocket(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(socketPath());
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.once('error', () => { clearTimeout(t); resolve(false); });
  });
}

const addressProblem = platform.addressProblem(socketPath());
if (addressProblem) {
  log(addressProblem);
  process.exit(1);
}

if (!platform.acquireLock(pidPath(), (pid) => platform.isDaemonProcess(pid, daemonEntryPath()))) {
  log('another daemon holds the pid lock; exiting');
  process.exit(0);
}

if (existsSync(socketPath()) && await probeSocket(300)) {
  // A listener without the pid lock shouldn't exist; defer to it anyway.
  log('socket is unexpectedly live despite a free pid lock; exiting');
  try { unlinkSync(pidPath()); } catch { /* not ours to fret over */ }
  process.exit(0);
}
platform.clearStaleAddress(socketPath());

let config: Config = loadConfig({}, log);
let shuttingDown = false;

const server = new DaemonServer(config, {
  snapshotNow: () => snapshotter.now(),
  scheduleSnapshot: () => snapshotter.schedule(),
  reloadConfig: () => { config = loadConfig({}, log); return config; },
  shutdown,
  log,
});

const snapshotter = new Snapshotter(
  server.store,
  () => config.persistScrollbackLines,
  () => config.snapshotDebounceMs,
  () => server.notifyUrl,
  () => config.persistScrollback,
);

// Rebuild the tree BEFORE accepting clients, so the first `sp ls` already sees
// restored sessions. Runs against server.store, which listen() then serves.
try {
  if (config.restore) restoreSessions(server, config, !noCmd, log);
  else log('restore is off; starting empty');
} catch (err) {
  log(`restore failed, starting empty: ${String(err)}`);
}

function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try { snapshotter.now(); } catch (err) { log(`snapshot during shutdown failed: ${String(err)}`); }
  server.killAllWindows();
  server.close();
  platform.clearStaleAddress(socketPath());
  try { unlinkSync(pidPath()); } catch { /* already gone */ }
  log(`daemon exiting, code=${code}`);
  process.exit(code);
}

platform.onStopRequest(() => shutdown(0));
process.on('uncaughtException', (err) => {
  log(`uncaught exception: ${err.stack ?? String(err)}`);
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  log(`unhandled rejection: ${String(reason)}`);
  shutdown(1);
});

server.listen(socketPath(), () => {
  platform.secureAddress(socketPath());
  log(`daemon listening on ${socketPath()}${noCmd ? ' (declared commands suppressed)' : ''}`);
});

export { noCmd };

// The service and lifecycle commands: run, start, stop, restart, status,
// instances, logs, enable, disable, update, path, and the terminal daemon
// passthroughs.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseInstanceFlags, writeEnvValues } from './envFile.ts';
import {
  backgroundStart, backgroundStop, instanceOnPort, listInstances, pidFileOf, stopInstance, envOf, type Instance,
} from './instances.ts';
import { ask, die, Exit, fail, green, heading, info, interactive, ok, red, table, warn } from './output.ts';
import { appUrl, ENV_FILE, LOG_FILE, logFileForPort, PID_FILE, pidFileForPort, readPort, REPO_DIR } from './paths.ts';
import { inherit, output, responding } from './run.ts';
import { usableServiceManager } from './serviceManager.ts';
import { enableLinger } from './systemd.ts';

// ---- run ------------------------------------------------------------------

/**
 * Runs the server in the foreground (what the service starts). npm spawns
 * nested processes rather than replacing itself, so npm is started in its own
 * process group and a stop signals that whole group; this process then exits
 * with npm's status. The terminal daemon the server starts runs in a session
 * of its own and is not part of that group, so it keeps running.
 */
export function cmdRun(): Promise<never> {
  return new Promise(() => {
    const windows = process.platform === 'win32';
    // Windows has no process groups to signal: npm runs through a shell (it's
    // a .cmd there) and the tree is ended with taskkill instead.
    const child = spawn('npm', ['start'], { cwd: REPO_DIR, stdio: 'inherit', detached: !windows, shell: windows });
    let stopping = false;
    const killTree = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      if (windows) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else try { process.kill(-child.pid, signal); } catch { /* already gone */ }
    };
    const stop = (signal: NodeJS.Signals) => {
      if (stopping || !child.pid) return;
      stopping = true;
      killTree(signal);
      const escalate = setTimeout(() => killTree('SIGKILL'), 10_000);
      escalate.unref();
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGHUP', () => stop('SIGTERM'));
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    child.on('error', (err) => {
      fail(`could not run npm: ${err.message}`);
      process.exit(1);
    });
  });
}

// ---- start / restart --------------------------------------------------------

const START_USAGE = `Usage: perch start [flags]
       perch restart [flags]

Flags (all optional; each maps to the matching server config - see README):
  --port <n>                Port to listen on (env: PORT, default 3001)
  --app-name <name>         Browser tab / PWA name (env: APP_NAME)
  --allowed-hosts <list>    Comma-separated hostnames to accept (env: ALLOWED_HOSTS)
  --auth-token <token>      Shared-secret gate (env: AUTH_TOKEN) - prefer
                            setting this in server/.env instead; a flag is
                            visible in \`ps\` output and shell history.
  --new-session-cwd <path>  Working directory for new sessions (env: NEW_SESSION_CWD)
  --proxy-domain <list>     Comma-separated domains for subdomain port
                            proxying, e.g. "example.com" routes
                            <port>.example.com to that local port
                            (env: PROXY_DOMAIN) - requires wildcard DNS
                            and, behind HTTPS, wildcard TLS

Both \`--flag value\` and \`--flag=value\` are accepted.

With no flags: uses the system service (systemd or launchd) if available,
else runs one instance in the background using server/.env or its defaults.
\`perch restart\` with no flags and no system service restarts every
background instance it started, each with the port and config it was
started with (or starts one if none is running).

With flags and a system service: the flags are written into server/.env and
the service is restarted, so they persist across future restarts.

With flags and no system service: starts an additional one-off background
instance on the given port, alongside anything already running (refuses if
that port is already taken). Use \`perch instances\` to see everything
running.`;

async function startAdhoc(values: Record<string, string>): Promise<void> {
  const port = values.PORT ?? readPort();
  const existing = instanceOnPort(port);
  if (existing) die(`an instance is already running on port ${port} (pid ${existing.pid}) - stop it first or choose a different --port`);
  if (!(await backgroundStart(port, pidFileForPort(port), logFileForPort(port), values))) throw new Exit(1);
}

export async function cmdStart(args: string[]): Promise<void> {
  const flags = parseInstanceFlags(args);
  if (flags.help) return info(START_USAGE);
  const given = Object.keys(flags.values).length > 0;
  const manager = usableServiceManager();
  if (manager) {
    manager.install();
    if (given) {
      writeEnvValues(ENV_FILE, flags.values);
      manager.restart();
      ok(`applied flags to server/.env and restarted via ${manager.kind} - ${appUrl()}`);
    } else {
      manager.start();
      ok(`started via ${manager.kind} - ${appUrl()}`);
    }
    return;
  }
  if (given) return startAdhoc(flags.values);
  if (!(await backgroundStart(readPort()))) throw new Exit(1);
}

export async function cmdRestart(args: string[]): Promise<void> {
  const flags = parseInstanceFlags(args);
  if (flags.help) return info(START_USAGE);
  const given = Object.keys(flags.values).length > 0;
  const manager = usableServiceManager();
  if (manager) {
    manager.install();
    if (given) writeEnvValues(ENV_FILE, flags.values);
    manager.restart();
    ok(`restarted via ${manager.kind} - ${appUrl()}`);
    return;
  }
  if (given) {
    const existing = instanceOnPort(flags.values.PORT ?? readPort());
    if (existing) await stopInstance(existing);
    return startAdhoc(flags.values);
  }
  // The same restart `perch update` does: every background instance comes
  // back with the pid file, log file and config it was started with, so an
  // instance started as `perch start --port 8044` is not replaced by one on
  // the default port with server/.env's settings.
  if (await restartBackgroundInstances()) return;
  await backgroundStop(PID_FILE);
  if (!(await backgroundStart(readPort()))) throw new Exit(1);
  info(DAEMON_HINT);
}

const DAEMON_HINT = 'Terminals keep running on the previous terminal daemon until it restarts: perch daemon stop (sessions come back).';

/** Restarts every background instance this CLI manages, each with the pid
 *  file, log file and config it was started with. False when none was running. */
async function restartBackgroundInstances(): Promise<boolean> {
  let restarted = false;
  for (const instance of listInstances()) {
    if (instance.managedBy !== 'fallback') continue;
    const pidFile = pidFileOf(instance) ?? pidFileForPort(instance.port);
    const logFile = pidFile === PID_FILE ? LOG_FILE : logFileForPort(instance.port);
    const env: Record<string, string> = { PORT: instance.port };
    for (const name of ['APP_NAME', 'ALLOWED_HOSTS', 'AUTH_TOKEN', 'NEW_SESSION_CWD', 'PROXY_DOMAIN', 'PERCH_CONFIG_DIR', 'PERCH_STATE_DIR']) {
      const value = envOf(instance.pid, name);
      if (value) env[name] = value;
    }
    await stopInstance(instance);
    await backgroundStart(instance.port, pidFile, logFile, env);
    restarted = true;
  }
  if (restarted) info(DAEMON_HINT);
  return restarted;
}

// ---- stop -------------------------------------------------------------------

const STOP_USAGE = `Usage: perch stop [--port <n>] [--all] [--help]

With no flags: stops the only running instance - or, if more than one is
running, shows a numbered list and asks which one(s) to stop.

  --port <n>   Stop only the instance running on this port (no prompt).
  --all        Stop every running instance (no prompt).

Terminals keep running: they live in the terminal daemon. To stop them too,
run: perch daemon stop`;

export function printInstanceList(instances: Instance[]): void {
  heading('Running instances');
  table(
    [['#', 'PID', 'PORT', 'APP_NAME', 'MANAGED BY'], ...instances.map((i, n) => [String(n + 1), String(i.pid), i.port, i.appName, i.managedBy])],
    [4, 8, 6, 22],
  );
}

export const instanceSummary = (i: Instance) => `  pid ${i.pid}  port ${i.port}  ${i.appName}  (${i.managedBy})`;

export async function cmdStop(args: string[]): Promise<void> {
  let port = '';
  let all = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') return info(STOP_USAGE);
    else if (arg === '--all') all = true;
    else if (arg.startsWith('--port=')) port = arg.slice('--port='.length);
    else if (arg === '--port') {
      if (i + 1 >= args.length) die('--port requires a value');
      port = args[++i]!;
    } else die(`unknown flag: ${arg}`);
  }

  const instances = listInstances();
  if (instances.length === 0) return info('not running');

  if (port) {
    const match = instances.find((i) => i.port === port);
    if (!match) die(`no instance running on port ${port}`);
    return stopInstance(match);
  }
  if (all) {
    for (const i of instances) await stopInstance(i);
    return;
  }
  if (instances.length === 1) {
    const only = instances[0]!;
    if (only.managedBy !== 'external') return stopInstance(only);
    // Not something Perch started (e.g. npm run dev): confirm rather
    // than treating "only one thing is running" as consent.
    if (!interactive()) {
      warn(`the only running instance looks external (not started via Perch): pid ${only.pid} port ${only.port} ${only.appName} - re-run with --port ${only.port} or --all to confirm`);
      throw new Exit(1);
    }
    const answer = await ask(`The only running instance is external (pid ${only.pid}, port ${only.port}, ${only.appName}) - not something Perch started. Stop it anyway? [y/N]: `);
    if (/^y$/i.test(answer)) return stopInstance(only);
    return info('cancelled');
  }
  if (!interactive()) {
    warn('more than one instance is running; re-run with --port <n> or --all:');
    instances.forEach((i) => info(instanceSummary(i)));
    throw new Exit(1);
  }
  printInstanceList(instances);
  const choice = await ask(`Stop which instance? [1-${instances.length}/a=all/q=cancel]: `);
  if (choice === '' || /^q$/i.test(choice)) return info('cancelled');
  if (/^a$/i.test(choice)) {
    for (const i of instances) await stopInstance(i);
    return;
  }
  const n = Number(choice);
  if (!Number.isInteger(n) || n < 1 || n > instances.length) die(`invalid choice: ${choice}`);
  await stopInstance(instances[n - 1]!);
}

// ---- status / instances / logs ------------------------------------------------

export async function cmdInstances(): Promise<void> {
  const instances = listInstances();
  if (instances.length === 0) return info('no running instances found');
  const rows = [['PID', 'PORT', 'APP_NAME', 'MANAGED BY', 'STATUS']];
  for (const i of instances) {
    rows.push([String(i.pid), i.port, i.appName, i.managedBy, (await responding(i.port)) ? green('responding') : red('not responding')]);
  }
  table(rows, [8, 6, 22, 10]);
}

export async function cmdStatus(): Promise<void> {
  const manager = usableServiceManager();
  if (manager?.installed()) manager.printStatus();
  else {
    const pid = (await import('./instances.ts')).runningPid(PID_FILE);
    info(pid ? `running in the background (pid ${pid})` : 'not running');
  }
  heading('Instances');
  await cmdInstances();
  heading('Terminal daemon');
  daemonCli(['daemon', 'status']);
}

export function cmdLogs(): void {
  const manager = usableServiceManager();
  if (manager?.installed()) return manager.followLogs();
  if (existsSync(LOG_FILE)) {
    if (process.platform === 'win32') inherit('powershell.exe', ['-NoProfile', '-Command', `Get-Content -Tail 50 -Wait -Path '${LOG_FILE}'`]);
    else inherit('tail', ['-n', '50', '-f', LOG_FILE]);
    return;
  }
  info('no logs yet - nothing has been started in the background');
}

// ---- enable / disable -----------------------------------------------------------

export function cmdEnable(): void {
  const manager = usableServiceManager();
  if (!manager) die('no system service manager (systemd user session or launchd) available on this system');
  manager.install();
  manager.enable();
  ok('enabled and started - will start on login');
  if (manager.kind === 'systemd') {
    const user = output('whoami', []);
    if (enableLinger()) ok('linger enabled - will also start on boot, before login');
    else warn(`couldn't enable linger automatically - run this to start on boot without logging in: loginctl enable-linger ${user}`);
  }
}

export function cmdDisable(): void {
  const manager = usableServiceManager();
  if (!manager) return info('no system service manager - nothing to disable');
  manager.disable();
  ok('disabled');
}

// ---- update -------------------------------------------------------------------

export async function cmdUpdate(): Promise<void> {
  info(`updating ${REPO_DIR}...`);
  // A dirty checkout breaks the pull: tracked edits make --ff-only refuse,
  // and untracked files block incoming commits that add them. Offer to
  // discard, but only on an explicit interactive "y" - with no terminal the
  // update aborts, so automation can't silently wipe local changes. Ignored
  // files (node_modules, dist) survive: clean without -x leaves them alone.
  const dirty = output('git', ['-C', REPO_DIR, 'status', '--porcelain']);
  if (dirty) {
    warn('repo has local changes:');
    dirty.split('\n').forEach((l) => info(`  ${l}`));
    const reply = await ask('Discard them and continue? [y/N] ');
    if (!/^(y|yes)$/i.test(reply)) die(`aborting - clean up ${REPO_DIR} (or re-run and answer y) then: perch update`);
    inherit('git', ['-C', REPO_DIR, 'reset', '--hard', 'HEAD']);
    inherit('git', ['-C', REPO_DIR, 'clean', '-fd']);
    ok('cleaned');
  }
  if (inherit('git', ['-C', REPO_DIR, 'pull', '--ff-only']) !== 0) die('git pull failed');
  if (inherit('npm', ['install'], REPO_DIR) !== 0) die('npm install failed');
  if (inherit('npm', ['run', 'build'], REPO_DIR) !== 0) die('npm run build failed');
  ok('updated');

  const manager = usableServiceManager();
  if (manager?.installed() && manager.active()) {
    manager.install();
    manager.restart();
    ok('restarted');
    return;
  }
  if (!(await restartBackgroundInstances())) info('no running background instance found - nothing to restart');
}

export const cmdPath = () => info(REPO_DIR);

// ---- terminal daemon ------------------------------------------------------------

/** Runs the terminal daemon's own CLI (mux/src/cli.ts) with the terminal attached. */
export function daemonCli(args: string[]): number {
  const r = spawnSync(process.execPath, [join(REPO_DIR, 'mux', 'src', 'cli.ts'), ...args], { stdio: 'inherit' });
  return r.status ?? 1;
}

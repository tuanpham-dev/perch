// Perch CLI - start/stop/status/logs/update/doctor for an install, plus
// the terminal daemon's commands. Lives inside the cloned repo, so `update`
// updates the CLI along with everything else.
import { existsSync } from 'node:fs';
import {
  cmdDisable, cmdEnable, cmdInstances, cmdLogs, cmdPath, cmdRestart, cmdRun, cmdStart, cmdStatus, cmdStop, cmdUpdate, daemonCli,
} from './commands.ts';
import { cmdDoctor } from './doctor.ts';
import { cmdExt } from './extensions.ts';
import { cmdOpen } from './open.ts';
import { cmdSettings } from './settings.ts';
import { Exit, fail, info } from './output.ts';

const HELP = `perch - manage a Perch install

Usage: perch <command> [flags]

Commands:
  start      Start the server (via systemd or launchd if available, else in the background)
             Accepts config flags - see: perch start --help
  stop       Stop the server - asks which instance if more than one is running
             (see: perch stop --help)
  restart    Restart the server (accepts the same flags as start)
  status     Show whether it's running and responding
  instances  List every running instance (any port, any launch method)
  logs       Follow the server's logs
  enable     Install + enable the system service (starts on login/boot)
  disable    Disable the system service
  update     Pull the latest code, reinstall, rebuild, and restart
  doctor     Check dependencies, install health, and troubleshoot problems
  run        Run in the foreground (used internally by the system service)
  open       Open a folder or file in the app, like \`code\`/\`code-server\`
             (see: perch open --help); a bare \`perch <path>\`
             does the same
  ext        Install and manage extensions: install, ls, uninstall,
             enable, disable (see: perch ext --help)
  settings   Export settings to a shareable file, or import one
             (see: perch settings --help)
  ls         List terminal sessions
  attach     Attach this terminal to a session or window (e.g. perch attach work)
  daemon     Terminal daemon: status, start, stop (stopping ends every terminal;
             sessions come back on the next start)
  path       Print the install directory
  help       Show this help`;

async function main(argv: string[]): Promise<void> {
  const [cmd = 'help', ...rest] = argv;
  switch (cmd) {
    case 'run': return cmdRun();
    case 'start': return cmdStart(rest);
    case 'stop': return cmdStop(rest);
    case 'restart': return cmdRestart(rest);
    case 'status': return cmdStatus();
    case 'instances': return cmdInstances();
    case 'logs': return cmdLogs();
    case 'enable': return cmdEnable();
    case 'disable': return cmdDisable();
    case 'update': return cmdUpdate();
    case 'doctor': return cmdDoctor();
    case 'open': return cmdOpen(rest);
    case 'ext': return cmdExt(rest);
    case 'settings': return cmdSettings(rest);
    case 'path': return cmdPath();
    case 'ls':
    case 'attach':
    case 'daemon': {
      const status = daemonCli([cmd, ...rest]);
      if (status !== 0) throw new Exit(status);
      return;
    }
    case 'help':
    case '-h':
    case '--help':
      return info(HELP);
    default:
      // `perch <path>` is `perch open <path>`, but only when it
      // looks like one, so a mistyped command still says so.
      if (existsSync(cmd) || cmd === '.' || cmd === '..') return cmdOpen([cmd, ...rest]);
      fail(`unknown command: ${cmd}`);
      info(HELP);
      throw new Exit(1);
  }
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof Exit) process.exit(err.code);
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

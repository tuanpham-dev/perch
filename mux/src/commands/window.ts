import type { Command } from 'commander';
import { resolve } from 'node:path';
import { withConn } from '../client/connection.ts';
import type { WindowInfo } from '../protocol/messages.ts';
import { formatTable } from './helpers.ts';

export function registerWindowCommands(program: Command): void {
  const window = program.command('window').description('manage windows within a session');

  window
    .command('new')
    .description('create a window (prints its target); becomes the current window')
    .option('-t, --session <session>', 'session to add the window to (default: the only session)')
    .option('-n, --name <name>', 'window name')
    .option('-c, --command <cmd>', 'declared command: typed into the window now and re-run after a reboot')
    .option('-d, --dir <dir>', 'working directory', process.cwd())
    .action(async (opts: { session?: string; name?: string; command?: string; dir: string }) => {
      const data = await withConn((c) =>
        c.request({ kind: 'window.new', session: opts.session, name: opts.name, command: opts.command, cwd: resolve(opts.dir) }),
      ) as { session: string; index: number };
      console.log(`${data.session}:${data.index}`);
    });

  window
    .command('ls')
    .description('list windows in a session')
    .option('-t, --session <session>', 'session to list (default: the only session)')
    .option('-j, --json', 'JSON output')
    .action(async (opts: { session?: string; json?: boolean }) => {
      const list = await withConn((c) => c.request({ kind: 'window.list', session: opts.session })) as WindowInfo[];
      if (opts.json) { console.log(JSON.stringify(list, null, 2)); return; }
      const rows = [['IDX', 'NAME', 'CUR', 'PID', 'RUNNING', 'CWD', 'COMMAND']];
      for (const w of list) {
        rows.push([String(w.index), w.name, w.current ? '*' : '', String(w.pid), w.foregroundCommand ?? '', w.cwd, w.command ?? '']);
      }
      console.log(formatTable(rows));
    });

  window
    .command('select <target>')
    .description('make a window current (target: sess:index or sess:name); attached clients switch live')
    .action(async (target: string) => {
      await withConn((c) => c.request({ kind: 'window.select', target }));
    });

  window
    .command('next')
    .description('switch to the next window (wraps)')
    .option('-t, --session <session>', 'session (default: the only session)')
    .action(async (opts: { session?: string }) => {
      await withConn((c) => c.request({ kind: 'window.next', session: opts.session }));
    });

  window
    .command('prev')
    .description('switch to the previous window (wraps)')
    .option('-t, --session <session>', 'session (default: the only session)')
    .action(async (opts: { session?: string }) => {
      await withConn((c) => c.request({ kind: 'window.prev', session: opts.session }));
    });

  window
    .command('rename <target> <new>')
    .description('rename a window')
    .action(async (target: string, to: string) => {
      await withConn((c) => c.request({ kind: 'window.rename', target, to }));
    });

  window
    .command('reset-name <target>')
    .description('let the window name follow the running command again')
    .action(async (target: string) => {
      await withConn((c) => c.request({ kind: 'window.resetName', target }));
    });

  window
    .command('kill <target>')
    .description('kill a window and every process in it')
    .action(async (target: string) => {
      await withConn((c) => c.request({ kind: 'window.kill', target }));
    });
}

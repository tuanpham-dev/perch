import type { Command } from 'commander';
import { resolve } from 'node:path';
import { withConn } from '../client/connection.ts';
import type { SessionInfo } from '../protocol/messages.ts';
import { formatTable, timeAgo } from './helpers.ts';
import { runAttach } from '../client/attach.ts';

export function registerSessionCommands(program: Command): void {
  program
    .command('new [name]')
    .description('create a detached session (prints its name)')
    .option('-c, --command <cmd>', 'declared command: typed into the first window now and re-run after a reboot')
    .option('-d, --dir <dir>', 'working directory for the first window', process.cwd())
    .action(async (name: string | undefined, opts: { command?: string; dir: string }) => {
      const data = await withConn((c) =>
        c.request({ kind: 'session.new', name, command: opts.command, cwd: resolve(opts.dir) }),
      ) as { name: string };
      console.log(data.name);
    });

  program
    .command('ls')
    .description('list sessions')
    .option('-j, --json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
      const list = await withConn((c) => c.request({ kind: 'session.list' })) as SessionInfo[];
      if (opts.json) { console.log(JSON.stringify(list, null, 2)); return; }
      if (list.length === 0) { console.log('no sessions'); return; }
      const rows = [['NAME', 'WINDOWS', 'ATTACHED', 'CREATED']];
      for (const s of list) rows.push([s.name, String(s.windows), String(s.attached), timeAgo(s.createdAt)]);
      console.log(formatTable(rows));
    });

  program
    .command('attach <session>')
    .description('attach this terminal to a session (detach: press the detach key twice, default Ctrl-\\)')
    .action(async (session: string) => {
      await runAttach(session);
    });

  program
    .command('kill <session>')
    .description('kill a session and every process in its windows')
    .action(async (session: string) => {
      await withConn((c) => c.request({ kind: 'session.kill', session }));
    });

  program
    .command('rename <session> <new>')
    .description('rename a session')
    .action(async (session: string, to: string) => {
      await withConn((c) => c.request({ kind: 'session.rename', session, to }));
    });
}

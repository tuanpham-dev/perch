import type { Command } from 'commander';
import { withConn } from '../client/connection.ts';

export function registerIoCommands(program: Command): void {
  program
    .command('capture <target>')
    .description("print a window's screen as plain text (target: sess, sess:index, or sess:name)")
    .option('-S, --scrollback <lines>', 'include this many lines of history above the screen', '0')
    .action(async (target: string, opts: { scrollback: string }) => {
      const data = await withConn((c) =>
        c.request({ kind: 'io.capture', target, scrollback: Number(opts.scrollback) || 0 }),
      ) as { text: string };
      console.log(data.text);
    });

  program
    .command('send <target> <keys...>')
    .description('type keystrokes into a window')
    .option('-e, --enter', 'press Enter afterwards')
    .action(async (target: string, keys: string[], opts: { enter?: boolean }) => {
      const data = keys.join(' ') + (opts.enter ? '\r' : '');
      await withConn((c) => c.request({ kind: 'io.send', target, data }));
    });
}

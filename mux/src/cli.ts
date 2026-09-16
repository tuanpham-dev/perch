#!/usr/bin/env node
import { Command } from 'commander';
import { registerSessionCommands } from './commands/session.ts';
import { registerWindowCommands } from './commands/window.ts';
import { registerIoCommands } from './commands/io.ts';
import { registerDaemonCommands } from './commands/daemon-ctl.ts';
import { registerConfigCommands } from './commands/config-cmd.ts';

const program = new Command();
program
  .name('perch-mux')
  .description('persistent terminal sessions: a tmux-lite that survives reboots')
  .version('0.1.0');

registerSessionCommands(program);
registerWindowCommands(program);
registerIoCommands(program);
registerDaemonCommands(program);
registerConfigCommands(program);

try {
  await program.parseAsync(process.argv);
} catch (err) {
  console.error(`perch-mux: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

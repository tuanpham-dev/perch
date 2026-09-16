import type { Command } from 'commander';
import { CONFIG_KEYS, envName, loadConfig, setConfigKey } from '../util/config.ts';
import { configPath } from '../util/paths.ts';
import { tryConnect } from '../client/connection.ts';
import { formatTable } from './helpers.ts';

export function registerConfigCommands(program: Command): void {
  const config = program.command('config').description('view and change terminal daemon settings');

  config
    .command('list')
    .description('show effective settings (flags > env > config.json > defaults)')
    .action(() => {
      const cfg = loadConfig();
      const rows = [['KEY', 'VALUE', 'ENV OVERRIDE']];
      for (const key of CONFIG_KEYS) rows.push([key, String(cfg[key]), envName(key)]);
      console.log(formatTable(rows));
    });

  config
    .command('get <key>')
    .description('print one effective setting')
    .action((key: string) => {
      const cfg = loadConfig();
      if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
        throw new Error(`unknown config key ${JSON.stringify(key)} (valid: ${CONFIG_KEYS.join(', ')})`);
      }
      console.log(String(cfg[key as (typeof CONFIG_KEYS)[number]]));
    });

  config
    .command('set <key> <value>')
    .description('write a setting to config.json (a running daemon picks it up immediately)')
    .action(async (key: string, value: string) => {
      setConfigKey(key, value);
      const conn = await tryConnect();
      if (conn) {
        try { await conn.request({ kind: 'daemon.reloadConfig' }); } finally { conn.close(); }
      }
    });

  config
    .command('path')
    .description('print the config file path')
    .action(() => {
      console.log(configPath());
    });
}

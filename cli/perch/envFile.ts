// The start/restart config flags and the server/.env writer they feed.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { die } from './output.ts';

/** Flag name -> the server config variable it sets (see the README). */
export const INSTANCE_FLAGS: Record<string, string> = {
  '--port': 'PORT',
  '--app-name': 'APP_NAME',
  '--allowed-hosts': 'ALLOWED_HOSTS',
  '--auth-token': 'AUTH_TOKEN',
  '--new-session-cwd': 'NEW_SESSION_CWD',
  '--proxy-domain': 'PROXY_DOMAIN',
};

export interface InstanceFlags {
  help: boolean;
  /** Config variable -> value, only for flags that were given. */
  values: Record<string, string>;
}

/** Accepts `--flag value` and `--flag=value`. */
export function parseInstanceFlags(args: string[]): InstanceFlags {
  const out: InstanceFlags = { help: false, values: {} };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const variable = INSTANCE_FLAGS[name];
    if (!variable) die(`unknown flag: ${arg}`);
    if (eq !== -1) {
      out.values[variable] = arg.slice(eq + 1);
    } else {
      if (i + 1 >= args.length) die(`${arg} requires a value`);
      out.values[variable] = args[++i]!;
    }
  }
  return out;
}

/**
 * KEY="value", as Node's process.loadEnvFile reads it. It has no escape for a
 * `"` inside a double-quoted value, so a literal double quote becomes a single
 * one rather than breaking the file.
 */
export function quoteEnvValue(value: string): string {
  return `"${value.replace(/"/g, "'")}"`;
}

/**
 * Sets one KEY in an env file's text: replaces the first `KEY=` line, or
 * appends one. Every other line, comments included, is left as it was.
 */
export function upsertEnvLine(text: string, key: string, value: string): string {
  const line = `${key}=${quoteEnvValue(value)}`;
  const lines = text === '' ? [] : text.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (at !== -1) {
    lines[at] = line;
    return lines.join('\n');
  }
  if (lines.length > 0 && lines.at(-1) === '') lines.pop();
  lines.push(line, '');
  return lines.join('\n');
}

export function writeEnvValues(file: string, values: Record<string, string>): void {
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  for (const [key, value] of Object.entries(values)) text = upsertEnvLine(text, key, value);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

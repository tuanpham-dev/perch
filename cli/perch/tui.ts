// `perch tui` - a terminal UI for a Perch server's projects and terminals:
// pick one and attach full screen, then press the detach key twice to come
// back to the list. Everything goes through the server's HTTP API and attach
// socket, so it works against a remote instance as well as the local one.
import { resolveInstancePort } from './apiClient.ts';
import { RESET_MODES } from './tuiAttach.ts';
import { TuiApp } from './tuiApp.ts';
import { ApiError, PerchClient } from './tuiClient.ts';
import { resolveDetachKey } from './tuiDetach.ts';
import { die, info } from './output.ts';
import { readAuthToken } from './paths.ts';

const USAGE = `Usage: perch tui [--url <url> | --port <n>] [--token <token>] [--detach-key C-<char>]

A terminal UI for Perch's projects and terminals. Pick a terminal and press
Enter to attach to it full screen; press the detach key twice to come back.

  --url <url>          Server to connect to, e.g. https://perch.example.com
                       (default: the local instance - see --port)
  --port <n>           Local instance on this port (default: $PERCH_PORT, else
                       whichever instance is running - asking if several are)
  --token <token>      Auth token for a gated server (default: $AUTH_TOKEN,
                       else AUTH_TOKEN in server/.env)
  --detach-key C-<c>   Key to press twice to detach (default: the terminal
                       daemon's detachKey, else Ctrl-\\)

Keys in the list:
  Up/Down j/k  move          Enter  attach        n  new terminal
  Left/Right   collapse      r      rename        x  kill
  /            filter        o      open project  p  pin / unpin
  ?            help          q      quit

Windows support is best-effort.`;

interface TuiFlags {
  url: string;
  port: string;
  token: string;
  detachKey: string;
  help: boolean;
}

export function parseTuiFlags(args: string[]): TuiFlags {
  const flags: TuiFlags = { url: '', port: '', token: '', detachKey: '', help: false };
  const names = { '--url': 'url', '--port': 'port', '--token': 'token', '--detach-key': 'detachKey' } as const;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = (eq > 0 ? arg.slice(0, eq) : arg) as keyof typeof names;
    if (!(name in names)) die(`unknown argument: ${arg}`);
    let value: string;
    if (eq > 0) value = arg.slice(eq + 1);
    else {
      if (i + 1 >= args.length) die(`${name} requires a value`);
      value = args[++i]!;
    }
    flags[names[name]] = value;
  }
  if (flags.url && flags.port) die('use either --url or --port, not both');
  if (flags.url && !/^https?:\/\//.test(flags.url)) die(`--url must start with http:// or https:// (got ${flags.url})`);
  if (flags.detachKey && !/^C-.$/.test(flags.detachKey)) die(`--detach-key must look like C-<char>, e.g. C-] (got ${flags.detachKey})`);
  return flags;
}

export async function cmdTui(args: string[]): Promise<void> {
  const flags = parseTuiFlags(args);
  if (flags.help) return info(USAGE);
  if (!process.stdin.isTTY || !process.stdout.isTTY) die('perch tui needs a terminal (stdin and stdout must both be TTYs)');

  const baseUrl = flags.url || `http://127.0.0.1:${await resolveInstancePort(flags.port)}`;
  const client = new PerchClient(baseUrl, flags.token || process.env.AUTH_TOKEN || readAuthToken());
  const detachKey = resolveDetachKey(flags.detachKey || undefined);

  let initial;
  try {
    const [sessions, projects] = await Promise.all([client.sessions(), client.projects()]);
    initial = { sessions, projects };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      die(`${baseUrl}: ${err.message} - this server has AUTH_TOKEN set; pass it with --token or the AUTH_TOKEN env var`);
    }
    if (err instanceof ApiError && err.status === 0) {
      die(flags.url ? `couldn't reach ${baseUrl}` : `couldn't reach the server at ${baseUrl} - is it running? (perch start)`);
    }
    die(`${baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Whatever ends the process, the terminal goes back the way it was: raw
  // mode off, the normal screen, a visible cursor, no leftover modes.
  const { stdin, stdout } = process;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try { stdin.setRawMode(false); } catch { /* the tty is already gone */ }
    stdout.write(`${RESET_MODES}\x1b[?1049l\x1b[?25h`);
  };
  process.on('exit', restore);
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) {
    process.on(signal, () => {
      restore();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
  const crash = (err: unknown) => {
    restore();
    console.error(`perch tui: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);

  stdin.setRawMode(true);
  stdin.resume();
  await new TuiApp(client, detachKey, initial).run();
  restore();
  process.exit(0);
}

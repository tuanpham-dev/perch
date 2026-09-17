// `perch open [path[:line]] [editor|preview]` - opens a folder as a
// project, or a file in the editor, in every connected browser tab.
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { sep } from 'node:path';
import { resolveInstancePort } from './apiClient.ts';
import { die, info, ok } from './output.ts';

const USAGE = `Usage: perch open [path[:line]] [editor|preview] [--port <n>] [--help]

Opens a folder as a project, or a file in the editor, in every connected
browser tab (like \`code\`/\`code-server\`). With no path, opens the current
directory.

  path[:line]     Folder or file to open - a trailing :N jumps a file to
                   that line (e.g. src/index.ts:42).
  editor|preview   Force the file into the editor (nvim) or its preview
                   viewer, instead of the default click-through behavior.
  --port <n>       Target a specific instance instead of auto-detecting
                   one (default: $PERCH_PORT when run from inside a
                   terminal this app created, else whichever instance is
                   running - prompting if more than one is).

With no browser tab connected, prints a link you can open manually instead.`;

function realpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

export async function cmdOpen(args: string[]): Promise<void> {
  let port = '';
  let target = '.';
  let targetSet = false;
  let action = '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') return info(USAGE);
    if (arg.startsWith('--port=')) port = arg.slice('--port='.length);
    else if (arg === '--port') {
      if (i + 1 >= args.length) die('--port requires a value');
      port = args[++i]!;
    } else if (arg.startsWith('-')) die(`unknown flag: ${arg}`);
    else if (arg === 'editor' || arg === 'preview') {
      if (action) die(`unexpected argument: ${arg}`);
      action = arg;
    } else {
      if (targetSet) die(`unexpected argument: ${arg}`);
      target = arg;
      targetSet = true;
    }
  }

  // A trailing ":N" is a line only when the literal path doesn't exist, so a
  // filename that really contains a colon still opens as-is.
  let abs = realpath(target);
  let line = '';
  const m = /^(.+):(\d+)$/.exec(target);
  if (!abs && m) {
    abs = realpath(m[1]!);
    if (abs) line = m[2]!;
  }
  if (!abs) die(`no such file or directory: ${target}`);

  // --port wins, then $PERCH_PORT, then discovery — shared with every other
  // command that reaches the API (see apiClient.ts's resolveInstancePort).
  port = await resolveInstancePort(port);

  const body = new URLSearchParams({ path: abs });
  if (line) body.set('line', line);
  if (action) body.set('action', action);
  let text: string;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/open-target`, {
      method: 'POST',
      headers: { 'X-Perch-Open': '1' },
      body,
      signal: AbortSignal.timeout(5000),
    });
    text = await res.text();
  } catch {
    die(`couldn't reach the server on port ${port} - is it running? (perch start)`);
  }
  const delivered = /"delivered":(\d+)/.exec(text)?.[1];
  if (delivered === undefined) die(`unexpected response from server on port ${port}: ${text}`);
  if (Number(delivered) > 0) return ok(`opened in ${delivered} connected client(s)`);

  const home = homedir();
  const display = (abs === home ? '~' : abs.startsWith(home + sep) ? `~${abs.slice(home.length)}` : abs).replace(/\\/g, '/');
  let link = `http://127.0.0.1:${port}`;
  if (statSync(abs).isDirectory()) link += `/?folder=${encodeURIComponent(display)}`;
  else {
    link += `/?file=${encodeURIComponent(display)}`;
    if (line) link += `&line=${line}`;
    if (action) link += `&action=${action}`;
  }
  info(`no connected client - open: ${link}`);
}

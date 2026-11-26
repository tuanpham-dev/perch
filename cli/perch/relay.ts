// `perch relay ...` - the relay link's operations from a terminal, against the
// running instance. The Assistant extension's /relay routes own every rule
// (what a name may be, what an invite may do); this file is argument
// handling, secret input, one request per subcommand and printing.
//
// The invite and the admin secret never travel on the command line, where
// `ps` and shell history would keep them: they come from an environment
// variable, from standard input when piped, or from a prompt with echo off.
// `--invite` and `--admin-secret` are therefore unknown flags.
import { resolveInstancePort } from './apiClient.ts';
import { ask, askSecret, die, Exit, info, interactive, ok, table } from './output.ts';
import { readAuthToken } from './paths.ts';

const BASE = '/api/ext/perch.assistant/relay';

// The sentence the create and join screens show too (R52).
export const NOTICE =
  "Machines in this group will be able to read this machine's terminals and type into its AI agents. Change this under Relay → Others may.";

const USAGE = `perch relay - connect this Perch to others through a relay

Usage: perch relay <command> [flags]

Commands:
  create <relay-url>   Start a group on a relay. Needs the relay's admin secret
  join                 Join a group with an invite from one of its machines
  invite               Create an invite (printed once, on stdout)
  invites              List open invites
  revoke <id>          Cancel an invite
  status               Show this machine's relay state
  machines             List the machines in the group
  remove <machine>     Remove a machine and replace the group secret
  rename <name>        Change this machine's name
  label [<label>]      Show or set the label on this machine (--clear removes it)
  permission <level>   What other machines may do here: off, read-only or send
  leave                Leave the group and delete its keys here

Flags:
  --name <n>           create, join: this machine's name (default: the host name)
  --allow-insecure     create, join: accept a relay address without TLS
  --uses <n>           invite: how many machines may join with it (1-20, default 1)
  --expires <time>     invite: 10m, 1h, 24h (default), 7d - or any Nm, Nh, Nd
  --yes, -y            remove, leave: do not ask first
  --clear              label: remove the label
  --port <n>           Target a specific instance instead of auto-detecting one

Secrets are never taken as arguments. The admin secret (create) comes from
$PERCH_RELAY_ADMIN_SECRET, standard input, or a hidden prompt; the invite
(join) from $PERCH_RELAY_INVITE, standard input, or a hidden prompt.`;

export type RelayCommand =
  | 'help' | 'create' | 'join' | 'invite' | 'invites' | 'revoke' | 'status'
  | 'machines' | 'remove' | 'rename' | 'label' | 'permission' | 'leave';

export interface RelayArgs {
  cmd: RelayCommand;
  port: string;
  relayUrl: string;
  name: string;
  allowInsecure: boolean;
  uses?: number;
  expiresMinutes?: number;
  id: string;
  machine: string;
  yes: boolean;
  clear: boolean;
  text: string;
  /** What the server calls it: off, read or send. */
  inbound: string;
}

const COMMANDS: RelayCommand[] = ['create', 'join', 'invite', 'invites', 'revoke', 'status', 'machines', 'remove', 'rename', 'label', 'permission', 'leave'];

// Flags each command accepts besides --port and -h; value flags take a value.
const VALUE_FLAGS: Record<string, string[]> = { create: ['--name'], join: ['--name'], invite: ['--uses', '--expires'] };
const SWITCH_FLAGS: Record<string, string[]> = {
  create: ['--allow-insecure'], join: ['--allow-insecure'], remove: ['--yes', '-y'], leave: ['--yes', '-y'], label: ['--clear'],
};
// Positional words each command takes: [min, max].
const POSITIONALS: Record<string, [number, number, string]> = {
  create: [1, 1, '<relay-url>'], join: [0, 0, ''], revoke: [1, 1, '<id>'], remove: [1, 1, '<machine>'], rename: [1, 1, '<name>'],
  permission: [1, 1, '<off|read-only|send>'], label: [0, 1, '[<label>] (one word: letters, digits, . - _)'],
};

const PERMISSIONS: Record<string, string> = { off: 'off', 'read-only': 'read', send: 'send' };

/** "10m", "1h", "24h", "7d" (any Nm / Nh / Nd) as minutes; dies on anything else. */
export function parseExpiry(text: string): number {
  const m = /^([1-9]\d{0,5})([mhd])$/.exec(text);
  if (!m) die(`invalid --expires: ${text} - use a number with m, h or d, like 10m, 24h or 7d`);
  const minutes = Number(m![1]) * { m: 1, h: 60, d: 1440 }[m![2] as 'm' | 'h' | 'd'];
  if (minutes < 10 || minutes > 10080) die('an invite can last from 10 minutes to 7 days');
  return minutes;
}

/** Pure: arguments to a RelayArgs, dying on anything it doesn't recognise. */
export function parseRelayArgs(args: string[]): RelayArgs {
  const out: RelayArgs = {
    cmd: 'help', port: '', relayUrl: '', name: '', allowInsecure: false, id: '', machine: '', yes: false, clear: false, text: '', inbound: '',
  };
  const [first, ...rest] = args;
  if (first === undefined || first === '-h' || first === '--help' || first === 'help') return out;
  if (!COMMANDS.includes(first as RelayCommand)) die(`unknown relay command: ${first} - see: perch relay --help`);
  const cmd = first as RelayCommand;
  const valueFlags = VALUE_FLAGS[cmd] ?? [];
  const switchFlags = SWITCH_FLAGS[cmd] ?? [];
  const words: string[] = [];
  let uses: string | undefined;
  let expires: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '-h' || arg === '--help') return out;
    if (!arg.startsWith('-') || arg === '-') {
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (flag === '--port' || valueFlags.includes(flag)) {
      let value: string;
      if (eq > 0) value = arg.slice(eq + 1);
      else {
        if (i + 1 >= rest.length) die(`${flag} requires a value`);
        value = rest[++i]!;
      }
      if (flag === '--port') out.port = value;
      else if (flag === '--name') out.name = value;
      else if (flag === '--uses') uses = value;
      else expires = value;
    } else if (switchFlags.includes(flag) && eq < 0) {
      if (flag === '--allow-insecure') out.allowInsecure = true;
      else if (flag === '--clear') out.clear = true;
      else out.yes = true;
    } else die(`unknown flag: ${flag}`);
  }
  const [min, max, shape] = POSITIONALS[cmd] ?? [0, 0, ''];
  if (words.length < min) die(`perch relay ${cmd} needs ${shape}`);
  if (words.length > max) {
    // Never echo the surplus word: for join and create it is probably the secret.
    if (cmd === 'join' || cmd === 'create') {
      die('The invite (or admin secret) is not taken as an argument; use $PERCH_RELAY_INVITE (or $PERCH_RELAY_ADMIN_SECRET), standard input, or the prompt.');
    }
    die(`perch relay ${cmd} takes only ${shape}; unexpected: ${words[max]}`);
  }
  if ((cmd === 'revoke' || cmd === 'remove') && ['', '.', '..'].includes(words[0]!)) die(`perch relay ${cmd} needs ${shape}, not "${words[0]}"`);
  out.cmd = cmd;
  if (cmd === 'create') out.relayUrl = words[0]!;
  if (cmd === 'revoke') out.id = words[0]!;
  if (cmd === 'remove') out.machine = words[0]!;
  if (cmd === 'rename') out.name = words[0]!;
  if (cmd === 'label') {
    out.text = words[0] ?? '';
    if (out.clear && words.length > 0) die('--clear and a label text do the opposite of each other - pass one');
  }
  if (cmd === 'permission') {
    const level = PERMISSIONS[words[0]!];
    if (!level) die(`unknown permission: ${words[0]} - use off, read-only or send`);
    out.inbound = level!;
  }
  if (uses !== undefined) {
    const n = /^\d+$/.test(uses) ? Number(uses) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 20) die('--uses must be a whole number from 1 to 20');
    out.uses = n;
  }
  if (expires !== undefined) out.expiresMinutes = parseExpiry(expires);
  return out;
}

/** Where secrets come from; replaced in tests. */
export interface SecretDeps {
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  readStdin: () => Promise<string>;
  askSecret: (question: string) => Promise<string>;
}

const MAX_SECRET_BYTES = 8192;

/** The first line of standard input (at most 8 KB); stops reading without waiting for the stream to close. */
export async function readFirstLine(stream: AsyncIterable<Buffer | string>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (text.includes('\n') || text.length >= MAX_SECRET_BYTES) break;
  }
  return (text.split(/\r?\n/)[0] ?? '').slice(0, MAX_SECRET_BYTES);
}

const readAllStdin = () => readFirstLine(process.stdin);

const defaultDeps = (): SecretDeps => ({ env: process.env, isTTY: interactive(), readStdin: readAllStdin, askSecret });

/** The secret from its environment variable, else piped standard input, else a hidden prompt. */
export async function resolveSecret(envName: string, what: string, deps: SecretDeps = defaultDeps()): Promise<string> {
  const fromEnv = (deps.env[envName] ?? '').trim();
  if (fromEnv) return fromEnv;
  let value: string;
  if (deps.isTTY) value = (await deps.askSecret(`${what}: `)).trim();
  else {
    console.error(`Reading the ${what.replace(/^relay /, '')} from standard input…`);
    value = ((await deps.readStdin()).split(/\r?\n/)[0] ?? '').trim();
  }
  if (!value) die(`no ${what} given - set $${envName}, pipe it on standard input, or run this in a terminal to be asked`);
  return value;
}

export interface RelayIO extends SecretDeps {
  confirm: (question: string) => Promise<boolean>;
  /** Request timeout override in ms (tests). */
  timeoutMs?: number;
}

const defaultIO = (): RelayIO => ({ ...defaultDeps(), confirm: async (q) => /^y(es)?$/i.test(await ask(q)) });

interface Machine { name: string; self: boolean; online: boolean; trust: string; blocked: boolean; accepts: string }
interface InviteRow { id: string; createdBy: string | null; expiresAt: number; usesLeft: number }
interface RelayState {
  joined: boolean;
  removedBy?: { by: string; at: number };
  defaultName?: string;
  relayHost: string | null;
  connection: string | null;
  reason: string;
  machine: { name: string; label: string } | null;
  inbound: string | null;
  readOnlyLimiting: boolean;
  machines: Machine[];
  invites: InviteRow[];
  /** false from a host older than 0.9, which has only a stub route. */
  available?: boolean;
}

const NOT_IN_GROUP = 'This Perch is not in a relay group. Join one in Settings → Assistant → Relay or with: perch relay join';

// Not apiJson: a 404 here has one cause worth naming (the extension is off),
// which apiJson's generic "<what>: 404" cannot say.
const DISABLED_BODY = 'extension not found or has no active server hook';
const LONG_COMMANDS = ['join', 'create', 'remove', 'leave'];
const NO_SUPPORT = "This Perch's Assistant has no relay support; update or restart Perch.";

async function call<T>(port: string, method: string, path: string, what: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const token = readAuthToken();
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers['x-auth-token'] = token;
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) die('The server did not answer in time; check `perch relay status`.');
    die(`couldn't reach the server on port ${port} - is it running? (perch start)`);
  }
  if (res.ok) return (await res.json()) as T;
  let detail = `${res.status}`;
  try {
    const parsed: unknown = JSON.parse(await res.text());
    if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') detail = (parsed as { error: string }).error;
  } catch {
    // Not JSON: the status is all there is.
  }
  if (res.status === 404) {
    if (detail === DISABLED_BODY) die('the Assistant extension is disabled - enable it in Settings → Extensions');
    die(NO_SUPPORT);
  }
  if (res.status === 401 || res.status === 403) {
    die(`${what}: ${detail} - this instance has AUTH_TOKEN set; put the same value in server/.env or the AUTH_TOKEN env var`);
  }
  die(`${what}: ${detail}`);
}

const when = (ms: number) => new Date(ms).toLocaleString();

function printStatus(s: RelayState): void {
  if (!s.joined || !s.machine) {
    if (s.removedBy?.by) info(`Removed from the group by ${s.removedBy.by}.`);
    info('This Perch is not in a relay group. Start one with: perch relay create <relay-url>');
    info('or join one with: perch relay join');
    return;
  }
  info(`Relay:       ${s.relayHost}`);
  info(`Connection:  ${s.connection}${s.reason ? ` (${s.reason})` : ''}`);
  info(`This machine: ${s.machine.name}${s.machine.label ? ` - ${s.machine.label}` : ''}`);
  const others = { off: 'Off', read: 'Read-only', send: 'Read and send' }[s.inbound ?? ''] ?? s.inbound;
  info(`Others may:  ${others}${s.readOnlyLimiting ? ' (the Assistant\'s Read-only setting limits this to reading)' : ''}`);
  const peers = s.machines.filter((m) => !m.self);
  info(`Machines:    ${peers.length} other${peers.length === 1 ? '' : 's'}, ${peers.filter((m) => m.online).length} online`);
}

function printMachines(s: RelayState): void {
  if (!s.joined) die(NOT_IN_GROUP);
  table(
    [['NAME', 'ONLINE', 'TRUST', 'OTHERS MAY'], ...s.machines.map((m) => [
      m.self ? `${m.name} (this machine)` : m.name,
      m.online ? 'online' : 'offline',
      m.blocked ? 'blocked' : m.trust,
      ({ read: 'read-only', send: 'read and send' } as Record<string, string>)[m.accepts] ?? m.accepts,
    ])],
    [28, 8, 11],
  );
}

/** `perch relay ...`; `io` is replaced in tests. */
export async function cmdRelay(args: string[], io: RelayIO = defaultIO()): Promise<void> {
  const a = parseRelayArgs(args);
  if (a.cmd === 'help') return info(USAGE);
  const port = await resolveInstancePort(a.port);
  const timeout = io.timeoutMs ?? (LONG_COMMANDS.includes(a.cmd) ? 120_000 : 60_000);
  const run = <T>(method: string, path: string, body?: unknown) => call<T>(port, method, path, `relay ${a.cmd}`, body, timeout);
  const state = async () => {
    const s = await run<RelayState>('GET', '/state');
    if (s.available === false) die(NO_SUPPORT);
    return s;
  };
  // create and join: check the state before asking for a secret, then show the notice.
  // Returns the machine name to use: --name, else the server's default (the host name).
  const preflight = async (): Promise<string> => {
    const st = await state();
    if (st.joined) die('This Perch is already in a relay group. Leave it first with: perch relay leave');
    info(NOTICE);
    if (a.allowInsecure) console.error('Secrets will cross the network unprotected.');
    return a.name || st.defaultName || '';
  };

  switch (a.cmd) {
    case 'create': {
      const name = await preflight();
      const adminSecret = await resolveSecret('PERCH_RELAY_ADMIN_SECRET', 'relay admin secret', io);
      const s = await run<RelayState>('POST', '/create', { relayUrl: a.relayUrl, adminSecret, name, allowInsecure: a.allowInsecure });
      ok(`Created a group on ${s.relayHost} as ${s.machine?.name}. Invite another machine with: perch relay invite`);
      return;
    }
    case 'join': {
      const name = await preflight();
      const invite = await resolveSecret('PERCH_RELAY_INVITE', 'invite', io);
      const s = await run<RelayState>('POST', '/join', { invite, name, allowInsecure: a.allowInsecure });
      ok(`Joined the group on ${s.relayHost} as ${s.machine?.name}`);
      return;
    }
    case 'invite': {
      const body: { uses?: number; expiresMinutes?: number } = {};
      if (a.uses !== undefined) body.uses = a.uses;
      if (a.expiresMinutes !== undefined) body.expiresMinutes = a.expiresMinutes;
      const r = await run<{ invite: string; expiresAt: number }>('POST', '/invites', body);
      // Alone on stdout so it pipes; the notes go to stderr.
      info(r.invite);
      console.error(`Shown once - it is not stored where it can be shown again. Expires ${when(r.expiresAt)}.`);
      return;
    }
    case 'invites': {
      const s = await state();
      if (!s.joined) die(NOT_IN_GROUP);
      if (s.invites.length === 0) return info('No open invites. Create one with: perch relay invite');
      table(
        [['ID', 'CREATED BY', 'USES LEFT', 'EXPIRES'], ...s.invites.map((i) => [i.id, i.createdBy ?? '-', String(i.usesLeft), when(i.expiresAt)])],
        [20, 20, 10],
      );
      return;
    }
    case 'revoke':
      await run('DELETE', `/invites/${encodeURIComponent(a.id)}`);
      ok(`Revoked invite ${a.id}`);
      return;
    case 'status':
      return printStatus(await state());
    case 'machines':
      return printMachines(await state());
    case 'remove': {
      if (!a.yes) {
        if (!io.isTTY) die('removing a machine replaces the group secret; re-run with --yes to confirm');
        if (!(await io.confirm(`Remove ${a.machine} from the group and replace the group secret? [y/N]: `))) {
          info('cancelled');
          throw new Exit(0);
        }
      }
      await run('POST', '/remove', { machine: a.machine });
      ok(`Removed ${a.machine}`);
      return;
    }
    case 'rename': {
      const s = await run<RelayState>('POST', '/rename', { name: a.name });
      ok(`This machine is now called ${s.machine?.name}`);
      return;
    }
    case 'label': {
      if (!a.clear && a.text === '') {
        const s = await state();
        if (!s.joined) die(NOT_IN_GROUP);
        return info(s.machine?.label || '(no label)');
      }
      const s = await run<RelayState>('POST', '/label', { label: a.clear ? '' : a.text });
      ok(s.machine?.label ? `Label set to: ${s.machine.label}` : 'Label cleared');
      return;
    }
    case 'permission': {
      await run('POST', '/permission', { inbound: a.inbound });
      ok(`Others may now: ${{ off: 'do nothing here (Off)', read: 'read only', send: 'read and send' }[a.inbound]}`);
      return;
    }
    case 'leave': {
      if (!a.yes) {
        if (!io.isTTY) die('leaving deletes this machine\'s relay keys; re-run with --yes to confirm');
        if (!(await io.confirm('Leave the relay group and delete its keys on this machine? [y/N]: '))) {
          info('cancelled');
          throw new Exit(0);
        }
      }
      const left = await run<{ relayEntryRemoved?: boolean }>('POST', '/leave');
      if (left?.relayEntryRemoved === false) {
        ok("Left the group here. The relay could not be reached, so this machine's entry is still on the relay; ask a member to remove it.");
      } else {
        ok('Left the relay group');
      }
      return;
    }
  }
}

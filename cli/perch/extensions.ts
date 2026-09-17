// `perch ext` - install and manage extensions from a terminal, through the
// running instance's API (see apiClient.ts for why through the server rather
// than straight into ~/.config/perch).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { apiJson, apiPost, apiPostBytes, resolveInstancePort } from './apiClient.ts';
import { die, Exit, info, ok, table } from './output.ts';

const USAGE = `Usage: perch ext <command> [flags]

Commands:
  install <target>   Install an extension. The target is a registry entry's
                     id (e.g. perch.github), a path to a local .perch file,
                     or an https URL to one.
  ls                 List installed extensions with version, state and the
                     registry each came from
  uninstall <id>     Remove an extension
  enable <id>        Turn an installed extension on
  disable <id>       Turn one off without removing it

Flags:
  --port <n>         Target a specific instance instead of auto-detecting one
                     (default: $PERCH_PORT when run inside a terminal this app
                     created, else whichever instance is running - prompting
                     if more than one is)

Needs a running instance: installing goes through the server so the
extension's server hook starts working right away, with no restart.`;

interface ExtensionRow {
  id: string;
  displayName: string;
  version: string;
  enabled: boolean;
  builtin: boolean;
  uninstalled: boolean;
  required: boolean;
  source: string | null;
}

interface CatalogEntry {
  id: string;
}

interface CatalogSource {
  source: string;
  error?: string;
  entries: CatalogEntry[];
}

/**
 * What an install target names. An https URL is a url; an existing regular
 * file is a file; anything else is treated as a registry id, so a typo'd path
 * fails with "no configured registry carries it" rather than a confusing
 * file-not-found.
 */
export function classifyTarget(target: string): 'url' | 'file' | 'id' {
  if (/^https?:\/\//i.test(target)) return 'url';
  try {
    if (existsSync(target) && statSync(target).isFile()) return 'file';
  } catch {
    // Unreadable path — fall through and let it be an id.
  }
  return 'id';
}

function parseArgs(args: string[]): { rest: string[]; port: string } {
  const rest: string[] = [];
  let port = '';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      info(USAGE);
      throw new Exit(0);
    }
    if (arg.startsWith('--port=')) port = arg.slice('--port='.length);
    else if (arg === '--port') {
      if (i + 1 >= args.length) die('--port requires a value');
      port = args[++i]!;
    } else if (arg.startsWith('-')) die(`unknown flag: ${arg}`);
    else rest.push(arg);
  }
  return { rest, port };
}

// A bare id has to be resolved to the source that carries it, because the
// install route takes both. Exactly one match is required: with two catalogs
// offering the same id, picking one silently would install something the user
// didn't choose.
async function sourceForId(port: string, id: string): Promise<string> {
  const { sources } = await apiJson<{ sources: CatalogSource[] }>(
    port,
    '/api/registry',
    'could not read the registry',
  );
  const carrying = sources.filter((s) => s.entries.some((e) => e.id === id));
  if (carrying.length === 1) return carrying[0]!.source;
  if (carrying.length === 0) {
    const errors = sources.filter((s) => s.error);
    if (errors.length > 0) {
      info('some registry sources could not be read:');
      errors.forEach((s) => info(`  ${s.source}: ${s.error}`));
    }
    die(`no configured registry carries "${id}" - add one in Settings, or pass a .perch file or URL`);
  }
  info(`"${id}" is offered by more than one registry:`);
  carrying.forEach((s) => info(`  ${s.source}`));
  die('remove one of them, or install from a .perch file instead');
}

async function install(port: string, target: string): Promise<void> {
  const kind = classifyTarget(target);
  let installed: ExtensionRow;

  if (kind === 'id') {
    const source = await sourceForId(port, target);
    installed = await apiPost<ExtensionRow>(
      port,
      '/api/registry/install',
      { source, id: target },
      `could not install ${target}`,
    );
  } else {
    // Downloaded here rather than server-side so a bad URL fails with a clear
    // message before the server is involved; the upload route then takes the
    // same bytes a local file would.
    let bytes: Uint8Array;
    if (kind === 'url') {
      let res: Response;
      try {
        res = await fetch(target, { signal: AbortSignal.timeout(60_000) });
      } catch (err) {
        die(`could not download ${target}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!res.ok) die(`could not download ${target}: ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    } else {
      bytes = new Uint8Array(readFileSync(target));
    }
    installed = await apiPostBytes<ExtensionRow>(
      port,
      '/api/extensions/install',
      bytes,
      `could not install ${target}`,
    );
  }

  ok(`installed ${installed.displayName} ${installed.version}${installed.enabled ? ' (enabled)' : ''}`);
}

async function list(port: string): Promise<void> {
  const rows = await apiJson<ExtensionRow[]>(port, '/api/extensions', 'could not list extensions');
  if (rows.length === 0) return info('no extensions installed');
  const state = (e: ExtensionRow) =>
    e.uninstalled ? 'removed' : e.required ? 'required' : e.enabled ? 'enabled' : 'disabled';
  table(
    [
      ['ID', 'VERSION', 'STATE', 'SOURCE'],
      ...rows.map((e) => [e.id, e.version, state(e), e.source ?? (e.builtin ? 'bundled' : '-')]),
    ],
    [30, 9, 9],
  );
}

export async function cmdExt(args: string[]): Promise<void> {
  const [sub = '', ...raw] = args;
  if (sub === '' || sub === 'help' || sub === '--help' || sub === '-h') return info(USAGE);

  const { rest, port: flagPort } = parseArgs(raw);
  const needsId = (what: string): string => {
    if (rest.length === 0) die(`perch ext ${sub} needs ${what}`);
    if (rest.length > 1) die(`unexpected argument: ${rest[1]}`);
    return rest[0]!;
  };

  switch (sub) {
    case 'install': {
      const target = needsId('an id, a .perch file, or a URL');
      return install(await resolveInstancePort(flagPort), target);
    }
    case 'ls':
    case 'list': {
      if (rest.length > 0) die(`unexpected argument: ${rest[0]}`);
      return list(await resolveInstancePort(flagPort));
    }
    case 'uninstall':
    case 'remove': {
      const id = needsId('an extension id');
      const port = await resolveInstancePort(flagPort);
      await apiJson(port, `/api/extensions/${encodeURIComponent(id)}`, `could not uninstall ${id}`, {
        method: 'DELETE',
      });
      return ok(`uninstalled ${id}`);
    }
    case 'enable':
    case 'disable': {
      const id = needsId('an extension id');
      const enabled = sub === 'enable';
      const port = await resolveInstancePort(flagPort);
      await apiPost(port, `/api/extensions/${encodeURIComponent(id)}/enabled`, { enabled }, `could not ${sub} ${id}`);
      return ok(`${enabled ? 'enabled' : 'disabled'} ${id}`);
    }
    default:
      die(`unknown command: perch ext ${sub} - expected install, ls, uninstall, enable or disable`);
  }
}

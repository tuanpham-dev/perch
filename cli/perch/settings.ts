// `perch settings export|import` - move a settings bundle in and out of an
// install from a terminal, so a fresh machine can be configured by a script.
//
// The server builds and applies the bundle (server/src/settingsBundle.ts), so
// this file is only argument handling, file IO and printing. Import refuses to
// change anything without an explicit flag: a settings import is not something
// to do by accident inside a script.
import { readFileSync, writeFileSync } from 'node:fs';
import { apiJson, apiPost, resolveInstancePort } from './apiClient.ts';
import { die, Exit, fail, info, ok, warn } from './output.ts';

const USAGE = `Usage: perch settings export [file] [--port <n>]
       perch settings import <file> [--yes|--no-extensions] [--port <n>]

export  Writes a settings bundle - preferences, keybindings, extension
        settings, the sidebar and status bar arrangement, registry sources,
        and the list of installed extensions. Writes to <file>, or to stdout
        so it can be piped. Never contains API keys, extension credentials,
        project paths or usage stats.

import  Prints what the bundle would change and, with no flag, stops there
        without touching anything. Then:
          --yes             apply it and install every extension it lists
          --no-extensions   apply the settings only, install nothing
        The settings merge keeps any setting the bundle does not mention.

Flags:
  --port <n>  Target a specific instance instead of auto-detecting one`;

interface BundleRow {
  id: string;
  version: string;
  source: string | null;
  installed: boolean;
  installable: boolean;
  reason?: string;
}

interface BundleSummary {
  exportedAt: string;
  categories: { key: string; label: string; count: number }[];
  extensions: BundleRow[];
}

interface ApplyResult {
  extensions: { id: string; ok: boolean; error?: string }[];
}

interface Flags {
  rest: string[];
  port: string;
  yes: boolean;
  noExtensions: boolean;
}

/**
 * Exported for tests: the two apply flags are mutually exclusive, and naming
 * both in the error is friendlier than picking one.
 */
export function parseSettingsFlags(args: string[]): Flags {
  const out: Flags = { rest: [], port: '', yes: false, noExtensions: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      info(USAGE);
      throw new Exit(0);
    }
    if (arg === '--yes' || arg === '-y') out.yes = true;
    else if (arg === '--no-extensions') out.noExtensions = true;
    else if (arg.startsWith('--port=')) out.port = arg.slice('--port='.length);
    else if (arg === '--port') {
      if (i + 1 >= args.length) die('--port requires a value');
      out.port = args[++i]!;
    } else if (arg.startsWith('-')) die(`unknown flag: ${arg}`);
    else out.rest.push(arg);
  }
  if (out.yes && out.noExtensions) {
    die('--yes and --no-extensions do the opposite of each other - pass one or neither');
  }
  return out;
}

async function exportBundle(port: string, file: string | undefined): Promise<void> {
  const bundle = await apiJson<Record<string, unknown>>(
    port,
    '/api/settings/bundle',
    'could not read the settings bundle',
  );
  const json = `${JSON.stringify(bundle, null, 2)}\n`;
  if (!file) {
    // stdout, not info(), so `perch settings export > file.json` is byte-exact.
    process.stdout.write(json);
    return;
  }
  try {
    writeFileSync(file, json);
  } catch (err) {
    die(`could not write ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  ok(`wrote ${file}`);
}

// An arrangement is one thing however many ids it names, so these read as a
// bare label; the rest take a count, singularized so a lone source doesn't
// come out as "1 registry sources".
const ALWAYS_ONE = new Set(['sidebarLayout', 'statusBarLayout', 'sidebarPanels']);

function phrase(category: { key: string; label: string; count: number }): string {
  const label = category.label.toLowerCase();
  if (ALWAYS_ONE.has(category.key)) return label;
  return `${category.count} ${category.count === 1 ? label.replace(/s$/, '') : label}`;
}

function printSummary(summary: BundleSummary): BundleRow[] {
  if (summary.categories.length > 0) {
    info(`Would merge: ${summary.categories.map(phrase).join(', ')}`);
  } else {
    info('Would merge: nothing - this bundle carries no settings');
  }

  const installable = summary.extensions.filter((e) => e.installable);
  const blocked = summary.extensions.filter((e) => !e.installable);
  if (installable.length > 0) info(`Would install: ${installable.map((e) => e.id).join(', ')}`);
  for (const row of blocked) info(`Not installable: ${row.id} (${row.reason ?? 'no source'})`);
  return installable;
}

async function importBundle(port: string, file: string, flags: Flags): Promise<void> {
  let bundle: unknown;
  try {
    bundle = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    die(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Read-only: says what would change without changing it, and rejects a file
  // that isn't a bundle before anything else happens.
  const summary = await apiJson<BundleSummary>(port, '/api/settings/bundle/preview', `could not read ${file}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  });

  const installable = printSummary(summary);

  if (!flags.yes && !flags.noExtensions) {
    info('');
    info('Nothing changed. Re-run with --yes to apply and install,');
    info('or --no-extensions to apply settings only.');
    return;
  }

  const ids = flags.yes ? installable.map((e) => e.id) : [];
  const result = await apiPost<ApplyResult>(
    port,
    '/api/settings/bundle/apply',
    { bundle, extensions: ids },
    `could not import ${file}`,
  );

  ok('settings merged');
  let failed = 0;
  for (const row of result.extensions) {
    if (row.ok) ok(`installed ${row.id}`);
    else {
      failed++;
      fail(`${row.id}: ${row.error ?? 'install failed'}`);
    }
  }
  if (failed > 0) {
    warn(`${failed} extension${failed === 1 ? '' : 's'} could not be installed; your settings were still merged`);
    throw new Exit(1);
  }
}

export async function cmdSettings(args: string[]): Promise<void> {
  const [sub = '', ...raw] = args;
  if (sub === '' || sub === 'help' || sub === '--help' || sub === '-h') return info(USAGE);

  const flags = parseSettingsFlags(raw);

  switch (sub) {
    case 'export': {
      if (flags.rest.length > 1) die(`unexpected argument: ${flags.rest[1]}`);
      return exportBundle(await resolveInstancePort(flags.port), flags.rest[0]);
    }
    case 'import': {
      if (flags.rest.length === 0) die('perch settings import needs a file');
      if (flags.rest.length > 1) die(`unexpected argument: ${flags.rest[1]}`);
      return importBundle(await resolveInstancePort(flags.port), flags.rest[0]!, flags);
    }
    default:
      die(`unknown command: perch settings ${sub} - expected export or import`);
  }
}

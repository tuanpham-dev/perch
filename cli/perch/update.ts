// `perch update` (plans/app-versioning.md R12, R13): moves an install to the
// latest release on its channel, or keeps it on main when asked to. Decides
// by comparing versions, not git history, because installs are shallow
// clones that don't have the history to compare.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compare, highest, isPrerelease, valid } from '../../server/src/semver.ts';
import { die, info, ok, warn } from './output.ts';
import { ENV_FILE, REPO_DIR } from './paths.ts';
import { inherit, output } from './run.ts';
import { installedVersion } from './version.ts';

export type Channel = 'stable' | 'beta';
export type Mode = 'release' | 'main';

export const UPDATE_USAGE = `Usage: perch update [--release | --main] [--stable | --beta]

Moves this install to the latest Perch release, then reinstalls, rebuilds
and restarts it. It never moves to an older version.

  --release   Follow releases (the default), and switch back to them after --main
  --main      Follow the main branch instead, on this and later updates
  --stable    Consider only full releases, this time
  --beta      Include pre-releases (like 0.3.0-rc.1), this time

Without --stable or --beta, the channel is the one picked in Settings -> About
(Stable unless changed).`;

export interface Plan {
  action: 'move' | 'current' | 'stay' | 'no-releases';
  // The tag to move to (action "move"), or the latest release's tag.
  tag?: string;
  message: string;
}

/**
 * What a release-following update should do. `tags` maps tag names
 * ("v0.2.0") to the commit each points at; `head` is the commit checked out.
 */
export function planUpdate(opts: { current: string; head: string; tags: Map<string, string>; channel: Channel }): Plan {
  const candidates = [...opts.tags.keys()].filter(
    (t) => valid(t) && t.startsWith('v') && (opts.channel === 'beta' || !isPrerelease(t)),
  );
  const tag = highest(candidates);
  if (!tag) return { action: 'no-releases', message: `no ${opts.channel === 'beta' ? '' : 'stable '}release yet - staying on the current code` };
  const latest = tag.slice(1);
  if (!valid(opts.current)) return { action: 'move', tag, message: `updating to ${latest}` };
  const cmp = compare(latest, opts.current);
  if (cmp > 0) return { action: 'move', tag, message: `updating ${opts.current} -> ${latest}` };
  if (cmp === 0 && opts.tags.get(tag) === opts.head) return { action: 'current', tag, message: `already on ${latest}, the latest ${opts.channel === 'beta' ? 'release' : 'stable release'}` };
  return {
    action: 'stay',
    tag,
    message:
      `this install (${opts.current}) is ahead of the latest ${opts.channel === 'beta' ? 'release' : 'stable release'} (${latest}) - leaving it where it is.\n` +
      `  perch update --main     keep following main\n` +
      `  perch update --release  move to releases once a newer one is out`,
  };
}

/** Tag -> commit, from `git ls-remote --tags` output (annotated tags resolved to their commit). */
export function parseLsRemoteTags(text: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const line of text.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref?.startsWith('refs/tags/')) continue;
    const peeled = ref.endsWith('^{}');
    const name = ref.slice('refs/tags/'.length).replace(/\^\{\}$/, '');
    if (peeled || !tags.has(name)) tags.set(name, sha);
  }
  return tags;
}

// The server's config dir, as server/src/configDir.ts resolves it, for the
// channel picked in Settings.
function settingsChannel(): Channel {
  let dir = process.env.PERCH_CONFIG_DIR;
  if (!dir && existsSync(ENV_FILE)) {
    const line = readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => l.startsWith('PERCH_CONFIG_DIR=')).at(-1);
    // trim first: a CRLF file leaves a \r after the closing quote.
    dir = line?.slice('PERCH_CONFIG_DIR='.length).trim().replace(/^["']|["']$/g, '') || undefined;
  }
  dir ??= process.platform === 'win32'
    ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'perch')
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'perch');
  try {
    const doc = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    return doc?.settings?.updateChannel === 'beta' ? 'beta' : 'stable';
  } catch {
    return 'stable';
  }
}

const git = (...args: string[]) => inherit('git', ['-C', REPO_DIR, ...args]);
const gitOut = (...args: string[]) => output('git', ['-C', REPO_DIR, ...args]);

function trackedMode(): Mode {
  return gitOut('config', '--get', 'perch.track') === 'main' ? 'main' : 'release';
}

// --depth 1 only where the clone already is shallow: a full clone stays full.
const depth = () => (gitOut('rev-parse', '--is-shallow-repository') === 'true' ? ['--depth', '1'] : []);

/**
 * Moves the checkout per the flags. Returns false when there is nothing new
 * to install (already current, or staying ahead).
 */
export function moveCheckout(args: string[]): boolean {
  if (args.includes('--main') && args.includes('--release')) die('--main and --release are opposites - pick one');
  if (args.includes('--beta') && args.includes('--stable')) die('--beta and --stable are opposites - pick one');
  for (const a of args) {
    if (!['--main', '--release', '--beta', '--stable'].includes(a)) die(`unknown flag: ${a}\n\n${UPDATE_USAGE}`);
  }
  let mode = trackedMode();
  if (args.includes('--main')) mode = 'main';
  if (args.includes('--release')) mode = 'release';
  if (git('config', 'perch.track', mode) !== 0) warn('could not remember the update mode in git config');

  if (mode === 'main') {
    info('following main');
    if (git('fetch', ...depth(), 'origin', 'main') !== 0) die('git fetch failed');
    if (git('checkout', '-q', '-B', 'main', 'FETCH_HEAD') !== 0) die('git checkout failed');
    return true;
  }

  const channel: Channel = args.includes('--beta') ? 'beta' : args.includes('--stable') ? 'stable' : settingsChannel();
  const listing = output('git', ['-C', REPO_DIR, 'ls-remote', '--tags', 'origin']);
  const plan = planUpdate({
    current: installedVersion().version,
    head: gitOut('rev-parse', 'HEAD'),
    tags: parseLsRemoteTags(listing),
    channel,
  });
  if (plan.action === 'current' || plan.action === 'stay') {
    ok(plan.message);
    return false;
  }
  if (plan.action === 'no-releases') {
    warn(plan.message);
    return false;
  }
  info(plan.message);
  const tag = plan.tag!;
  if (git('fetch', ...depth(), 'origin', `refs/tags/${tag}:refs/tags/${tag}`) !== 0) die('git fetch failed');
  if (git('checkout', '-q', '--detach', tag) !== 0) die('git checkout failed');
  return true;
}

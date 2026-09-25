import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const DAEMON = fileURLToPath(new URL('../src/daemon/index.ts', import.meta.url));

import { waitFor, waitForMatch } from './wait.ts';

// Short base dir: unix socket paths are capped near 108 bytes, and a mkdtemp
// under $TMPDIR plus "/daemon.sock" must stay under that.
function makeEnv(): { env: Record<string, string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mux-e2e-'));
  return {
    dir,
    env: { ...process.env, PERCH_STATE_DIR: join(dir, 's'), PERCH_CONFIG_DIR: join(dir, 'c') } as Record<string, string>,
  };
}

function sp(env: Record<string, string>, ...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { env }).toString();
}

function daemonPid(env: Record<string, string>): number {
  return Number(readFileSync(join(env.PERCH_STATE_DIR, 'daemon.pid'), 'utf8').trim());
}

function killDaemons(env: Record<string, string>): void {
  // Match only daemons for THIS state dir, via their live cwd-independent argv.
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const argv = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
      const env2 = readFileSync(`/proc/${d}/environ`, 'utf8');
      if (argv[1] === DAEMON && env2.includes(`PERCH_STATE_DIR=${env.PERCH_STATE_DIR}`)) {
        process.kill(Number(d), 'SIGKILL');
      }
    } catch { /* vanished or unreadable */ }
  }
}

test('sessions, layout, cwd and scrollback survive a hard daemon kill', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'config', 'set', 'snapshotDebounceMs', '300');
    // Killed hard and read back within seconds: a window may not wait 30 s for its second save.
    sp(env, 'config', 'set', 'scrollbackWriteIntervalMs', '0');
    sp(env, 'new', 'work', '-c', 'echo DECLARED-MARK');
    // The declared command's own output is the signal that the shell is up and
    // running commands; typing before that goes nowhere.
    await waitForMatch('the declared command to run', () => sp(env, 'capture', 'work:0', '-S', '50'), /DECLARED-MARK/);
    sp(env, 'send', 'work:0', 'echo LIVE-MARK-ALPHA', '--enter');
    sp(env, 'window', 'new', '-t', 'work', '-n', 'logs');
    await waitFor('the second window to exist', () => {
      const list = JSON.parse(sp(env, 'window', 'ls', '-t', 'work', '-j')) as { index: number }[];
      return list.some((w) => w.index === 1);
    });
    sp(env, 'send', 'work:1', 'cd /etc; echo LIVE-MARK-BETA', '--enter');
    // Poll the on-disk snapshot rather than guessing how long the throttled
    // write takes to pick up the cd — see waitFor's comment above.
    await waitFor("the snapshot to record the second window's cd", () => {
      const state = JSON.parse(readFileSync(join(env.PERCH_STATE_DIR, 'state.json'), 'utf8')) as {
        sessions: { windows: { cwd: string }[] }[];
      };
      return state.sessions[0]?.windows[1]?.cwd === '/etc';
    });

    await waitForMatch('the typed output to appear', () => sp(env, 'capture', 'work:0', '-S', '50'), /LIVE-MARK-ALPHA/);

    const idsBefore = (JSON.parse(sp(env, 'window', 'ls', '-t', 'work', '-j')) as { windowId: string }[]).map((w) => w.windowId);

    // Hard kill: the processes die but the on-disk snapshot remains (a reboot).
    const before = daemonPid(env);
    process.kill(before, 'SIGKILL');
    killDaemons(env);

    // Any sp command respawns the daemon, which restores from disk first.
    await waitForMatch('a respawned daemon to list the session', () => sp(env, 'ls'), /work/);

    const windows = await waitFor('both windows to come back', () => {
      const list = JSON.parse(sp(env, 'window', 'ls', '-t', 'work', '-j')) as { index: number; name: string; cwd: string; windowId: string }[];
      return list.length === 2 ? list : null;
    });
    assert.deepEqual(windows.map((w) => w.windowId), idsBefore, 'restored windows keep their ids');
    assert.equal(windows.length, 2, 'both windows restored');
    assert.equal(windows[1]!.name, 'logs', 'window names restored');
    assert.equal(windows[1]!.cwd, '/etc', 'restored shell resumes at the saved cwd');

    // Pre-kill scrollback replays, and the declared command re-ran on restore.
    const cap0 = sp(env, 'capture', 'work:0', '-S', '80');
    assert.match(cap0, /LIVE-MARK-ALPHA/, 'pre-kill output survived');
    assert.match(cap0, /\[restored/, 'restore banner present');
    assert.match(cap0, /DECLARED-MARK/, 'declared command re-ran');

    // The first post-restore snapshot must keep the sidecars: they belong to
    // the same ids, so the orphan sweep has nothing to remove.
    sp(env, 'send', 'work:0', 'echo AFTER-RESTORE', '--enter');
    await waitForMatch('post-restore output', () => sp(env, 'capture', 'work:0', '-S', '80'), /AFTER-RESTORE/);
    await waitFor('a post-restore snapshot', () => {
      const state = JSON.parse(readFileSync(join(env.PERCH_STATE_DIR, 'state.json'), 'utf8')) as { savedAt: number };
      return state.savedAt > Date.now() - 1500;
    });
    const sidecars = readdirSync(join(env.PERCH_STATE_DIR, 'scrollback'));
    for (const id of idsBefore) assert.ok(sidecars.includes(`${id}.raw`), `sidecar for ${id} kept`);
    for (const f of sidecars) {
      assert.equal(statSync(join(env.PERCH_STATE_DIR, 'scrollback', f)).mode & 0o777, 0o600, `${f} is owner-only`);
    }

    const newPid = daemonPid(env);
    assert.notEqual(newPid, before, 'a fresh daemon took over');
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--no-cmd restores layout without re-running declared commands', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'config', 'set', 'snapshotDebounceMs', '300');
    // Killed hard and read back within seconds: a window may not wait 30 s for its second save.
    sp(env, 'config', 'set', 'scrollbackWriteIntervalMs', '0');
    sp(env, 'new', 'nc', '-c', 'echo SHOULD-NOT-RERUN');
    await waitForMatch('the declared command to run once', () => sp(env, 'capture', 'nc:0', '-S', '80'), /SHOULD-NOT-RERUN/);
    process.kill(daemonPid(env), 'SIGKILL');
    killDaemons(env);
    // Bring the daemon back with commands suppressed.
    sp(env, 'daemon', 'start', '--no-cmd', '--quiet');
    const cap = await waitForMatch('the restored layout', () => sp(env, 'capture', 'nc:0', '-S', '80'), /\[restored/);
    const reruns = (cap.match(/^SHOULD-NOT-RERUN$/gm) ?? []).length;
    assert.equal(reruns, 0, 'declared command did not re-run under --no-cmd');
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a restored window reports what was running in it until a client clears it', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'config', 'set', 'snapshotDebounceMs', '300');
    // Killed hard and read back within seconds: a window may not wait 30 s for its second save.
    sp(env, 'config', 'set', 'scrollbackWriteIntervalMs', '0');
    sp(env, 'new', 'agent');
    sp(env, 'send', 'agent:0', 'sleep 300', '--enter');
    await waitFor('sleep to be recorded in the snapshot', () => {
      const state = JSON.parse(readFileSync(join(env.PERCH_STATE_DIR, 'state.json'), 'utf8')) as {
        sessions: { windows: { running: string[] }[] }[];
      };
      return state.sessions[0]?.windows[0]?.running.includes('sleep');
    }, { timeout: 10_000 });
    process.kill(daemonPid(env), 'SIGKILL');
    killDaemons(env);

    type Win = { windowId: string; restoredCommands?: string[] };
    const [restored] = await waitFor('the window to come back', () => {
      const list = JSON.parse(sp(env, 'window', 'ls', '-t', 'agent', '-j')) as Win[];
      return list.length === 1 ? list : null;
    });
    assert.ok(restored!.restoredCommands?.includes('sleep'), 'restored window reports sleep');

    // The fresh shell isn't running sleep; a further restart before anyone
    // acknowledged must keep reporting the original.
    await new Promise((r) => setTimeout(r, 800));
    process.kill(daemonPid(env), 'SIGTERM');
    await waitFor('the daemon to stop', () => { try { process.kill(daemonPid(env), 0); return false; } catch { return true; } });
    const [again] = await waitFor('the window to come back again', () => {
      const list = JSON.parse(sp(env, 'window', 'ls', '-t', 'agent', '-j')) as Win[];
      return list.length === 1 ? list : null;
    });
    assert.ok(again!.restoredCommands?.includes('sleep'), 'still reported after a second restart');

    execFileSync(process.execPath, ['-e', `
      const { connectOrSpawn } = await import(${JSON.stringify(new URL('../src/client/connection.ts', import.meta.url).href)});
      const c = await connectOrSpawn();
      await c.request({ kind: 'window.clearRestored', target: '@${again!.windowId}' });
      c.close();
    `, '--input-type=module'], { env });
    const [cleared] = JSON.parse(sp(env, 'window', 'ls', '-t', 'agent', '-j')) as Win[];
    assert.equal(cleared!.restoredCommands, undefined, 'cleared once acknowledged');
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with scrollback saving off, the snapshot keeps the layout and deletes saved history', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'config', 'set', 'snapshotDebounceMs', '300');
    // Killed hard and read back within seconds: a window may not wait 30 s for its second save.
    sp(env, 'config', 'set', 'scrollbackWriteIntervalMs', '0');
    sp(env, 'new', 'plain');
    sp(env, 'send', 'plain:0', 'echo SECRET-MARK', '--enter');
    const scrollback = join(env.PERCH_STATE_DIR, 'scrollback');
    await waitFor('history to be saved', () => readdirSync(scrollback).length > 0);

    sp(env, 'config', 'set', 'persistScrollback', 'false');
    // reloadConfig is what the app sends; the CLI's config set only writes the file.
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { connectOrSpawn } = await import(${JSON.stringify(new URL('../src/client/connection.ts', import.meta.url).href)});
      const c = await connectOrSpawn();
      await c.request({ kind: 'daemon.reloadConfig' });
      c.close();
    `], { env });
    sp(env, 'window', 'new', '-t', 'plain', '-n', 'second');
    await waitFor('saved history to be removed', () => readdirSync(scrollback).length === 0);
    const state = readFileSync(join(env.PERCH_STATE_DIR, 'state.json'), 'utf8');
    assert.match(state, /"second"/, 'layout still saved');
    assert.doesNotMatch(state, /SECRET-MARK/);
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with restore off, a restarted daemon starts empty', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'config', 'set', 'restore', 'false');
    sp(env, 'new', 'gone');
    await waitFor('the snapshot to exist', () => readFileSync(join(env.PERCH_STATE_DIR, 'state.json'), 'utf8').includes('"gone"'));
    process.kill(daemonPid(env), 'SIGKILL');
    killDaemons(env);
    sp(env, 'daemon', 'start', '--quiet');
    assert.doesNotMatch(sp(env, 'ls'), /gone/);
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

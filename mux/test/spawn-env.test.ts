import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitFor } from './wait.ts';
import { killDaemons as killTestDaemons, processEnviron } from './procs.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const DAEMON = fileURLToPath(new URL('../src/daemon/index.ts', import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeEnv(): { env: Record<string, string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mux-env-'));
  return {
    dir,
    env: {
      ...process.env,
      PERCH_STATE_DIR: join(dir, 's'),
      PERCH_CONFIG_DIR: join(dir, 'c'),
      // Planted daemon-only vars: the daemon inherits these (it is spawned by
      // the CLI below, which inherits this test env) and must NOT pass them on
      // to the shells it spawns.
      AUTH_TOKEN: 'test-secret-must-not-leak',
      npm_lifecycle_event: 'test',
      // Planted launcher context: a daemon started from a Claude Code session
      // inside tmux must not hand either on to its windows.
      TMUX: '/tmp/tmux-1000/default,1,0',
      TMUX_PANE: '%9',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_USE_BEDROCK: '1',
    } as Record<string, string>,
  };
}

function sp(env: Record<string, string>, ...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { env }).toString();
}

// macOS hides the environment of Apple-signed platform binaries (/bin/zsh,
// /bin/bash) from `ps -E`, even for the same user, so a default-shell window's
// environment can't be read back there. What these tests check is the
// environment the daemon hands to the process it spawns, not anything the
// shell does, so off Linux the window runs node (no args: an idle REPL on the
// pty) whose environment is readable. Linux keeps the real default shell.
function useReadableShell(env: Record<string, string>): void {
  if (process.platform !== 'linux') sp(env, 'config', 'set', 'shell', process.execPath);
}

function killDaemons(env: Record<string, string>): void {
  killTestDaemons(DAEMON, env.PERCH_STATE_DIR!);
}


test('spawned shells carry PERCH_SESSION/PERCH_WINDOW and are scrubbed of daemon-only vars', async () => {
  const { env, dir } = makeEnv();
  try {
    useReadableShell(env);
    sp(env, 'new', 'envtest');
    let windows: { pid: number }[] = [];
    await waitFor('the window to report a live pid', () => {
      windows = JSON.parse(sp(env, 'window', 'ls', '-t', 'envtest', '-j'));
      return windows.length === 1 && windows[0]!.pid > 1;
    });

    const environ = processEnviron(windows[0]!.pid);
    assert.ok(environ, 'the window shell is alive and its environment readable');
    const get = (name: string) =>
      environ.find((e) => e.startsWith(`${name}=`))?.slice(name.length + 1);

    assert.equal(get('PERCH_SESSION'), 'envtest', 'session name at spawn time');
    assert.match(get('PERCH_WINDOW') ?? '', /^[0-9a-f-]{36}$/, 'window uuid present');
    assert.ok(get('PERCH_ROOT'), 'project root present, for cdp');
    // Identity is consistent with what window.list reports for this window.
    assert.equal(get('PERCH_STATE_DIR'), env.PERCH_STATE_DIR, 'state dir kept so nested CLI targets the same daemon');

    // Absent until a server announces itself, which no test daemon does. The
    // point of the variable is that it comes from the daemon's live view of
    // which server to talk to, rather than from the shared integration script,
    // which every server rewrites at startup with its own port.
    assert.equal(get('PERCH_SERVER_URL'), undefined, 'no report URL without an announced server');

    assert.equal(get('AUTH_TOKEN'), undefined, 'app secret must not leak into shells');
    assert.equal(get('npm_lifecycle_event'), undefined, 'npm launch artifacts scrubbed');
    assert.ok(get('PATH'), 'surrounding environment (PATH) is preserved');
    assert.equal(get('TMUX'), undefined, "the launcher's tmux is not the window's");
    assert.equal(get('TMUX_PANE'), undefined, "the launcher's pane is not the window's");
    assert.equal(get('CLAUDECODE'), undefined, 'not inside the launching Claude Code session');
    assert.equal(get('CLAUDE_CODE_CHILD_SESSION'), undefined, 'claude in a window is not a child session');
    assert.equal(get('CLAUDE_CODE_USE_BEDROCK'), '1', 'user Claude Code configuration is kept');
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a restored window also gets identity vars (restore path uses the same spawn env)', async () => {
  const { env, dir } = makeEnv();
  try {
    useReadableShell(env);
    sp(env, 'config', 'set', 'snapshotDebounceMs', '300');
    sp(env, 'new', 'reborn');
    await sleep(700); // let the snapshot land
    const before = JSON.parse(sp(env, 'window', 'ls', '-t', 'reborn', '-j')) as { pid: number }[];
    killDaemons(env);
    await sleep(400);

    // Any command respawns the daemon, which restores from disk first.
    let after: { pid: number }[] = [];
    await waitFor('a restored shell with a new pid', () => {
      after = JSON.parse(sp(env, 'window', 'ls', '-t', 'reborn', '-j'));
      return after.length === 1 && after[0]!.pid > 1 && after[0]!.pid !== before[0]!.pid;
    });
    const environ = processEnviron(after[0]!.pid);
    assert.ok(environ, 'the restored shell is alive and its environment readable');
    assert.ok(environ.some((e) => e === 'PERCH_SESSION=reborn'), 'restored shell has PERCH_SESSION');
    assert.ok(environ.some((e) => e.startsWith('PERCH_WINDOW=')), 'restored shell has PERCH_WINDOW');
    assert.ok(environ.some((e) => e.startsWith('PERCH_ROOT=')), 'restored shell has PERCH_ROOT');
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

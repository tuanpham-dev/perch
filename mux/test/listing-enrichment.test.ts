import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killDaemons as killTestDaemons } from './procs.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const DAEMON = fileURLToPath(new URL('../src/daemon/index.ts', import.meta.url));
// The kernel reports a process's cwd with symlinks resolved, and on macOS /etc
// is a symlink to /private/etc. Expect the resolved path (plain /etc on Linux).
const ETC = realpathSync('/etc');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeEnv(): { env: Record<string, string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mux-enrich-'));
  return {
    dir,
    env: { ...process.env, PERCH_STATE_DIR: join(dir, 's'), PERCH_CONFIG_DIR: join(dir, 'c') } as Record<string, string>,
  };
}
function sp(env: Record<string, string>, ...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { env }).toString();
}
function killDaemons(env: Record<string, string>): void {
  killTestDaemons(DAEMON, env.PERCH_STATE_DIR!);
}

type SessionRow = { name: string; cwd: string; foregroundCommand?: string; lastOutputAt: number };
type WindowRow = { lastOutputAt: number; cwd: string };

test('session.list carries the current window cwd, foreground command, and activity', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'enrich', '-d', '/etc');
    await sleep(500);
    const rows = JSON.parse(sp(env, 'ls', '-j')) as SessionRow[];
    const row = rows.find((r) => r.name === 'enrich');
    assert.ok(row, 'session present');
    assert.equal(row!.cwd, ETC, 'current window cwd surfaced on the session row');
    assert.match(row!.foregroundCommand ?? '', /sh$/, 'idle shell as foreground command');
    assert.ok(row!.lastOutputAt > 0, 'lastOutputAt populated');
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lastOutputAt advances after new output', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'active');
    await sleep(500);
    const before = (JSON.parse(sp(env, 'window', 'ls', '-t', 'active', '-j')) as WindowRow[])[0]!.lastOutputAt;
    await sleep(50);
    sp(env, 'send', 'active:0', 'printf HELLO', '--enter');
    await sleep(400);
    const after = (JSON.parse(sp(env, 'window', 'ls', '-t', 'active', '-j')) as WindowRow[])[0]!.lastOutputAt;
    assert.ok(after > before, `lastOutputAt should advance (${before} -> ${after})`);
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

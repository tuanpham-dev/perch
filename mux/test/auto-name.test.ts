import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitFor } from './wait.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const DAEMON = fileURLToPath(new URL('../src/daemon/index.ts', import.meta.url));

function makeEnv(): { env: Record<string, string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mux-name-'));
  return {
    dir,
    env: { ...process.env, PERCH_STATE_DIR: join(dir, 's'), PERCH_CONFIG_DIR: join(dir, 'c') } as Record<string, string>,
  };
}

function sp(env: Record<string, string>, ...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { env }).toString();
}

function killDaemons(env: Record<string, string>): void {
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const argv = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
      const env2 = readFileSync(`/proc/${d}/environ`, 'utf8');
      if (argv[1] === DAEMON && env2.includes(`PERCH_STATE_DIR=${env.PERCH_STATE_DIR}`)) process.kill(Number(d), 'SIGKILL');
    } catch { /* vanished or unreadable */ }
  }
}

type Win = { windowId: string; name: string; autoName: boolean };
const list = (env: Record<string, string>): Win[] => JSON.parse(sp(env, 'window', 'ls', '-t', 'n', '-j')) as Win[];

test('a window name follows the running command until renamed, and reset hands it back', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'n');
    await waitFor('the idle shell to name the window', () => /sh$/.test(list(env)[0]?.name ?? ''));
    assert.equal(list(env)[0]!.autoName, true);

    sp(env, 'send', 'n:0', 'sleep 30', '--enter');
    await waitFor('the window to be named after sleep', () => list(env)[0]?.name === 'sleep');

    const id = list(env)[0]!.windowId;
    sp(env, 'window', 'rename', `@${id}`, 'notes');
    const renamed = list(env)[0]!;
    assert.equal(renamed.name, 'notes', 'an id target reaches the window');
    assert.equal(renamed.autoName, false);

    sp(env, 'send', 'n:0', '\x03', '--enter');
    await waitFor('sleep to end', () => {
      const w = JSON.parse(sp(env, 'window', 'ls', '-t', 'n', '-j'))[0] as { foregroundCommand?: string };
      return /sh$/.test(w.foregroundCommand ?? '');
    });
    assert.equal(list(env)[0]!.name, 'notes', 'a chosen name stays after the command changes');

    sp(env, 'window', 'reset-name', 'n:notes');
    await waitFor('the name to follow the shell again', () => /sh$/.test(list(env)[0]?.name ?? ''));
    assert.equal(list(env)[0]!.autoName, true);
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a window created with a name keeps it', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'n');
    sp(env, 'window', 'new', '-t', 'n', '-n', 'logs');
    await waitFor('the second window', () => list(env).length === 2);
    const logs = list(env)[1]!;
    assert.equal(logs.name, 'logs');
    assert.equal(logs.autoName, false);
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

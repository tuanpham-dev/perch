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
  const dir = mkdtempSync(join(tmpdir(), 'mux-winfo-'));
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
      if (argv[1] === DAEMON && env2.includes(`PERCH_STATE_DIR=${env.PERCH_STATE_DIR}`)) {
        process.kill(Number(d), 'SIGKILL');
      }
    } catch { /* vanished or unreadable */ }
  }
}


test('window.list reports a real pid and the live foreground command', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'work', '-c', 'sleep 30');

    let windows: { pid: number; foregroundCommand?: string }[] = [];
    // The shell needs a moment to start and fork the declared command before
    // it shows up as the foreground process — poll rather than guess a delay.
    await waitFor('the declared command to become the foreground process', () => {
      windows = JSON.parse(sp(env, 'window', 'ls', '-t', 'work', '-j'));
      return windows[0]?.foregroundCommand === 'sleep';
    });

    assert.equal(windows.length, 1);
    const [w] = windows;
    assert.ok(w);
    assert.ok(Number.isInteger(w.pid) && w.pid > 1, 'pid is a real, plausible process id');
    // The reported pid must actually exist and be alive.
    assert.doesNotThrow(() => process.kill(w.pid, 0), 'reported pid is a live process');
    assert.equal(w.foregroundCommand, 'sleep');
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('window.list reports the shell name when idle (no foreground child)', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'idle');
    let windows: { foregroundCommand?: string }[] = [];
    await waitFor('the idle shell to report a foreground command', () => {
      windows = JSON.parse(sp(env, 'window', 'ls', '-t', 'idle', '-j'));
      return windows[0]?.foregroundCommand !== undefined;
    });
    // No declared command was typed, so the only foreground process is the shell itself.
    assert.match(windows[0]?.foregroundCommand ?? '', /sh$/);
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

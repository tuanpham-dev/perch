import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, waitFor } from './wait.ts';
import { killDaemons as killTestDaemons } from './procs.ts';
import type { ServerEvent, WindowInfo } from '../src/protocol/messages.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const DAEMON = fileURLToPath(new URL('../src/daemon/index.ts', import.meta.url));

function sp(env: Record<string, string>, ...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { env }).toString();
}

function killDaemons(env: Record<string, string>): void {
  killTestDaemons(DAEMON, env.PERCH_STATE_DIR!);
}

test('a listener hears structural changes and bells from windows nobody is viewing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mux-ev-'));
  const env = { ...process.env, PERCH_STATE_DIR: join(dir, 's'), PERCH_CONFIG_DIR: join(dir, 'c') } as Record<string, string>;
  // connection.ts resolves the socket from process.env at call time.
  process.env.PERCH_STATE_DIR = env.PERCH_STATE_DIR;
  process.env.PERCH_CONFIG_DIR = env.PERCH_CONFIG_DIR;
  const { connectOrSpawn } = await import('../src/client/connection.ts');
  const conn = await connectOrSpawn();
  try {
    const events: ServerEvent[] = [];
    conn.onEvent = (e) => events.push(e);
    await conn.request({ kind: 'events.subscribe' });

    sp(env, 'new', 'ev');
    await waitFor('sessions-changed after session.new', () => events.some((e) => e.event === 'sessions-changed'));

    const [w] = JSON.parse(sp(env, 'window', 'ls', '-t', 'ev', '-j')) as WindowInfo[];
    assert.ok(w);
    // A new window's first second of output (its prompt) isn't activity.
    await sleep(1200);
    sp(env, 'send', 'ev:0', "printf 'ding\\a\\n'", '--enter');
    const bell = await waitFor('a bell event', () => events.find((e) => e.event === 'bell'));
    assert.deepEqual(bell, { event: 'bell', session: 'ev', windowId: w.windowId });

    await waitFor('the unviewed window to report activity', () => {
      const [x] = JSON.parse(sp(env, 'window', 'ls', '-t', 'ev', '-j')) as WindowInfo[];
      return x?.activity === true;
    });

    // Attaching shows the window, which clears the flag.
    const viewer = await connectOrSpawn();
    try {
      await viewer.request({ kind: 'window.attach', target: `@${w.windowId}`, cols: 80, rows: 24 });
      await waitFor('activity to clear once viewed', () => {
        const [x] = JSON.parse(sp(env, 'window', 'ls', '-t', 'ev', '-j')) as WindowInfo[];
        return x?.activity === false;
      });
    } finally {
      viewer.close();
    }
  } finally {
    conn.close();
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

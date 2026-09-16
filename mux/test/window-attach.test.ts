import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FRAME_CONTROL, FRAME_OUTPUT, FRAME_INPUT,
  FrameReader, encodeControl, encodeFrame,
} from '../src/protocol/frames.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const DAEMON = fileURLToPath(new URL('../src/daemon/index.ts', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeEnv(): { env: Record<string, string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mux-watt-'));
  return {
    dir,
    env: { ...process.env, PERCH_STATE_DIR: join(dir, 's'), PERCH_CONFIG_DIR: join(dir, 'c') } as Record<string, string>,
  };
}
function sp(env: Record<string, string>, ...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { env }).toString();
}
function socketPathOf(env: Record<string, string>): string {
  return join(env.PERCH_STATE_DIR, 'daemon.sock');
}
function killDaemons(env: Record<string, string>): void {
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const argv = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0');
      const e2 = readFileSync(`/proc/${d}/environ`, 'utf8');
      if (argv[1] === DAEMON && e2.includes(`PERCH_STATE_DIR=${env.PERCH_STATE_DIR}`)) process.kill(Number(d), 'SIGKILL');
    } catch { /* gone */ }
  }
}

/** A test client that speaks the framed socket protocol and accumulates output. */
class Client {
  #sock;
  #reader = new FrameReader();
  output = '';
  ended = false;
  #id = 1;
  constructor(path: string) { this.#sock = connect(path); this.#sock.once('close', () => { this.ended = true; }); }
  ready(): Promise<void> {
    return new Promise((res, rej) => { this.#sock.once('connect', () => res()); this.#sock.once('error', rej); });
  }
  onClose(): Promise<void> { return new Promise((res) => this.#sock.once('close', () => res())); }
  #listen(): void {
    this.#sock.on('data', (chunk: Buffer) => {
      for (const f of this.#reader.push(chunk)) {
        if (f.type === FRAME_OUTPUT) this.output += f.payload.toString('utf8');
      }
    });
  }
  request(req: object): void { this.#sock.write(encodeControl({ id: this.#id++, ...req })); }
  attachSession(session: string): void { this.#listen(); this.request({ kind: 'session.attach', session, cols: 80, rows: 24 }); }
  attachWindow(target: string): void { this.#listen(); this.request({ kind: 'window.attach', target, cols: 80, rows: 24 }); }
  type(data: string): void { this.#sock.write(encodeFrame(FRAME_INPUT, Buffer.from(data, 'utf8'))); }
  close(): void { this.#sock.destroy(); }
}

test('window.attach pins a connection to one window; each sees only its own output', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'multi'); // window 0
    sp(env, 'window', 'new', '-t', 'multi', '-n', 'second'); // window 1
    await sleep(500);
    const path = socketPathOf(env);

    const a = new Client(path); await a.ready(); a.attachWindow('multi:0');
    const b = new Client(path); await b.ready(); b.attachWindow('multi:1');
    await sleep(400);

    // Marker printed in window 0 must reach A, not B.
    a.type('printf MARKER_ALPHA_0\\\\n\n');
    b.type('printf MARKER_BETA_1\\\\n\n');
    await sleep(700);

    assert.match(a.output, /MARKER_ALPHA_0/, 'window-0 client sees its own output');
    assert.doesNotMatch(a.output, /MARKER_BETA_1/, 'window-0 client does NOT see window-1 output');
    assert.match(b.output, /MARKER_BETA_1/, 'window-1 client sees its own output');
    assert.doesNotMatch(b.output, /MARKER_ALPHA_0/, 'window-1 client does NOT see window-0 output');

    a.close(); b.close();
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pinned window connection ends when its window is killed', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'pintest');
    sp(env, 'window', 'new', '-t', 'pintest', '-n', 'doomed'); // index 1
    await sleep(500);
    const b = new Client(socketPathOf(env)); await b.ready(); b.attachWindow('pintest:1');
    await sleep(300);
    const closed = b.onClose();
    sp(env, 'window', 'kill', 'pintest:1');
    // The daemon should end the pinned connection when its window dies.
    await Promise.race([closed, sleep(2000)]);
    assert.ok(b.ended, "pinned connection closed when its window was killed");
    // Session still alive (window 0), now down to one window.
    const windows = JSON.parse(sp(env, 'window', 'ls', '-t', 'pintest', '-j')) as unknown[];
    assert.equal(windows.length, 1, 'doomed window removed');
    b.close();
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session.attach still follows window switches (regression)', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'follow');
    sp(env, 'window', 'new', '-t', 'follow', '-n', 'w1');
    await sleep(500);
    const s = new Client(socketPathOf(env)); await s.ready(); s.attachSession('follow');
    await sleep(300);
    sp(env, 'window', 'select', 'follow:1');
    await sleep(300);
    s.type('printf SWITCHED_VIEW\\\\n\n');
    await sleep(600);
    assert.match(s.output, /SWITCHED_VIEW/, 'session client follows the switch and reaches window 1');
    s.close();
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killDaemons as killTestDaemons } from './procs.ts';
import xtermPkg from '@xterm/headless';
import { RESET_PREFIX } from '../src/daemon/raw-scrollback.ts';
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
  killTestDaemons(DAEMON, env.PERCH_STATE_DIR!);
}

/** A test client that speaks the framed socket protocol and accumulates output. */
class Client {
  #sock;
  #reader = new FrameReader();
  output = '';
  events: { event: string; partial?: boolean }[] = [];
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
        else if (f.type === FRAME_CONTROL) {
          const msg = JSON.parse(f.payload.toString('utf8'));
          if (typeof msg.event === 'string') this.events.push(msg);
        }
      }
    });
  }
  request(req: object): void { this.#sock.write(encodeControl({ id: this.#id++, ...req })); }
  attachSession(session: string): void { this.#listen(); this.request({ kind: 'session.attach', session, cols: 80, rows: 24 }); }
  attachWindow(target: string, tail = false, cols = 80): void { this.#listen(); this.request({ kind: 'window.attach', target, cols, rows: 24, tail }); }
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

test('a tail attach replays only recent history until history.full', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'tailtest');
    await sleep(500);
    const path = socketPathOf(env);
    const w = new Client(path); await w.ready(); w.attachWindow('tailtest:0');
    await sleep(300);
    // About 190 KB of output: well past the 64 KB tail.
    w.type('seq -f "row-%06g" 1 20000; echo SEQ_DONE\n');
    for (let i = 0; i < 50 && !/SEQ_DONE\r?\n/.test(w.output); i++) await sleep(100);
    w.close();

    const t = new Client(path); await t.ready(); t.attachWindow('tailtest:0', true);
    await sleep(500);
    assert.ok(t.output.length <= 65 * 1024, `tail replay is at most 64 KB (got ${t.output.length})`);
    assert.match(t.output, /row-020000/, 'tail has the newest lines');
    assert.doesNotMatch(t.output, /row-000001\r?\n/, 'tail leaves out the oldest lines');
    assert.deepEqual(t.events.filter((e) => e.event === 'replayed').map((e) => e.partial), [true], 'replayed says partial');

    t.request({ kind: 'history.full' });
    await sleep(500);
    assert.match(t.output, /row-0(0[0-9]{4})\r?\n[\s\S]*row-020000/, 'full replay follows with older lines');
    assert.equal(t.output.length > 128 * 1024, true, 'full replay is the whole log');
    assert.deepEqual(t.events.filter((e) => e.event === 'replayed').map((e) => e.partial), [true, undefined], 'second replay is complete');

    // window.refresh replays the window as it is now: the tail, or all of it
    // with `full`, for a viewer whose screen drifted.
    let before = t.output.length;
    t.request({ kind: 'window.refresh' });
    await sleep(500);
    const tail = t.output.slice(before);
    assert.ok(tail.length <= 65 * 1024 && /row-020000/.test(tail), 'a refresh replays the tail');
    before = t.output.length;
    t.request({ kind: 'window.refresh', full: true });
    await sleep(500);
    assert.ok(t.output.length - before > 128 * 1024, 'a full refresh replays everything');
    assert.deepEqual(t.events.filter((e) => e.event === 'replayed').map((e) => e.partial), [true, undefined, true, undefined], 'each refresh ends with replayed');
    t.close();
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

test('a viewer attaching while a full-screen program runs sees that program, not the shell', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'fullscreen');
    await sleep(500);
    const path = socketPathOf(env);
    const a = new Client(path); await a.ready(); a.attachWindow('fullscreen:0');
    await sleep(400);
    // What vim does: switch to the alternate screen, draw, and keep running.
    a.type("printf '\\033[?1049hFULLSCREEN_FRAME'; sleep 30\n");
    await sleep(900);

    // A second viewer - a reloaded page - gets the replay.
    const b = new Client(path); await b.ready(); b.attachWindow('fullscreen:0');
    await sleep(700);
    const term = new xtermPkg.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    await new Promise<void>((done) => term.write(b.output, done));
    const screen = Array.from({ length: term.rows }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
    assert.equal(term.buffer.active.type, 'alternate', 'the replay leaves the viewer on the alternate screen');
    assert.match(screen, /FULLSCREEN_FRAME/, 'with the program\'s frame on it');
    a.close(); b.close();
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a viewer attaching at another width gets the reflowed screen, not cursor moves meant for the old one', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'reflow');
    await sleep(500);
    const path = socketPathOf(env);
    const a = new Client(path); await a.ready(); a.attachWindow('reflow:0');
    await sleep(400);
    // What an agent's live region does at 80 columns: print a 60-column
    // line, then go up one row and redraw it. At 40 columns that line takes
    // two rows, so the same cursor move would erase only its second half.
    a.type("printf '%060d\\n\\033[1A\\033[2KREDRAWN\\n' 0\n");
    await sleep(700);

    // A narrower viewer (a phone) takes over the window, then reattaches.
    const b = new Client(path); await b.ready(); b.attachWindow('reflow:0', false, 40);
    await sleep(700);
    const term = new xtermPkg.Terminal({ cols: 40, rows: 24, allowProposedApi: true });
    await new Promise<void>((done) => term.write(b.output, done));
    const screen = Array.from({ length: term.rows }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
    assert.match(screen, /REDRAWN/, 'the redraw is on screen');
    assert.doesNotMatch(screen, /0{20}/, 'and the line it replaced is gone, not half left behind');

    // That attach rebuilt the raw log for 40 columns; a later viewer at the
    // same width replays it, with output from after the resize still in it.
    // (With the 80-column viewer gone first, so nothing resizes it back.)
    a.close();
    b.type("echo AFTER-RESIZE\n");
    await sleep(500);
    b.close();
    const c = new Client(path); await c.ready(); c.attachWindow('reflow:0', false, 40);
    await sleep(700);
    assert.ok(c.output.startsWith(RESET_PREFIX), 'a raw replay, not the serialize fallback');
    const term2 = new xtermPkg.Terminal({ cols: 40, rows: 24, allowProposedApi: true });
    await new Promise<void>((done) => term2.write(c.output, done));
    const screen2 = Array.from({ length: term2.rows }, (_, i) => term2.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');
    assert.match(screen2, /REDRAWN/, 'the rebuilt log keeps the redraw');
    assert.match(screen2, /^AFTER-RESIZE$/m, 'and the output that followed it');
    assert.doesNotMatch(screen2, /0{20}/, 'without the replaced line');
    c.close();
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

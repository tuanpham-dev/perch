import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRAME_OUTPUT, FrameReader, encodeControl, encodeFrame, FRAME_INPUT } from '../src/protocol/frames.ts';
import { waitForMatch } from './wait.ts';

// A window is sized to its ACTIVE viewer, not the smallest one (this daemon diverges
// from tmux here: browser panes re-render on demand, so an idle phone must not
// shrink the desktop the user is actually working in).

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;
const DAEMON = new URL('../src/daemon/index.ts', import.meta.url).pathname;

function makeEnv(): { env: Record<string, string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mux-act-'));
  return { dir, env: { ...process.env, PERCH_STATE_DIR: join(dir, 's'), PERCH_CONFIG_DIR: join(dir, 'c') } as Record<string, string> };
}
function sp(env: Record<string, string>, ...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { env }).toString();
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

class Viewer {
  #sock;
  #reader = new FrameReader();
  #id = 1;
  output = '';
  constructor(path: string) { this.#sock = connect(path); }
  ready(): Promise<void> {
    return new Promise((res, rej) => { this.#sock.once('connect', () => res()); this.#sock.once('error', rej); });
  }
  resize(cols: number, rows: number): void {
    this.#sock.write(encodeControl({ id: this.#id++, kind: 'resize', cols, rows }));
  }
  attach(session: string, cols: number, rows: number): void {
    this.#sock.on('data', (c: Buffer) => {
      for (const f of this.#reader.push(c)) if (f.type === FRAME_OUTPUT) this.output += f.payload.toString('latin1');
    });
    this.#sock.write(encodeControl({ id: this.#id++, kind: 'session.attach', session, cols, rows }));
  }
  activate(): void { this.#sock.write(encodeControl({ id: this.#id++, kind: 'activate' })); }
  type(s: string): void { this.#sock.write(encodeFrame(FRAME_INPUT, Buffer.from(s, 'utf8'))); }
  close(): void { this.#sock.destroy(); }
}

/** Ask the shell what size its PTY actually is. */
function ptySize(env: Record<string, string>): string {
  sp(env, 'send', 'sz:0', 'stty size', '--enter');
  return sp(env, 'capture', 'sz:0', '-S', '4');
}

test('the window sizes to the ACTIVE viewer, not the smallest', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'sz');
    await waitForMatch('the session to be listed', () => sp(env, 'ls'), /\bsz\b/);
    const sock = join(env.PERCH_STATE_DIR, 'daemon.sock');

    // Big viewer attaches first and is therefore active.
    const big = new Viewer(sock); await big.ready(); big.attach('sz', 160, 50);
    await waitForMatch('sized to the only (big) viewer', () => ptySize(env), /50 160/);

    // A small viewer attaches: it becomes the active one and the window reflows
    // DOWN to it. (Under tmux's min rule this would also be small — the next
    // step is what distinguishes the two rules.)
    const small = new Viewer(sock); await small.ready(); small.attach('sz', 60, 20);
    await waitForMatch('reflowed to the newly-active small viewer', () => ptySize(env), /20 60/);

    // The big viewer claims it back while the small one STAYS attached. Under
    // tmux's smallest-client rule this would stay 20x60 forever.
    big.activate();
    await waitForMatch('active big viewer wins over an idle smaller one', () => ptySize(env), /50 160/);

    // Typing also counts as activity: the small viewer types and reclaims.
    small.type('\r');
    await waitForMatch('typing reclaims the window for that viewer', () => ptySize(env), /20 60/);

    big.close(); small.close();
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resizing a viewer claims the window and reflows to it', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'sz');
    await waitForMatch('the session to be listed', () => sp(env, 'ls'), /\bsz\b/);
    const sock = join(env.PERCH_STATE_DIR, 'daemon.sock');

    const a = new Viewer(sock); await a.ready(); a.attach('sz', 100, 30);
    await waitForMatch('A to size the window', () => ptySize(env), /30 100/);
    const b = new Viewer(sock); await b.ready(); b.attach('sz', 60, 20);
    await waitForMatch('newest attach is active', () => ptySize(env), /20 60/);

    // Viewer A drags its window bigger. Resizing a view is using it, so A
    // claims and the window follows — otherwise a user resizing their browser
    // would see nothing happen while another viewer held the size.
    a.resize(140, 45);
    await waitForMatch('resizing claimed the window for A', () => ptySize(env), /45 140/);

    // B re-sends the size it already had, as a browser does when it merely
    // re-measures (reconnect, settings sync). That is not using the view: A
    // keeps the window.
    b.resize(60, 20);
    b.resize(60, 20);
    await new Promise((r) => setTimeout(r, 300));
    assert.match(ptySize(env), /45 140/, 'an unchanged resize does not claim the window');

    a.close(); b.close();
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

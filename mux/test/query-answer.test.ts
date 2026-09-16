import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForMatch } from './wait.ts';
import { FRAME_OUTPUT, FrameReader, encodeControl } from '../src/protocol/frames.ts';

// The daemon answers capability queries from its own copy of the terminal.
//
// Nothing else can, reliably. A browser's answer crosses a socket twice and
// often arrives after the asking program has stopped reading, landing at the
// prompt as garbage — and with no browser attached at all there is nobody to
// answer, so a program that asks simply waits out its timeout.

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;
const DAEMON = new URL('../src/daemon/index.ts', import.meta.url).pathname;

function makeEnv(): { env: Record<string, string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mux-q-'));
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

test('a cursor-position query is answered with no viewer attached', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'q');
    await waitForMatch('the session to be listed', () => sp(env, 'ls'), /\bq\b/);

    // Ask, then read the reply with a timeout. Without an answer this prints
    // an empty CPR and the test fails on the missing row/column.
    sp(env, 'send', 'q:0',
      `bash -c 'printf "\\033[6n"; IFS= read -r -s -t 3 -d R p; printf "CPR<%s>\\n" "$(printf %s "$p" | tr -d "\\033[")"'`,
      '--enter');

    const out = await waitForMatch('the reply to reach the asking program',
      () => sp(env, 'capture', 'q:0', '-S', '20'), /CPR<\d+;\d+>/);
    assert.match(out, /CPR<\d+;\d+>/, 'the program received a row;column report');
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a replayed query is not answered into a shell that never asked', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'config', 'set', 'snapshotDebounceMs', '300');
    sp(env, 'new', 'r');
    await waitForMatch('the session to be listed', () => sp(env, 'ls'), /\br\b/);
    // Put a query into the scrollback, so restoring replays it.
    sp(env, 'send', 'r:0', `printf 'MARKER\\033[c'`, '--enter');
    await waitForMatch('the marker to land', () => sp(env, 'capture', 'r:0', '-S', '20'), /MARKER/);

    killDaemons(env);
    await waitForMatch('a respawned daemon', () => sp(env, 'ls'), /\br\b/);

    // The restored shell must be at a clean prompt. A replayed query answered
    // into it would appear as the response text typed at that prompt.
    const after = await waitForMatch('the restore banner',
      () => sp(env, 'capture', 'r:0', '-S', '30'), /\[restored/);
    const afterBanner = after.slice(after.indexOf('[restored'));
    assert.doesNotMatch(afterBanner, /\??1;2c/, `replayed query was answered into the shell:\n${afterBanner}`);
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

// A viewer that reports its theme colors on attach, the way the browser does.
class ColorViewer {
  #sock;
  #reader = new FrameReader();
  output = '';
  constructor(path: string) { this.#sock = connect(path); }
  ready(): Promise<void> {
    return new Promise((res, rej) => { this.#sock.once('connect', () => res()); this.#sock.once('error', rej); });
  }
  attach(session: string, colors?: { foreground?: string; background?: string }): void {
    this.#sock.on('data', (chunk: Buffer) => {
      for (const f of this.#reader.push(chunk)) if (f.type === FRAME_OUTPUT) this.output += f.payload.toString('utf8');
    });
    this.#sock.write(encodeControl({ id: 1, kind: 'session.attach', session, cols: 80, rows: 24, colors }));
  }
  close(): void { this.#sock.destroy(); }
}

const ASK_BG = `bash -c 'printf "\\033]11;?\\033\\\\"; IFS= read -r -s -t 3 -d "\\\\" p; printf "B""G<%s>\\n" "$(printf %s "$p" | tr -d "\\033]")"'`;

test('a background-color query is answered with the attached viewer\'s theme color', async () => {
  const { env, dir } = makeEnv();
  let viewer: ColorViewer | null = null;
  try {
    sp(env, 'new', 'c');
    await waitForMatch('the session to be listed', () => sp(env, 'ls'), /\bc\b/);
    viewer = new ColorViewer(join(env.PERCH_STATE_DIR, 'daemon.sock'));
    await viewer.ready();
    viewer.attach('c', { foreground: '#d4d4d4', background: '#24292e' });
    await new Promise((r) => setTimeout(r, 300));

    sp(env, 'send', 'c:0', ASK_BG, '--enter');
    const out = await waitForMatch('the reply to reach the asking program',
      () => sp(env, 'capture', 'c:0', '-S', '20'), /BG<[^>]*>/);
    assert.match(out, /BG<11;rgb:2424\/2929\/2e2e>/, 'the program received the viewer\'s background');
  } finally {
    viewer?.close();
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a background-color query goes unanswered when no viewer reported colors', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'n');
    await waitForMatch('the session to be listed', () => sp(env, 'ls'), /\bn\b/);
    sp(env, 'send', 'n:0', ASK_BG, '--enter');
    const out = await waitForMatch('the asking program to time out',
      () => sp(env, 'capture', 'n:0', '-S', '20'), /BG<[^>]*>/);
    assert.match(out, /BG<>/, 'nothing answered, so the read timed out empty');
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

const askTermcap = (hexName: string) =>
  `bash -c 'printf "\\033P+q${hexName}\\033\\\\"; IFS= read -r -s -t 3 -d "\\\\" p; printf "T""C<%s>\\n" "$(printf %s "$p" | tr -d "\\033")"'`;

test('XTGETTCAP Ms is answered with the OSC 52 template, so nvim copies to the clipboard', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 't');
    await waitForMatch('the session to be listed', () => sp(env, 'ls'), /\bt\b/);
    sp(env, 'send', 't:0', askTermcap('4d73'), '--enter');
    const out = await waitForMatch('the reply to reach the asking program',
      () => sp(env, 'capture', 't:0', '-S', '20'), /TC<[^>]*>/);
    // Ms = "\E]52;%p1%s;%p2%s\E\\" in terminfo text form, hex-encoded.
    assert.match(out, /TC<P1\+r4d73=5c455d35323b25703125733b25703225735c455c5c>/, 'the Ms capability came back valid, with the OSC 52 template');
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('XTGETTCAP for a capability the terminal lacks is answered invalid, not left hanging', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'u');
    await waitForMatch('the session to be listed', () => sp(env, 'ls'), /\bu\b/);
    sp(env, 'send', 'u:0', askTermcap('5a7a'), '--enter');
    const out = await waitForMatch('the reply to reach the asking program',
      () => sp(env, 'capture', 'u:0', '-S', '20'), /TC<[^>]*>/);
    assert.match(out, /TC<P0\+r>/, 'an invalid reply arrived immediately');
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

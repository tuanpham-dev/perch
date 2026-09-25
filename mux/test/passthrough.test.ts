import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME_OUTPUT, FRAME_INPUT, FrameReader, encodeControl, encodeFrame } from '../src/protocol/frames.ts';
import { sleep, waitFor, waitForMatch } from './wait.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const DAEMON = fileURLToPath(new URL('../src/daemon/index.ts', import.meta.url));

// Escape sequences we require to survive replay verbatim:
const OSC8 = '\x1b]8;;https://mux.example/docs\x1b\\'; // hyperlink start (ST-terminated)
const OSC133 = '\x1b]133;A\x1b\\'; // prompt-start mark
const MARK = 'PROMPT_MARKER_XYZZY';

function makeEnv(): { env: Record<string, string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mux-pass-'));
  return {
    dir,
    env: { ...process.env, PERCH_STATE_DIR: join(dir, 's'), PERCH_CONFIG_DIR: join(dir, 'c') } as Record<string, string>,
  };
}
function sp(env: Record<string, string>, ...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { env }).toString();
}
function socketPathOf(env: Record<string, string>): string { return join(env.PERCH_STATE_DIR, 'daemon.sock'); }
function daemonPid(env: Record<string, string>): number {
  return Number(readFileSync(join(env.PERCH_STATE_DIR, 'daemon.pid'), 'utf8').trim());
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

class Client {
  #sock;
  #reader = new FrameReader();
  output = '';
  #id = 1;
  constructor(path: string) { this.#sock = connect(path); }
  ready(): Promise<void> { return new Promise((res, rej) => { this.#sock.once('connect', () => res()); this.#sock.once('error', rej); }); }
  attachWindow(target: string): void {
    this.#sock.on('data', (chunk: Buffer) => {
      for (const f of this.#reader.push(chunk)) if (f.type === FRAME_OUTPUT) this.output += f.payload.toString('latin1');
    });
    this.#sock.write(encodeControl({ id: this.#id++, kind: 'window.attach', target, cols: 80, rows: 24 }));
  }
  type(data: string): void { this.#sock.write(encodeFrame(FRAME_INPUT, Buffer.from(data, 'latin1'))); }
  close(): void { this.#sock.destroy(); }
}

// printf the OSC 8 link + OSC 133 mark + a plain marker into the window. Using
// printf keeps the bytes exact (no shell mangling of the escapes).
function emitEscapes(env: Record<string, string>, target: string): void {
  // octal escapes: \033 = ESC, \134 = backslash (ST is ESC + backslash)
  const payload = `printf '\\033]8;;https://mux.example/docs\\033\\134${MARK}\\033]8;;\\033\\134 \\033]133;A\\033\\134done\\n'`;
  sp(env, 'send', target, payload, '--enter');
}

test('OSC 8 and OSC 133 survive a live attach replay byte-for-byte', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'esc');
    await waitForMatch('the session to be listed', () => sp(env, 'ls'), /\besc\b/);
    emitEscapes(env, 'esc:0');
    await waitForMatch('the escapes to reach the window', () => sp(env, 'capture', 'esc:0'), /done/);

    // A client attaching AFTER the escapes were emitted must still receive them
    // in its replayed scrollback — this is the T1.6 payoff over serialize.
    const c = new Client(socketPathOf(env)); await c.ready(); c.attachWindow('esc:0');
    // Wait on the OSC 8 sequence specifically. A bare OSC 133 mark would be
    // the wrong signal — the shell's own prompt integration emits those, so it
    // is already present before the printf runs. The literal "\033" in the
    // echoed command line can't match this: it wants a real ESC byte.
    await waitFor('the replay to carry the emitted OSC 8 link',
      () => /\x1b\]8;;https:\/\/mux\.example\/docs/.test(c.output));
    assert.match(c.output, /\x1b\]8;;https:\/\/mux\.example\/docs/, 'OSC 8 hyperlink URL preserved in replay');
    assert.match(c.output, /\x1b\]133;A/, 'OSC 133 prompt mark preserved in replay');
    assert.match(c.output, new RegExp(MARK), 'link text present');
    c.close();
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('multi-byte UTF-8 survives replay byte-for-byte', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'new', 'utf8');
    await waitForMatch('the session to be listed', () => sp(env, 'ls'), /\butf8\b/);
    // Box drawing, accents, CJK, and an astral-plane emoji — all multi-byte.
    // A latin1 round-trip anywhere in the pipeline mangles these; ASCII-only
    // escapes (OSC 8/133) would not have caught it.
    sp(env, 'send', 'utf8:0', `printf 'MB: \\342\\224\\214\\342\\224\\200\\342\\224\\220 caf\\303\\251 \\346\\227\\245\\346\\234\\254\\350\\252\\236 \\360\\237\\232\\200\\n'`, '--enter');
    await waitForMatch('the text to reach the window', () => sp(env, 'capture', 'utf8:0'), /MB:/);

    const c = new Client(socketPathOf(env)); await c.ready(); c.attachWindow('utf8:0');
    await waitFor('the replay to carry the astral-plane emoji',
      () => Buffer.from(c.output, 'latin1').toString('utf8').includes('\u{1F680}'));
    // The client collects latin1 (raw bytes); decode as UTF-8 to compare.
    const decoded = Buffer.from(c.output, 'latin1').toString('utf8');
    assert.match(decoded, /┌─┐/, 'box drawing survived replay');
    assert.match(decoded, /café/, 'accented latin survived replay');
    assert.match(decoded, /日本語/, 'CJK survived replay');
    assert.match(decoded, /🚀/, 'astral-plane emoji survived replay');
    c.close();
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OSC 8 and OSC 133 survive a reboot (raw sidecar restore)', async () => {
  const { env, dir } = makeEnv();
  try {
    sp(env, 'config', 'set', 'snapshotDebounceMs', '300');
    // Killed hard and read back within seconds: a window may not wait 30 s for its second save.
    sp(env, 'config', 'set', 'scrollbackWriteIntervalMs', '0');
    sp(env, 'new', 'reboot-esc');
    await sleep(500);
    emitEscapes(env, 'reboot-esc:0');

    // Wait until the ESCAPES THEMSELVES are in the persisted sidecar before
    // killing the daemon. A fixed sleep raced the shell: under load the
    // snapshot could capture only the echoed command line (before printf ran),
    // so the restore had nothing to replay and the test failed for a reason
    // that had nothing to do with restore.
    const sidecarHasEscape = (): boolean => {
      try {
        const dir = join(env.PERCH_STATE_DIR, 'scrollback');
        return readdirSync(dir)
          .filter((f) => f.endsWith('.raw'))
          .some((f) => {
            const body = readFileSync(join(dir, f), 'latin1');
            // The emitted OSC 8 sequence, not the echoed command text (which
            // contains the literal backslash-escaped form).
            return body.includes('\x1b]8;;https://mux.example/docs');
          });
      } catch { return false; }
    };
    for (let i = 0; i < 40 && !sidecarHasEscape(); i++) await sleep(150);
    assert.ok(sidecarHasEscape(), 'precondition: escapes reached the persisted sidecar');

    const before = daemonPid(env);
    process.kill(before, 'SIGKILL');
    killDaemons(env);
    await sleep(400);

    // Respawn via any command, then wait until the restored session is actually
    // listed before attaching (a fixed sleep flakes under CPU contention).
    for (let i = 0; i < 30; i++) {
      if (sp(env, 'ls').includes('reboot-esc')) break;
      await sleep(200);
    }
    await sleep(400); // let the restored window's shell settle
    const c = new Client(socketPathOf(env)); await c.ready(); c.attachWindow('reboot-esc:0');
    await sleep(700);
    assert.match(c.output, /\x1b\]8;;https:\/\/mux\.example\/docs/, 'OSC 8 URL survived reboot via raw sidecar');
    assert.match(c.output, /\x1b\]133;A/, 'OSC 133 mark survived reboot via raw sidecar');
    assert.match(c.output, /\[restored /, 'restore banner present');
    c.close();
  } finally {
    killDaemons(env);
    rmSync(dir, { recursive: true, force: true });
  }
});

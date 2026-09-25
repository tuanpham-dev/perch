import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Snapshotter } from '../src/daemon/persistence.ts';
import { SessionStore } from '../src/daemon/session-store.ts';
import type { Window } from '../src/daemon/window.ts';
import { ensureStateDirs, scrollbackDir, statePath } from '../src/util/paths.ts';

// A window as the snapshotter sees it: the flag it reads and clears, plus the
// content it writes. serializeState is stamped so a rewrite is visible.
type Fake = Window & { serializeCalls: number; failSerialize: boolean };
function fakeWindow(id: string): Fake {
  const w = {
    id, name: id, autoName: true, restoredCommands: null, command: undefined, cols: 80, rows: 24, exited: false,
    scrollbackDirty: true, serializeCalls: 0, failSerialize: false,
    serializeState() { if (w.failSerialize) throw new Error('boom'); w.serializeCalls++; return `${id} replay #${w.serializeCalls}`; },
    rawBytes() { return Buffer.from(`${id} raw #${w.serializeCalls}`); },
    descendantCommands() { return ['zsh']; },
    liveCwd() { return '/'; },
  };
  return w as unknown as Fake;
}

const DEBOUNCE = 2000;
const INTERVAL = 30000;
let dir: string;
let savedStateDir: string | undefined;
let a: Fake, b: Fake;
let store: SessionStore<Window>;
let interval = INTERVAL;
let persist = true;
let snap: Snapshotter;

const txt = (w: Fake) => readFileSync(join(scrollbackDir(), `${w.id}.txt`), 'utf8');
const raw = (w: Fake) => readFileSync(join(scrollbackDir(), `${w.id}.raw`), 'utf8');
const savedAt = () => (JSON.parse(readFileSync(statePath(), 'utf8')) as { savedAt: number }).savedAt;
/** Output arrived: what the PTY handler does, then the debounce tick fires. */
function printsAndTicks(...ws: Fake[]): void {
  for (const w of ws) w.scrollbackDirty = true;
  snap.schedule();
  mock.timers.tick(DEBOUNCE);
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  savedStateDir = process.env.PERCH_STATE_DIR;
  dir = mkdtempSync(join(tmpdir(), 'sp-persist-test-'));
  process.env.PERCH_STATE_DIR = dir;
  ensureStateDirs();
  a = fakeWindow('aaaa'); b = fakeWindow('bbbb');
  store = new SessionStore<Window>();
  store.sessions.set('s', { id: 'sid', name: 's', windows: [a, b], currentIndex: 0, createdAt: Date.now(), rootCwd: '/' });
  interval = INTERVAL; persist = true;
  snap = new Snapshotter(store, () => 100, () => DEBOUNCE, () => null, () => persist, () => interval);
  // The first snapshot after start saves every window (all start dirty).
  snap.schedule(); mock.timers.tick(DEBOUNCE);
  assert.equal(txt(a), 'aaaa replay #1'); assert.equal(txt(b), 'bbbb replay #1');
});

afterEach(() => {
  mock.timers.reset();
  if (savedStateDir === undefined) delete process.env.PERCH_STATE_DIR; else process.env.PERCH_STATE_DIR = savedStateDir;
  rmSync(dir, { recursive: true, force: true });
});

test('A1: a debounced snapshot rewrites only the window that printed, txt and raw together', () => {
  mock.timers.tick(INTERVAL + 1000);
  printsAndTicks(a);
  assert.equal(txt(a), 'aaaa replay #2'); assert.equal(raw(a), 'aaaa raw #2');
  assert.equal(txt(b), 'bbbb replay #1'); assert.equal(raw(b), 'bbbb raw #1');
  assert.equal(a.scrollbackDirty, false);
});

test('A2: a window saved inside the interval is skipped, and state.json is still refreshed', () => {
  const t0 = savedAt();
  mock.timers.tick(5000);
  printsAndTicks(a);
  assert.equal(txt(a), 'aaaa replay #1', 'skipped: saved 7 s ago');
  assert.equal(a.scrollbackDirty, true);
  assert.equal(savedAt(), t0 + 7000, 'state.json written on the tick anyway');
  mock.timers.tick(INTERVAL);
  printsAndTicks(a);
  assert.equal(txt(a), 'aaaa replay #2', 'written once past the interval');
});

test('A3: a skipped window is written when it becomes due, with no further activity', () => {
  mock.timers.tick(5000);
  printsAndTicks(a); // skipped at t+7 s, due at t+30 s
  assert.equal(txt(a), 'aaaa replay #1');
  mock.timers.tick(INTERVAL - 7000 - 1);
  assert.equal(txt(a), 'aaaa replay #1', 'not yet');
  mock.timers.tick(1);
  assert.equal(txt(a), 'aaaa replay #2', 'the due timer wrote it');
  assert.equal(a.scrollbackDirty, false);
});

test('A4: an immediate snapshot writes a dirty window however recently it was saved', () => {
  mock.timers.tick(1000);
  a.scrollbackDirty = true;
  snap.now();
  assert.equal(txt(a), 'aaaa replay #2');
  assert.equal(txt(b), 'bbbb replay #1', 'a clean window is left alone');
});

test('A5: a window with no output is saved once and never rewritten', () => {
  mock.timers.tick(INTERVAL + 1000);
  snap.schedule(); mock.timers.tick(DEBOUNCE);
  snap.now();
  assert.equal(b.serializeCalls, 1);
  assert.equal(txt(b), 'bbbb replay #1');
});

test('A7: with scrollback saving off nothing is written and files are swept; back on, what printed meanwhile is saved', () => {
  persist = false;
  printsAndTicks(a);
  assert.deepEqual(readdirSync(scrollbackDir()), [], 'saved history removed');
  assert.equal(a.scrollbackDirty, true, 'still owed a save');
  persist = true;
  mock.timers.tick(1000);
  printsAndTicks();
  assert.equal(txt(a), 'aaaa replay #2', 'saved at the first snapshot after turning it on');
  assert.equal(existsSync(join(scrollbackDir(), 'bbbb.txt')), false, 'b printed nothing, so it has no file yet');
});

test('a failed serialize leaves the window dirty with neither file rewritten, and the next snapshot retries', () => {
  mock.timers.tick(INTERVAL + 1000);
  a.failSerialize = true;
  printsAndTicks(a);
  assert.equal(txt(a), 'aaaa replay #1'); assert.equal(raw(a), 'aaaa raw #1');
  assert.equal(a.scrollbackDirty, true);
  a.failSerialize = false;
  printsAndTicks();
  assert.equal(txt(a), 'aaaa replay #2'); assert.equal(raw(a), 'aaaa raw #2');
});

test('interval 0 saves a dirty window on every debounced snapshot', () => {
  interval = 0;
  printsAndTicks(a);
  printsAndTicks(a);
  assert.equal(txt(a), 'aaaa replay #3');
});

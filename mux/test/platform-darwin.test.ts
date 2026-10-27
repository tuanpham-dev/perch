import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DarwinProcs, parseLsofCwd, parsePs } from '../src/platform/darwin-procs.ts';

const PS = [
  '    1     0 /sbin/launchd',
  '  200     1 -zsh',
  '  300   200 /usr/local/bin/nvim',
  '  302   200 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '',
].join('\n');

test('parses ps rows, keeping a name with spaces whole', () => {
  const procs = parsePs(PS);
  assert.equal(procs.size, 4);
  assert.deepEqual(procs.get(200), { pid: 200, ppid: 1, comm: '-zsh' });
  assert.equal(procs.get(302)!.comm, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
});

test('parses lsof -Fn into pid -> cwd', () => {
  const out = 'p200\nfcwd\nn/Users/me/project\np300\nfcwd\nn/tmp/with space\n';
  assert.deepEqual([...parseLsofCwd(out)], [[200, '/Users/me/project'], [300, '/tmp/with space']]);
});

// A fake clock and timer, and fake ps/lsof that count their synchronous
// runs and hold async answers until the test releases them.
function harness() {
  let now = 10_000;
  let ps = PS;
  let lsof = 'p200\nfcwd\nn/a\n';
  const sync: string[] = [];
  const pending: Array<() => void> = [];
  const timers: Array<{ at: number; fn: () => void }> = [];
  let changes = 0;
  const procs = new DarwinProcs(
    (cmd) => { sync.push(cmd); return cmd === 'ps' ? ps : lsof; },
    (cmd, _args, done) => { pending.push(() => done(cmd === 'ps' ? ps : lsof)); },
    () => now,
    (fn, ms) => { timers.push({ at: now + ms, fn }); },
  );
  procs.onChange(() => { changes++; });
  return {
    procs, sync, pending,
    changes: () => changes,
    setPs: (out: string) => { ps = out; },
    setLsof: (out: string) => { lsof = out; },
    // Moves the clock on, firing the timers that came due.
    tick: (ms: number) => {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    },
    flush: () => { while (pending.length) pending.shift()!(); },
  };
}

test('one ps answers a whole walk, and the next one runs in the background a second later', () => {
  const h = harness();
  assert.deepEqual(h.procs.childPids(200), [300, 302]);
  assert.equal(h.procs.comm(300), '/usr/local/bin/nvim');
  assert.deepEqual(h.procs.childPids(300), []);
  assert.deepEqual(h.sync, ['ps'], 'a single run for the whole walk');
  assert.equal(h.pending.length, 0, 'nothing more until the table is a second old');

  h.setPs(PS + '  303   200 /bin/sleep\n');
  h.tick(999);
  assert.equal(h.pending.length, 0);
  h.tick(1);
  assert.equal(h.pending.length, 1, 'the read a second ago is checked again');
  assert.deepEqual(h.procs.childPids(200), [300, 302], 'the latest finished answer, straight away');
  assert.equal(h.pending.length, 1, 'one refresh at a time');
  h.flush();
  assert.deepEqual(h.procs.childPids(200), [300, 302, 303]);
  assert.equal(h.changes(), 1, 'a command started right after the read is reported');
  assert.deepEqual(h.sync, ['ps'], 'nothing waited on');
});

test('a refresh that changes nothing asked about stays quiet, and stops', () => {
  const h = harness();
  h.procs.childPids(200);
  h.setPs(PS + '  900     1 /usr/sbin/unrelated\n');
  h.tick(1_000);
  h.flush();
  assert.equal(h.changes(), 0);
  h.tick(5_000);
  assert.equal(h.pending.length, 0, 'nobody read since: no more runs');
});

test('a pid the table lacks waits for a fresh one, at most once a second', () => {
  const h = harness();
  h.procs.comm(200);
  h.setPs(PS + '  400     1 /bin/zsh\n');
  assert.equal(h.procs.comm(400), undefined, 'the table is under a second old');
  h.tick(1_000);
  h.flush();
  assert.equal(h.procs.comm(400), '/bin/zsh', 'a window that just spawned is found');
  h.flush();
  h.tick(1_500);
  const before = h.sync.length;
  for (let i = 0; i < 5; i++) assert.equal(h.procs.comm(999), undefined);
  assert.ok(h.sync.length - before <= 1, 'a dead pid costs one run at most, not one per question');
});

test('cwds come from one lsof for every pid asked about, and a cd is reported', () => {
  const h = harness();
  assert.equal(h.procs.cwd(200), '/a');
  h.setLsof('p300\nfcwd\nn/b\n');
  assert.equal(h.procs.cwd(300), '/b');
  assert.deepEqual(h.sync, ['lsof', 'lsof'], 'each pid looked up once while it waits');

  h.setLsof('p200\nfcwd\nn/a/next\np300\nfcwd\nn/b\n');
  h.tick(1_000);
  assert.equal(h.procs.cwd(200), '/a', 'stale until the batch answers');
  h.flush();
  assert.equal(h.procs.cwd(200), '/a/next');
  assert.equal(h.changes(), 1);

  // Missing from the next batch: gone, so asked afresh next time.
  h.setLsof('p200\nfcwd\nn/a/next\n');
  h.tick(1_000);
  h.flush();
  h.setLsof('');
  assert.equal(h.procs.cwd(300), null);
  assert.deepEqual(h.sync, ['lsof', 'lsof', 'lsof']);
});

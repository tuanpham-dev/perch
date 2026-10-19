import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RawScrollback, RESET_PREFIX } from '../src/daemon/raw-scrollback.ts';

test('retains bytes verbatim under the cap', () => {
  const rs = new RawScrollback(1024);
  rs.push(Buffer.from('hello \x1b]8;;https://x.example/\x07link\x1b]8;;\x07\n', 'latin1'));
  assert.match(rs.bytes().toString('latin1'), /\x1b\]8;;https:\/\/x\.example\/\x07link/);
});

test('trims the front forward to a newline boundary when over cap', () => {
  const rs = new RawScrollback(1024);
  // 200 lines of 20 bytes each = ~4000 bytes, well over the 1024 cap.
  for (let i = 0; i < 200; i++) rs.push(Buffer.from(`line-${String(i).padStart(4, '0')}=xxxxx\n`, 'latin1'));
  const out = rs.bytes().toString('latin1');
  assert.ok(out.length <= 1024, 'retained buffer within cap');
  assert.ok(out.startsWith('line-'), 'retained buffer begins at a clean line boundary, not mid-escape');
  assert.match(out, /line-0199=xxxxx\n$/, 'newest line retained');
});

test('tracks alternate-screen enter/exit', () => {
  const rs = new RawScrollback(4096);
  assert.equal(rs.onAltScreen, false);
  rs.push(Buffer.from('normal\n\x1b[?1049h', 'latin1'));
  assert.equal(rs.onAltScreen, true, 'entered alt screen');
  rs.push(Buffer.from('vim content', 'latin1'));
  assert.equal(rs.onAltScreen, true, 'still in alt screen');
  rs.push(Buffer.from('\x1b[?1049lback to shell\n', 'latin1'));
  assert.equal(rs.onAltScreen, false, 'left alt screen');
});

test('detects an alt-screen sequence split across two chunks', () => {
  const rs = new RawScrollback(4096);
  rs.push(Buffer.from('\x1b[?10', 'latin1'));
  rs.push(Buffer.from('49h', 'latin1'));
  assert.equal(rs.onAltScreen, true, 'split enter sequence still detected via tail overlap');
});

test('RESET_PREFIX leaves the alternate screen so raw replay lands on the normal buffer', () => {
  assert.match(RESET_PREFIX, /\x1b\[\?1049l/);
});

test('whatever the chunking, the bytes are the stream tail cut at a newline within the cap', () => {
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
  for (let round = 0; round < 300; round++) {
    const cap = 1024 + rand(2048);
    const rb = new RawScrollback(cap);
    const all: Buffer[] = [];
    const pushes = 1 + rand(60);
    for (let i = 0; i < pushes; i++) {
      const chunk = Buffer.from(Array.from({ length: rand(300) }, () => (rand(20) === 0 ? 0x0a : 0x61 + rand(3))));
      all.push(chunk);
      rb.push(chunk);
      if (rand(5) === 0) rb.bytes(); // reads in between must not change the answer
    }
    const stream = Buffer.concat(all);
    const got = rb.bytes();
    assert.ok(got.length <= cap, 'within the cap');
    assert.deepEqual(got, stream.subarray(stream.length - got.length), 'a tail of the stream');
    if (stream.length > cap) {
      const overflow = stream.length - cap;
      const nl = stream.indexOf(0x0a, overflow);
      const expected = nl === -1 ? stream.subarray(overflow) : stream.subarray(nl + 1);
      assert.equal(got.length, expected.length, 'cut at the first newline past the overflow');
    } else {
      assert.equal(got.length, stream.length);
    }
  }
});

test('tail returns the whole log when it fits', () => {
  const rs = new RawScrollback(4096);
  rs.push(Buffer.from('one\ntwo\n', 'latin1'));
  const { bytes, partial } = rs.tail(1024);
  assert.equal(bytes.toString('latin1'), 'one\ntwo\n');
  assert.equal(partial, false);
});

test('tail cuts at a prompt mark early in range', () => {
  const rs = new RawScrollback(4096);
  for (let i = 0; i < 50; i++) rs.push(Buffer.from(`old-${i}\n`, 'latin1'));
  rs.push(Buffer.from('\x1b[31mred\n\x1b]133;A\x07$ ls\n' + 'file-name-here\n'.repeat(8), 'latin1'));
  const { bytes, partial } = rs.tail(160);
  assert.equal(partial, true);
  assert.ok(bytes.toString('latin1').startsWith('\x1b]133;A\x07$ ls'), 'starts at the prompt');
});

test('tail ignores a prompt mark late in range', () => {
  const rs = new RawScrollback(4096);
  for (let i = 0; i < 50; i++) rs.push(Buffer.from(`line-${String(i).padStart(3, '0')}\n`, 'latin1'));
  rs.push(Buffer.from('\x1b]133;A\x07$ ', 'latin1'));
  const { bytes } = rs.tail(100);
  const out = bytes.toString('latin1');
  assert.ok(out.startsWith('line-'), 'starts on a whole line, not at the final prompt');
  assert.ok(out.length > 75, 'keeps most of the tail');
});

test('tail falls back to just after a newline', () => {
  const rs = new RawScrollback(4096);
  for (let i = 0; i < 50; i++) rs.push(Buffer.from(`line-${String(i).padStart(3, '0')}\n`, 'latin1'));
  const { bytes, partial } = rs.tail(30);
  assert.equal(partial, true);
  const out = bytes.toString('latin1');
  assert.ok(out.length <= 30);
  assert.ok(out.startsWith('line-'), 'starts on a whole line');
  assert.match(out, /line-049\n$/);
});

test('tail of one huge line is the last bytes', () => {
  const rs = new RawScrollback(4096);
  rs.push(Buffer.from('x'.repeat(500), 'latin1'));
  const { bytes, partial } = rs.tail(100);
  assert.equal(bytes.length, 100);
  assert.equal(partial, true);
});

test('since returns what was pushed after a mark, across chunks and resets', () => {
  const r = new RawScrollback(4096);
  r.push(Buffer.from('one\n'));
  const mark = r.pushed;
  r.push(Buffer.from('two\n'));
  r.push(Buffer.from('three\n'));
  assert.equal(r.since(mark)?.toString(), 'two\nthree\n');
  assert.equal(r.since(r.pushed)?.length, 0);
  r.reset(Buffer.from('seed\n'));
  assert.equal(r.bytes().toString(), 'seed\n');
  assert.equal(r.pushed, mark + 'two\nthree\n'.length, 'a reset does not rewind the count');
});

test('since is null once the cap has trimmed past the mark', () => {
  const r = new RawScrollback(1024);
  const mark = r.pushed;
  for (let i = 0; i < 10; i++) r.push(Buffer.from(`${'x'.repeat(299)}\n`));
  assert.equal(r.since(mark), null);
});

test('reset takes its alt-screen state from the seed', () => {
  const r = new RawScrollback(4096);
  r.push(Buffer.from('\x1b[?1049h'));
  assert.equal(r.onAltScreen, true);
  r.reset(Buffer.from('plain\n'));
  assert.equal(r.onAltScreen, false);
  r.reset(Buffer.from('\x1b[?1049hfull screen'));
  assert.equal(r.onAltScreen, true);
});

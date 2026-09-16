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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BellDetector } from '../src/daemon/bell.ts';

const feed = (...chunks: string[]): number => {
  const d = new BellDetector();
  return chunks.reduce((n, c) => n + d.feed(Buffer.from(c, 'binary')), 0);
};

test('counts a bare BEL as a bell', () => {
  assert.equal(feed('\x07'), 1);
  assert.equal(feed('ding\x07dong'), 1);
  assert.equal(feed('\x07\x07\x07'), 3);
});

test('plain output rings nothing', () => {
  assert.equal(feed('hello world\n$ '), 0);
});

test('a window title does NOT ring the bell', () => {
  // Shells set the title on virtually every prompt with ESC ] 0 ; text BEL.
  // Counting that would fire several times a second and make the signal
  // worthless — this is the whole reason the detector exists.
  assert.equal(feed('\x1b]0;user@host: ~\x07$ '), 0);
});

test('a title followed by a real bell counts once', () => {
  assert.equal(feed('\x1b]0;title\x07\x07'), 1);
});

test('an OSC terminated by ESC-backslash leaves a later BEL as a bell', () => {
  assert.equal(feed('\x1b]0;title\x1b\\\x07'), 1);
});

test('OSC 8 hyperlinks do not ring', () => {
  assert.equal(feed('\x1b]8;;https://example.com\x07link text\x1b]8;;\x07'), 0);
});

test('CSI sequences are not confused with OSC', () => {
  // A colour change contains no OSC, so a BEL after it is a real bell.
  assert.equal(feed('\x1b[31mred\x1b[0m\x07'), 1);
});

test('carries state across a chunk boundary inside an OSC string', () => {
  // A read can split anywhere; losing OSC state here would turn the rest of
  // the title into a false bell.
  assert.equal(feed('\x1b]0;a very long ', 'window title\x07'), 0);
});

test('carries state across a boundary immediately after ESC', () => {
  assert.equal(feed('\x1b', ']0;title\x07'), 0);
});

test('a bell split from its surroundings still counts', () => {
  assert.equal(feed('output', '\x07', 'more'), 1);
});

test('an unterminated OSC leaves the detector inside it', () => {
  const d = new BellDetector();
  d.feed(Buffer.from('\x1b]0;never terminated', 'binary'));
  assert.equal(d.insideOsc, true);
  // And reset recovers, so a wedged stream can be cleared.
  d.reset();
  assert.equal(d.insideOsc, false);
  assert.equal(d.feed(Buffer.from('\x07', 'binary')), 1);
});

test('an empty chunk is harmless', () => {
  const d = new BellDetector();
  assert.equal(d.feed(Buffer.alloc(0)), 0);
});

test('ESC ESC does not lose the escape state', () => {
  assert.equal(feed('\x1b\x1b]0;title\x07'), 0);
});

// The byte-by-byte reading every chunk used to get, kept here as the reference
// the fast path for BEL-free chunks has to agree with.
function referenceBells(chunks: Buffer[]): number {
  let inOsc = false;
  let afterEsc = false;
  let bells = 0;
  for (const chunk of chunks) {
    for (const byte of chunk) {
      if (afterEsc) {
        afterEsc = false;
        if (byte === 0x5d) { inOsc = true; continue; }
        if (byte === 0x5c) { inOsc = false; continue; }
        if (byte === 0x1b) afterEsc = true;
        continue;
      }
      if (byte === 0x1b) { afterEsc = true; continue; }
      if (byte === 0x07) { if (inOsc) inOsc = false; else bells++; }
    }
  }
  return bells;
}

test('any split of any stream counts the same bells as a byte-by-byte reading', () => {
  const alphabet = [0x1b, 0x5d, 0x5c, 0x07, 0x61, 0x30];
  let seed = 12345;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
  for (let round = 0; round < 3000; round++) {
    const bytes = Buffer.from(Array.from({ length: 1 + rand(40) }, () => alphabet[rand(alphabet.length)]!));
    const chunks: Buffer[] = [];
    for (let i = 0; i < bytes.length; ) {
      const n = 1 + rand(8);
      chunks.push(bytes.subarray(i, i + n));
      i += n;
    }
    const d = new BellDetector();
    const counted = chunks.reduce((sum, c) => sum + d.feed(c), 0);
    assert.equal(counted, referenceBells(chunks), `stream ${bytes.toString('hex')} split ${chunks.map((c) => c.length).join(',')}`);
  }
});

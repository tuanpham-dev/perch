import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bannerText, appendBanner, appendBannerRaw } from '../src/daemon/restore-banner.ts';

const banner = (n: number) => bannerText(new Date(2026, 0, n, 12, 0, 0));
const count = (s: string) => (s.match(/\[restored /g) ?? []).length;

test('marks the boundary on a first restore', () => {
  const out = appendBanner('some output\r\n', banner(1));
  assert.equal(out.startsWith('some output\r\n'), true);
  assert.equal(count(out), 1);
});

test('keeps only the newest, and every line of real output', () => {
  // The older banners marked boundaries that the output around them already
  // shows; the newest marks where the current boot begins, which nothing
  // else does.
  let s = appendBanner('first run\r\n', banner(1));
  s += 'work done after the restart\r\n';
  const out = appendBanner(s, banner(2));
  assert.equal(count(out), 1);
  assert.ok(String(out).includes('first run'));
  assert.ok(String(out).includes('work done after the restart'));
});

test('does not grow when a session is restored and never used', () => {
  // Measured on the real thing: six restores of an untouched session left
  // six banners in its scrollback, each costing a line of a capped budget.
  const once = appendBanner('history\r\n', banner(1));
  const twice = appendBanner(once, banner(2));
  assert.equal(count(twice), 1);
  assert.ok(String(twice).includes('history'));
  assert.equal(twice.length, once.length);
});

test('collapses a whole run of them, not just the last', () => {
  // The case this exists for: a quiet session on a machine that reboots
  // daily. Left alone, the banners are the only thing still being added, and
  // the capped scrollback slowly becomes nothing but restore notices.
  let s = 'the only real output\r\n';
  for (let day = 1; day <= 30; day++) s = appendBanner(s, banner(day));
  assert.equal(count(s), 1);
  assert.ok(String(s).includes('the only real output'));
  // The surviving one is the newest, whatever this machine's date format is.
  assert.ok(String(s).includes(banner(30).trim()));
});

test('leaves scrollback that merely mentions the word alone', () => {
  // A shell that printed the text is not a banner: banners carry the dim SGR
  // pair, and matching on the words alone would eat someone's output.
  const typed = 'echo "[restored yesterday]"\r\n[restored yesterday]\r\n';
  const out = appendBanner(typed, banner(1));
  // The command and the line it printed both survive, and the real banner is
  // added after them rather than replacing either.
  assert.ok(String(out).includes('echo "[restored yesterday]"'));
  assert.equal(count(out), 3);
  assert.equal(out.endsWith(banner(1)), true);
  // And a second restore still does not touch them.
  assert.equal(count(appendBanner(out, banner(2))), 3);
});

test('keeps the newest timestamp when it collapses', () => {
  const out = appendBanner(appendBanner('x\r\n', banner(1)), banner(9));
  assert.ok(String(out).includes(banner(9).trim()));
  assert.ok(!String(out).includes(banner(1).trim()));
});

test('switches off the modes a program in the history left on', () => {
  // claude turns on focus reporting; restored, the new shell got \x1b[O every
  // time the browser tab lost focus.
  const history = 'claude ui\x1b[?1004h\x1b[?2004h\x1b[?1000h\x1b[?1049h\r\n';
  const out = appendBanner(history, banner(1));
  const tail = out.slice(history.length);
  for (const off of ['\x1b[?1004l', '\x1b[?2004l', '\x1b[?1000l', '\x1b[?1049l', '\x1b[?25h']) {
    assert.ok(tail.includes(off), JSON.stringify(off));
  }
  // And restoring again does not stack resets any more than banners.
  assert.equal(appendBanner(out, banner(2)).length, out.length);
});

test('does the same to the byte-exact sidecar', () => {
  const once = appendBannerRaw(Buffer.from('history\r\n', 'latin1'), banner(1));
  const twice = appendBannerRaw(once, banner(2));
  assert.equal(count(twice.toString('latin1')), 1);
});

test('leaves high bytes untouched', () => {
  // latin1 both ways, because that is the encoding the raw pipeline uses; a
  // round trip through utf8 would rewrite every byte above 0x7f.
  const raw = Buffer.from([0x41, 0xff, 0xfe, 0x0d, 0x0a]);
  const out = appendBannerRaw(raw, banner(1));
  assert.deepEqual(out.subarray(0, 5), raw);
});

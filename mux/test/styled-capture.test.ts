import { test } from 'node:test';
import assert from 'node:assert/strict';
import xtermPkg from '@xterm/headless';
import { styledRow } from '../src/daemon/styled-capture.ts';

const { Terminal } = xtermPkg;

async function rows(data: string): Promise<string[]> {
  const term = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(data, resolve));
  const buf = term.buffer.active;
  return Array.from({ length: buf.length }, (_, y) => styledRow(buf, y));
}

test('unstyled text comes back as it is, without trailing blanks', async () => {
  assert.equal((await rows('plain text   '))[0], 'plain text');
});

test('a highlighted run is framed by its SGR and a reset', async () => {
  const [row] = await rows('\x1b[1m\x1b[44m Fruits \x1b[0m  Size');
  assert.equal(row, '\x1b[0;1;44m Fruits \x1b[0m  Size');
});

test('inverse, 256-color and RGB styles are kept', async () => {
  const [a, b] = await rows('\x1b[7mSel\x1b[0m\r\n\x1b[38;5;208mX\x1b[48;2;1;2;3mY');
  assert.equal(a, '\x1b[0;7mSel\x1b[0m');
  assert.equal(b, '\x1b[0;38;5;208mX\x1b[0;38;5;208;48;2;1;2;3mY\x1b[0m');
});

test('a styled blank at the end of a row is kept, and wide glyphs take one slot', async () => {
  assert.equal((await rows('a\x1b[42m  '))[0], 'a\x1b[0;42m  \x1b[0m');
  assert.equal((await rows('日本x'))[0], '日本x');
});

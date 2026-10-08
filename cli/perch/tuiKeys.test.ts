import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeys } from './tuiKeys.ts';

const names = (s: string) => parseKeys(Buffer.from(s)).map((k) => (k.name === 'char' ? k.ch : k.name));

test('arrows in CSI and SS3 forms', () => {
  assert.deepEqual(names('\x1b[A\x1b[B\x1bOC\x1bOD'), ['up', 'down', 'right', 'left']);
  assert.deepEqual(names('\x1b[5~\x1b[6~\x1b[H\x1b[4~'), ['pageup', 'pagedown', 'home', 'end']);
});

test('enter, escape, backspace, tab, control keys', () => {
  assert.deepEqual(names('\r\n\x1b\x7f\b\t\x03\x15\x17'), ['enter', 'enter', 'escape', 'backspace', 'backspace', 'tab', 'ctrl-c', 'ctrl-u', 'ctrl-w']);
});

test('printable text, including multibyte, and a mixed chunk', () => {
  assert.deepEqual(names('aé😀'), ['a', 'é', '😀']);
  assert.deepEqual(names('j\x1b[Bk'), ['j', 'down', 'k']);
});

test('unbound sequences are dropped', () => {
  assert.deepEqual(names('\x1b[1;5Ax\x1b[200~'), ['up', 'x']);
  assert.deepEqual(names('\x1b[99Z'), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DetachFilter, detachByteOf, keyLabel, resolveDetachKey } from './tuiDetach.ts';

const B = (...bytes: (number | string)[]) =>
  Buffer.concat(bytes.map((b) => (typeof b === 'number' ? Buffer.from([b]) : Buffer.from(b))));

test('key bytes and labels', () => {
  assert.equal(detachByteOf('C-\\'), 0x1c);
  assert.equal(detachByteOf('C-]'), 0x1d);
  assert.equal(detachByteOf('C-a'), 0x01);
  assert.equal(keyLabel('C-\\'), 'Ctrl-\\');
});

test('a double press inside one chunk detaches, forwarding what came before', () => {
  const f = new DetachFilter('C-\\');
  const r = f.push(B('ls', 0x1c, 0x1c, 'x'));
  assert.equal(r.detach, true);
  assert.equal(r.forward.toString(), 'ls');
});

test('a double press split across chunks detaches', () => {
  const f = new DetachFilter('C-\\');
  const first = f.push(B('a', 0x1c));
  assert.deepEqual([first.detach, first.forward.toString()], [false, 'a']);
  const second = f.push(B(0x1c));
  assert.equal(second.detach, true);
  assert.equal(second.forward.length, 0);
});

test('a single press followed by another key is forwarded intact', () => {
  const f = new DetachFilter('C-\\');
  assert.equal(f.push(B(0x1c)).forward.length, 0);
  const r = f.push(B('a'));
  assert.equal(r.detach, false);
  assert.deepEqual([...r.forward], [0x1c, 0x61]);
});

test('resolution order: flag, env, mux.json, default; invalid values skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perch-tui-detach-'));
  const file = join(dir, 'mux.json');
  writeFileSync(file, JSON.stringify({ detachKey: 'C-b' }));
  assert.equal(resolveDetachKey('C-]', { PERCH_DETACH_KEY: 'C-a' }, file), 'C-]');
  assert.equal(resolveDetachKey('bogus', { PERCH_DETACH_KEY: 'C-a' }, file), 'C-a');
  assert.equal(resolveDetachKey(undefined, {}, file), 'C-b');
  writeFileSync(file, '{not json');
  assert.equal(resolveDetachKey(undefined, {}, file), 'C-\\');
  assert.equal(resolveDetachKey(undefined, {}, join(dir, 'missing.json')), 'C-\\');
});

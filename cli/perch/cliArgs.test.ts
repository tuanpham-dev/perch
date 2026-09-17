import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTarget } from './extensions.ts';
import { parseSettingsFlags } from './settings.ts';
import { Exit } from './output.ts';

// The pure argument handling behind `perch ext` and `perch settings`. Nothing
// here touches the network or needs a running instance.

const dir = mkdtempSync(join(tmpdir(), 'perch-cli-args-'));
const file = join(dir, 'thing.perch');
writeFileSync(file, 'not really a zip');
const subdir = join(dir, 'a-directory');
mkdirSync(subdir);

test('an install target is a url, a file, or an id', () => {
  assert.equal(classifyTarget('https://example.test/thing.perch'), 'url');
  assert.equal(classifyTarget('http://example.test/thing.perch'), 'url');
  assert.equal(classifyTarget(file), 'file');
  assert.equal(classifyTarget('perch.github'), 'id');
});

// A mistyped path falls through to an id so it fails with "no configured
// registry carries it", which points at the real mistake better than a
// file-not-found would.
test('a path that does not exist is treated as an id', () => {
  assert.equal(classifyTarget(join(dir, 'absent.perch')), 'id');
});

// A directory is not something the upload route can take.
test('a directory is not a file target', () => {
  assert.equal(classifyTarget(subdir), 'id');
});

test('settings flags parse a file, a port and neither apply flag', () => {
  const flags = parseSettingsFlags(['bundle.json', '--port', '3013']);
  assert.deepEqual(flags.rest, ['bundle.json']);
  assert.equal(flags.port, '3013');
  assert.equal(flags.yes, false);
  assert.equal(flags.noExtensions, false);
});

test('--port accepts both spellings', () => {
  assert.equal(parseSettingsFlags(['--port=8044']).port, '8044');
  assert.equal(parseSettingsFlags(['--port', '8044']).port, '8044');
});

test('each apply flag is accepted on its own', () => {
  assert.equal(parseSettingsFlags(['b.json', '--yes']).yes, true);
  assert.equal(parseSettingsFlags(['b.json', '-y']).yes, true);
  assert.equal(parseSettingsFlags(['b.json', '--no-extensions']).noExtensions, true);
});

// They mean opposite things, so taking either one silently would be a guess
// about an import the user has to live with.
test('the two apply flags together are refused', () => {
  assert.throws(() => parseSettingsFlags(['b.json', '--yes', '--no-extensions']), Exit);
  assert.throws(() => parseSettingsFlags(['b.json', '--no-extensions', '--yes']), Exit);
});

test('an unknown flag is refused rather than ignored', () => {
  assert.throws(() => parseSettingsFlags(['b.json', '--force']), Exit);
});

test('--port with no value is refused', () => {
  assert.throws(() => parseSettingsFlags(['b.json', '--port']), Exit);
});

process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

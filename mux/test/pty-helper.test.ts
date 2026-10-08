import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureExecutable, spawnHelperCandidates } from '../src/util/pty-helper.ts';

test('looks in the prebuild for this platform, then a local build', () => {
  // Joined with the platform's separator, so the same expectation holds on Windows.
  assert.deepEqual(spawnHelperCandidates('/pty', 'darwin', 'arm64'), [
    path.join('/pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    path.join('/pty', 'build', 'Release', 'spawn-helper'),
  ]);
});

test('restores a missing execute bit and leaves executable or absent files alone', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pty-helper-'));
  mkdirSync(path.join(dir, 'a'));
  const broken = path.join(dir, 'a', 'spawn-helper');
  const fine = path.join(dir, 'fine');
  writeFileSync(broken, '');
  writeFileSync(fine, '');
  chmodSync(broken, 0o644);
  chmodSync(fine, 0o755);
  assert.deepEqual(ensureExecutable([broken, fine, path.join(dir, 'missing')]), [broken]);
  assert.equal(statSync(broken).mode & 0o777, 0o755);
  assert.deepEqual(ensureExecutable([broken]), []);
});

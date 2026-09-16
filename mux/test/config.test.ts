import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, setConfigKey, envName } from '../src/util/config.ts';
import { configPath } from '../src/util/paths.ts';

let dir: string;
const TOUCHED_ENV = ['PERCH_CONFIG_DIR', 'PERCH_STATE_DIR', 'PERCH_SNAPSHOT_DEBOUNCE_MS', 'PERCH_DETACH_KEY', 'PERCH_SCROLLBACK_LINES', 'PERCH_PERSIST_SCROLLBACK_LINES', 'PERCH_SHELL'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of TOUCHED_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = mkdtempSync(join(tmpdir(), 'sp-config-test-'));
  process.env.PERCH_CONFIG_DIR = dir;
  process.env.PERCH_STATE_DIR = join(dir, 'state');
});

afterEach(() => {
  for (const k of TOUCHED_ENV) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

test('env var names derive from config keys', () => {
  assert.equal(envName('snapshotDebounceMs'), 'PERCH_SNAPSHOT_DEBOUNCE_MS');
  assert.equal(envName('detachKey'), 'PERCH_DETACH_KEY');
});

test('defaults apply when nothing is configured', () => {
  const cfg = loadConfig({}, () => {});
  assert.equal(cfg.snapshotDebounceMs, 2000);
  assert.equal(cfg.scrollbackLines, 5000);
  assert.equal(cfg.persistScrollbackLines, 2000);
  assert.equal(cfg.detachKey, 'C-\\');
});

test('a config.json value beats the default', () => {
  writeFileSync(configPath(), JSON.stringify({ snapshotDebounceMs: 3000 }));
  assert.equal(loadConfig({}, () => {}).snapshotDebounceMs, 3000);
});

test('an env var beats the file, and a flag beats the env var', () => {
  writeFileSync(configPath(), JSON.stringify({ snapshotDebounceMs: 3000 }));
  process.env.PERCH_SNAPSHOT_DEBOUNCE_MS = '4000';
  assert.equal(loadConfig({}, () => {}).snapshotDebounceMs, 4000);
  assert.equal(loadConfig({ snapshotDebounceMs: 5000 }, () => {}).snapshotDebounceMs, 5000);
});

test('an out-of-range value warns and falls back to the default', () => {
  writeFileSync(configPath(), JSON.stringify({ snapshotDebounceMs: 50 }));
  const warnings: string[] = [];
  const cfg = loadConfig({}, (m) => warnings.push(m));
  assert.equal(cfg.snapshotDebounceMs, 2000);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /out of range/);
});

test('an invalid detachKey warns and falls back', () => {
  process.env.PERCH_DETACH_KEY = 'nonsense';
  const warnings: string[] = [];
  assert.equal(loadConfig({}, (m) => warnings.push(m)).detachKey, 'C-\\');
  assert.match(warnings[0]!, /invalid/);
});

test('persistScrollbackLines is clamped to scrollbackLines', () => {
  writeFileSync(configPath(), JSON.stringify({ scrollbackLines: 500, persistScrollbackLines: 6000 }));
  const warnings: string[] = [];
  const cfg = loadConfig({}, (m) => warnings.push(m));
  assert.equal(cfg.persistScrollbackLines, 500);
  assert.match(warnings[0]!, /clamping/);
});

test('malformed config.json is moved aside and defaults win', () => {
  writeFileSync(configPath(), '{ not json');
  const warnings: string[] = [];
  const cfg = loadConfig({}, (m) => warnings.push(m));
  assert.equal(cfg.snapshotDebounceMs, 2000);
  assert.ok(existsSync(configPath() + '.bad'));
  assert.match(warnings[0]!, /not valid JSON/);
});

test('setConfigKey writes the file and loadConfig reads it back', () => {
  assert.equal(setConfigKey('snapshotDebounceMs', '5000'), 5000);
  assert.equal(loadConfig({}, () => {}).snapshotDebounceMs, 5000);
  // second key merges rather than clobbering
  setConfigKey('detachKey', 'C-q');
  const cfg = loadConfig({}, () => {});
  assert.equal(cfg.snapshotDebounceMs, 5000);
  assert.equal(cfg.detachKey, 'C-q');
});

test('setConfigKey rejects unknown keys and bad values', () => {
  assert.throws(() => setConfigKey('nope', '1'), /unknown config key/);
  assert.throws(() => setConfigKey('snapshotDebounceMs', 'abc'), /out of range/);
});

test('boolean keys accept true/false and reject anything else', () => {
  const quiet = () => {};
  assert.equal(setConfigKey('persistScrollback', 'false'), false);
  assert.equal(loadConfig({}, quiet).persistScrollback, false);
  assert.throws(() => setConfigKey('restore', 'maybe'));
  assert.equal(loadConfig({}, quiet).restore, true);
});

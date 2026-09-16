import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, configPath, ensureStateDirs } from './paths.ts';
import { platform } from '../platform/index.ts';

export type Config = {
  snapshotDebounceMs: number;
  scrollbackLines: number;
  persistScrollbackLines: number;
  rawScrollbackBytes: number;
  detachKey: string;
  shell: string;
  /** Write each window's history into the snapshot. Off keeps the layout
   *  (sessions, windows, folders) but no terminal output on disk. */
  persistScrollback: boolean;
  /** Rebuild sessions from the snapshot when the daemon starts. */
  restore: boolean;
};

export type ConfigKey = keyof Config;

export const CONFIG_KEYS: readonly ConfigKey[] = [
  'snapshotDebounceMs',
  'scrollbackLines',
  'persistScrollbackLines',
  'rawScrollbackBytes',
  'detachKey',
  'shell',
  'persistScrollback',
  'restore',
];

export function defaults(): Config {
  return {
    snapshotDebounceMs: 2000,
    scrollbackLines: 5000,
    persistScrollbackLines: 2000,
    // Byte cap for the raw-scrollback sidecar (T1.6). ~256 KiB per window holds
    // a generous amount of history for byte-exact replay without bloating
    // snapshots; capped forward to a newline boundary so replay starts clean.
    rawScrollbackBytes: 262144,
    detachKey: 'C-\\',
    shell: platform.defaultShell(),
    persistScrollback: true,
    restore: true,
  };
}

type Warn = (msg: string) => void;

const RANGES: Record<'snapshotDebounceMs' | 'scrollbackLines' | 'persistScrollbackLines' | 'rawScrollbackBytes', [number, number]> = {
  snapshotDebounceMs: [100, 60000],
  scrollbackLines: [100, 100000],
  persistScrollbackLines: [0, 100000],
  rawScrollbackBytes: [1024, 16777216],
};

export function envName(key: ConfigKey): string {
  return 'PERCH_' + key.replace(/[A-Z]/g, (m) => '_' + m).toUpperCase();
}

/** Returns the coerced value, or undefined (with a warning emitted) if invalid. */
const BOOLEAN_KEYS: readonly ConfigKey[] = ['persistScrollback', 'restore'];

function validated(key: ConfigKey, raw: unknown, source: string, warn: Warn): string | number | boolean | undefined {
  if (BOOLEAN_KEYS.includes(key)) {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    warn(`sp: config ${key}=${JSON.stringify(raw)} from ${source} is invalid (want true or false); using default`);
    return undefined;
  }
  if (key === 'detachKey') {
    if (typeof raw === 'string' && /^C-.$/.test(raw)) return raw;
    warn(`sp: config ${key}=${JSON.stringify(raw)} from ${source} is invalid (want "C-<char>"); using default`);
    return undefined;
  }
  if (key === 'shell') {
    if (typeof raw === 'string' && raw.length > 0) return raw;
    warn(`sp: config ${key} from ${source} is invalid (want a non-empty string); using default`);
    return undefined;
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  const [lo, hi] = RANGES[key as keyof typeof RANGES];
  if (!Number.isFinite(n) || n < lo || n > hi) {
    warn(`sp: config ${key}=${String(raw)} from ${source} is out of range ${lo}-${hi}; using default`);
    return undefined;
  }
  return Math.floor(n);
}

function applyValid(cfg: Config, key: ConfigKey, raw: unknown, source: string, warn: Warn): void {
  const v = validated(key, raw, source, warn);
  if (v !== undefined) (cfg as Record<string, string | number | boolean>)[key] = v;
}

/** Precedence: overrides (CLI flags) > env vars > config.json > defaults. */
export function loadConfig(overrides: Partial<Config> = {}, warn: Warn = (m) => console.error(m)): Config {
  const cfg = defaults();
  const file = configPath();
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    } catch {
      const bad = file + '.bad';
      try { renameSync(file, bad); } catch { /* keep going on defaults */ }
      warn(`sp: ${file} is not valid JSON; moved to ${bad} and using defaults`);
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const obj = parsed as Record<string, unknown>;
      for (const key of CONFIG_KEYS) {
        if (key in obj) applyValid(cfg, key, obj[key], file, warn);
      }
    }
  }
  for (const key of CONFIG_KEYS) {
    const raw = process.env[envName(key)];
    if (raw !== undefined) applyValid(cfg, key, raw, `$${envName(key)}`, warn);
  }
  for (const key of CONFIG_KEYS) {
    if (overrides[key] !== undefined) applyValid(cfg, key, overrides[key], 'command line', warn);
  }
  if (cfg.persistScrollbackLines > cfg.scrollbackLines) {
    warn(`sp: persistScrollbackLines (${cfg.persistScrollbackLines}) exceeds scrollbackLines (${cfg.scrollbackLines}); clamping`);
    cfg.persistScrollbackLines = cfg.scrollbackLines;
  }
  return cfg;
}

/** For `sp config set`: throws on an invalid key or value, writes config.json atomically. */
export function setConfigKey(key: string, value: string): string | number | boolean {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new Error(`unknown config key ${JSON.stringify(key)} (valid: ${CONFIG_KEYS.join(', ')})`);
  }
  const k = key as ConfigKey;
  let bad: string | undefined;
  const coerced = validated(k, value, 'sp config set', (m) => { bad = m; });
  if (coerced === undefined) throw new Error(bad ?? `invalid value for ${key}`);
  const existing = readConfigFile();
  existing[k] = coerced;
  writeConfigFile(existing);
  return coerced;
}

/** Removes a key from the config file, so its default (or env var) applies. */
export function unsetConfigKey(key: string): void {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new Error(`unknown config key ${JSON.stringify(key)} (valid: ${CONFIG_KEYS.join(', ')})`);
  }
  const existing = readConfigFile();
  if (!(key in existing)) return;
  delete existing[key];
  writeConfigFile(existing);
}

function readConfigFile(): Record<string, unknown> {
  const file = configPath();
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {}; // overwrite malformed file
  }
}

function writeConfigFile(values: Record<string, unknown>): void {
  ensureStateDirs();
  // Atomic same-directory write: never a cross-filesystem rename.
  const tmp = join(configDir(), `config.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(values, null, 2) + '\n');
  renameSync(tmp, configPath());
}

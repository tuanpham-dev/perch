// Where this install lives, resolved from the CLI's own location (bin/ is
// usually reached through a ~/.local/bin symlink; Node resolves that for the
// entry script), and the shared bits of config every command reads.
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BIN_DIR = join(REPO_DIR, 'bin');
export const SELF = join(BIN_DIR, 'perch');
export const ENV_FILE = join(REPO_DIR, 'server', '.env');

export const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || tmpdir();
export const PID_FILE = join(RUNTIME_DIR, 'perch.pid');
export const LOG_FILE = join(RUNTIME_DIR, 'perch.log');
export const pidFileForPort = (port: string) => join(RUNTIME_DIR, `perch-${port}.pid`);
export const logFileForPort = (port: string) => join(RUNTIME_DIR, `perch-${port}.log`);

/** Same order the server resolves it in: a PORT env var, then server/.env, then 3001. */
export function readPort(): string {
  if (process.env.PORT) return process.env.PORT;
  if (existsSync(ENV_FILE)) {
    const lines = readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => l.startsWith('PORT='));
    const last = lines.at(-1)?.slice('PORT='.length).replace(/^["']|["']$/g, '').trim();
    if (last) return last;
  }
  return '3001';
}

/**
 * The shared-secret gate's token, resolved the same way readPort resolves the
 * port: an AUTH_TOKEN env var, then the last AUTH_TOKEN= line in server/.env,
 * else "" for an install with no gate configured.
 *
 * Read so `perch ext` and `perch settings` can authenticate against a gated
 * instance with the header the server already accepts (see
 * server/src/security.ts's tokenFromRequest). Deliberately NOT an exemption:
 * installing an extension runs its server hook as this user, so it stays
 * behind the gate rather than becoming reachable by any local process.
 */
export function readAuthToken(): string {
  if (process.env.AUTH_TOKEN) return process.env.AUTH_TOKEN;
  if (existsSync(ENV_FILE)) {
    const lines = readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => l.startsWith('AUTH_TOKEN='));
    const last = lines.at(-1)?.slice('AUTH_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
    if (last) return last;
  }
  return '';
}

export const appUrl = (port = readPort()) => `http://127.0.0.1:${port}`;

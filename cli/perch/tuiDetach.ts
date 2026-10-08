// The detach key for `perch tui`'s attached view: which key it is, and
// spotting it pressed twice in a row in the input stream. The rule is the
// one `perch attach` uses (mux/src/client/attach.ts), so the key behaves the
// same in both.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../../mux/src/util/paths.ts';

export const DEFAULT_DETACH_KEY = 'C-\\';
const VALID = /^C-.$/;

/** "C-x" -> the control byte it names (C-\ -> 0x1c). */
export function detachByteOf(key: string): number {
  return key.slice(2).toUpperCase().charCodeAt(0) & 0x1f;
}

/** "C-\" -> "Ctrl-\", for the footer and the attach banner. */
export function keyLabel(key: string): string {
  return `Ctrl-${key.slice(2)}`;
}

/**
 * --detach-key, then $PERCH_DETACH_KEY, then the local terminal daemon's
 * mux.json, then Ctrl-\. An invalid value at any step is skipped. The file is
 * read directly rather than through mux's loadConfig, which moves an
 * unparseable config aside as a side effect.
 */
export function resolveDetachKey(flag?: string, env = process.env, file = join(configDir(), 'mux.json')): string {
  if (flag && VALID.test(flag)) return flag;
  const fromEnv = env.PERCH_DETACH_KEY;
  if (fromEnv && VALID.test(fromEnv)) return fromEnv;
  try {
    if (existsSync(file)) {
      const value = (JSON.parse(readFileSync(file, 'utf8')) as { detachKey?: unknown }).detachKey;
      if (typeof value === 'string' && VALID.test(value)) return value;
    }
  } catch {
    // An unreadable config means the default, as the daemon would use.
  }
  return DEFAULT_DETACH_KEY;
}

/**
 * Detach = the detach byte twice in a row. A lone detach byte at the end of a
 * chunk is held back until the next chunk shows whether it is half of a
 * detach or real input; followed by anything else, it is forwarded unchanged.
 */
export class DetachFilter {
  #byte: number;
  #holding = false;

  constructor(key: string) {
    this.#byte = detachByteOf(key);
  }

  push(chunk: Buffer): { forward: Buffer; detach: boolean } {
    let buf = chunk;
    if (this.#holding) {
      this.#holding = false;
      buf = Buffer.concat([Buffer.from([this.#byte]), buf]);
    }
    for (let i = 0; i + 1 < buf.length; i++) {
      if (buf[i] === this.#byte && buf[i + 1] === this.#byte) {
        return { forward: buf.subarray(0, i), detach: true };
      }
    }
    if (buf.length > 0 && buf[buf.length - 1] === this.#byte) {
      this.#holding = true;
      buf = buf.subarray(0, buf.length - 1);
    }
    return { forward: buf, detach: false };
  }
}

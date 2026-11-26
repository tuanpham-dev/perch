// Console output and prompts for the Perch CLI. Color only when stdout
// is a terminal, so piped output stays plain.
import { createInterface } from 'node:readline/promises';

const tty = process.stdout.isTTY === true;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const green = paint('32');
export const yellow = paint('33');
export const red = paint('31');
const bold = paint('1');

export const ok = (msg: string) => console.log(`${green('[ ok ]')} ${msg}`);
export const warn = (msg: string) => console.log(`${yellow('[warn]')} ${msg}`);
export const fail = (msg: string) => console.log(`${red('[fail]')} ${msg}`);
export const info = (msg: string) => console.log(msg);
export const heading = (msg: string) => console.log(`\n${bold(msg)}`);

/** A CLI error that has already explained itself: exit with this code, print nothing more. */
export class Exit extends Error {
  code: number;
  constructor(code = 1) {
    super(`exit ${code}`);
    this.code = code;
  }
}

/** fail(), then stop. */
export function die(msg: string): never {
  fail(msg);
  throw new Exit(1);
}

export const interactive = () => process.stdin.isTTY === true;

/** One line from the user, or "" when stdin isn't a terminal. */
export async function ask(question: string): Promise<string> {
  if (!interactive()) return '';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export function table(rows: string[][], widths: number[]): void {
  for (const row of rows) {
    console.log(row.map((cell, i) => (i < widths.length ? cell.padEnd(widths[i]!) : cell)).join(' ').trimEnd());
  }
}

export interface SecretState {
  value: string;
  /** Left over from an escape sequence that a later chunk may finish. */
  esc: '' | 'esc' | 'csi' | 'ss3';
  done: 'enter' | 'eof' | 'interrupt' | null;
}

export const initialSecret = (): SecretState => ({ value: '', esc: '', done: null });

/**
 * Pure keystroke handling for the hidden prompt. A paste arrives as one chunk,
 * so it walks a character at a time. Enter and Ctrl-D end input, Ctrl-C
 * interrupts, backspace edits, and CSI/SS3 escape sequences (arrow keys) are
 * swallowed whole.
 */
export function reduceSecret(state: SecretState, chunk: string): SecretState {
  let { value, esc } = state;
  for (const ch of chunk) {
    if (esc === 'esc') {
      esc = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : '';
      continue;
    }
    if (esc === 'csi') {
      // Parameter and intermediate bytes continue; a final byte (0x40-0x7e) ends it.
      if (ch >= '@' && ch <= '~') esc = '';
      continue;
    }
    if (esc === 'ss3') {
      esc = '';
      continue;
    }
    if (ch === '\x1b') esc = 'esc';
    else if (ch === '\r' || ch === '\n') return { value, esc: '', done: 'enter' };
    else if (ch === '\x04') return { value, esc: '', done: 'eof' };
    else if (ch === '\x03') return { value, esc: '', done: 'interrupt' };
    else if (ch === '\x7f' || ch === '\b') value = value.slice(0, -1);
    else if (ch >= ' ') value += ch;
  }
  return { value, esc, done: null };
}

/**
 * One line typed with echo off, for secrets. "" when stdin isn't a terminal.
 * The prompt and the closing newline go to stderr so stdout stays clean.
 * Ctrl-C leaves with 130 like a shell would.
 */
export async function askSecret(question: string): Promise<string> {
  if (!interactive()) return '';
  const stdin = process.stdin;
  process.stderr.write(question);
  try {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    return await new Promise<string>((resolve, reject) => {
      let state = initialSecret();
      const onData = (chunk: string) => {
        state = reduceSecret(state, chunk);
        if (!state.done) return;
        stdin.off('data', onData);
        if (state.done === 'interrupt') reject(new Exit(130));
        else resolve(state.value.trim());
      };
      stdin.on('data', onData);
    });
  } finally {
    try {
      stdin.setRawMode(false);
    } catch {
      // The terminal may already be gone.
    }
    stdin.pause();
    process.stderr.write('\n');
  }
}

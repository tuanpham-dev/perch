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

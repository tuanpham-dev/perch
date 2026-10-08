// Turns raw terminal input into key names for `perch tui`'s list and prompts.
// Only the keys the TUI binds are named; any other escape sequence is
// dropped rather than typed into a prompt as garbage.

export interface Key {
  name: string;
  /** The typed text, for name === 'char'. */
  ch?: string;
}

const CSI: Record<string, string> = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end',
  '1~': 'home', '4~': 'end', '7~': 'home', '8~': 'end', '5~': 'pageup', '6~': 'pagedown', '3~': 'delete',
};

export function parseKeys(buf: Buffer): Key[] {
  const s = buf.toString('utf8');
  const keys: Key[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\x1b') {
      const next = s[i + 1];
      if (next === '[') {
        // CSI: parameters, then one final byte in @-~.
        let j = i + 2;
        while (j < s.length && !/[@-~]/.test(s[j]!)) j++;
        const body = s.slice(i + 2, j + 1);
        const name = CSI[body] ?? CSI[body.replace(/^1;\d+/, '')];
        if (name) keys.push({ name });
        i = j + 1;
        continue;
      }
      if (next === 'O' && i + 2 < s.length) {
        const name = CSI[s[i + 2]!];
        if (name) keys.push({ name });
        i += 3;
        continue;
      }
      // A lone Escape (or Escape before something unbound).
      keys.push({ name: 'escape' });
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') keys.push({ name: 'enter' });
    else if (c === '\x7f' || c === '\b') keys.push({ name: 'backspace' });
    else if (c === '\t') keys.push({ name: 'tab' });
    else if (c === '\x03') keys.push({ name: 'ctrl-c' });
    else if (c === '\x15') keys.push({ name: 'ctrl-u' });
    else if (c === '\x17') keys.push({ name: 'ctrl-w' });
    else if (c >= ' ') {
      // Whole code points, so an emoji isn't split into surrogate halves.
      const cp = s.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      keys.push({ name: 'char', ch });
      i += ch.length;
      continue;
    }
    i += 1;
  }
  return keys;
}

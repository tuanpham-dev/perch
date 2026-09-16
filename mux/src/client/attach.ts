import { connectOrSpawn } from './connection.ts';
import { loadConfig } from '../util/config.ts';
import { platform } from '../platform/index.ts';

/** "C-x" -> the control byte it names (C-\ -> 0x1c). */
function detachByteOf(detachKey: string): number {
  return (detachKey.slice(2).toUpperCase().charCodeAt(0) ?? 0x5c) & 0x1f;
}

export async function runAttach(session: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('attach needs a real terminal (stdin and stdout must both be TTYs)');
  }
  const config = loadConfig({}, (m) => process.stderr.write(m + '\n'));
  const detachByte = detachByteOf(config.detachKey);
  const conn = await connectOrSpawn();
  const { stdin, stdout } = process;

  let done = false;
  const finish = (message: string, code = 0): never => {
    done = true;
    try { stdin.setRawMode(false); } catch { /* tty already gone */ }
    stdin.pause();
    // Leave the terminal sane: reset attributes, normal buffer, cursor visible.
    stdout.write(`\x1b[0m\x1b[?1049l\x1b[?25h\r\n${message}\r\n`);
    conn.destroy();
    process.exit(code);
  };

  conn.onOutput = (data) => { if (!done) stdout.write(data); };
  conn.onEvent = (event) => {
    if (event.event === 'session-closed') finish(`[session ${event.session} closed]`);
  };
  conn.onClose = () => { if (!done) finish('[lost connection to the terminal daemon]', 1); };

  await conn.request({
    kind: 'session.attach',
    session,
    cols: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  });

  stdin.setRawMode(true);
  stdin.resume();

  // Detach = the detach byte twice in a row. A lone detach byte is held back
  // until the next byte shows whether it is half of a detach or real input;
  // followed by anything else, both bytes are forwarded unchanged.
  let holdingDetachByte = false;
  stdin.on('data', (chunk: Buffer) => {
    if (done) return;
    let buf = chunk;
    if (holdingDetachByte) {
      holdingDetachByte = false;
      if (buf.length > 0 && buf[0] === detachByte) finish('[detached]');
      buf = Buffer.concat([Buffer.from([detachByte]), buf]);
    }
    for (let i = 0; i + 1 < buf.length; i++) {
      if (buf[i] === detachByte && buf[i + 1] === detachByte) {
        if (i > 0) conn.sendInput(buf.subarray(0, i));
        finish('[detached]');
      }
    }
    if (buf.length > 0 && buf[buf.length - 1] === detachByte) {
      holdingDetachByte = true;
      buf = buf.subarray(0, buf.length - 1);
    }
    if (buf.length > 0) conn.sendInput(buf);
  });

  platform.onTerminalResize(() => {
    conn.request({ kind: 'resize', cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 }).catch(() => { /* detaching */ });
  });

  // Held open until finish() exits the process.
  await new Promise<never>(() => { /* resolved never */ });
}

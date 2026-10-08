// `perch tui`'s attached view: one terminal, full screen, over the same
// /ws/attach socket the browser uses. Bytes from the server go straight to
// stdout; keystrokes go back as input messages, except the detach key pressed
// twice, which ends the attach and hands the screen back to the list.
import { StringDecoder } from 'node:string_decoder';
import type { PerchClient } from './tuiClient.ts';
import { stripTerminalReplies } from '../../client/src/lib/terminalReplies.ts';
import { DetachFilter } from './tuiDetach.ts';

export type AttachEnd = 'detached' | 'closed' | 'lost' | { error: string };

// Modes a terminal app may have switched on that would leak into the list
// (and the user's shell after quitting): mouse reporting, bracketed paste,
// application cursor and keypad keys, the alternate screen. Turned off on the
// way out, whatever the app left behind.
export const RESET_MODES =
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1004l\x1b[?1l\x1b>\x1b[?1049l\x1b[0m\x1b[?25h';

export function runAttach(client: PerchClient, target: string, detachKey: string): Promise<AttachEnd> {
  const { stdin, stdout } = process;
  const size = () => ({ cols: stdout.columns || 80, rows: stdout.rows || 24 });

  return new Promise((resolve) => {
    const { cols, rows } = size();
    let ws: WebSocket;
    try {
      ws = new WebSocket(client.attachUrl(target, cols, rows));
    } catch (err) {
      resolve({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
    ws.binaryType = 'arraybuffer';

    const filter = new DetachFilter(detachKey);
    const decoder = new StringDecoder('utf8');
    let opened = false;
    let done = false;

    const send = (msg: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    const finish = (end: AttachEnd) => {
      if (done) return;
      done = true;
      stdin.off('data', onInput);
      stdout.off('resize', onResize);
      try { ws.close(); } catch { /* already closing */ }
      stdout.write(RESET_MODES);
      resolve(end);
    };

    const onInput = (chunk: Buffer) => {
      const { forward, detach } = filter.push(chunk);
      if (forward.length > 0) {
        // Your terminal answers the questions in the replayed history (cursor
        // position, device attributes, ...) as if they were asked now. Those
        // answers belong to programs long gone and would land at the prompt
        // as junk; live questions are answered by the terminal daemon itself.
        // The same filter the browser applies to its own input.
        const text = stripTerminalReplies(decoder.write(forward));
        if (text) send({ type: 'input', data: text });
      }
      if (detach) finish('detached');
    };

    const onResize = () => {
      send({ type: 'resize', ...size() });
    };

    ws.addEventListener('open', () => {
      opened = true;
      // This viewer becomes the one that sizes the terminal (spec R10).
      send({ type: 'activate' });
      send({ type: 'resize', ...size() });
      stdin.on('data', onInput);
      stdout.on('resize', onResize);
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      if (done) return;
      if (typeof ev.data !== 'string') {
        stdout.write(Buffer.from(ev.data as ArrayBuffer));
        return;
      }
      let msg: { type?: string };
      try {
        msg = JSON.parse(ev.data) as { type?: string };
      } catch {
        return;
      }
      if (msg.type === 'exit') finish('closed');
    });

    ws.addEventListener('close', () => {
      if (opened) finish('lost');
      else finish({ error: 'the server refused the attach' });
    });
    ws.addEventListener('error', () => {
      // close follows with the outcome.
    });

    // Leave the list's alternate screen and start from a clean one, so the
    // terminal's replay draws on a blank page.
    stdout.write('\x1b[?1049l\x1b[0m\x1b[H\x1b[2J\x1b[?25h');
  });
}

import { randomUUID } from 'node:crypto';
import { BellDetector } from './bell.ts';
import { spawnEnv } from '../util/spawn-env.ts';
import { shellLaunchArgs } from '../util/shell-launch.ts';
import { RawScrollback, RESET_PREFIX } from './raw-scrollback.ts';
import type { ViewerColors } from '../protocol/messages.ts';
import { platform } from '../platform/index.ts';
import { directoryFromOsc7 } from '../util/osc7.ts';
import { styledRow } from './styled-capture.ts';
import * as nodePty from 'node-pty';
import type { IPty } from 'node-pty';
// CJS packages: named ESM imports fail at runtime, so use default-import interop.
import xtermPkg from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';

const { Terminal } = xtermPkg;
const { SerializeAddon } = serializePkg;

// Process groups whose SIGKILL grace timer hasn't fired when the daemon exits
// still get swept here — 'exit' handlers run synchronously.
const pendingKills = new Set<number>();
process.on('exit', () => {
  for (const pgid of pendingKills) {
    platform.killTree(pgid);
  }
});

export type WindowOpts = {
  /** A restored window keeps the id it had, so its scrollback sidecars, the
   *  PERCH_WINDOW its shell reports and every tab pointing at it stay
   *  valid across a daemon restart. Fresh windows get a new uuid. */
  id?: string;
  name: string;
  /** True while the name should follow the foreground command (tmux's
   *  automatic-rename). A name somebody chose turns it off. Defaults to true. */
  autoName?: boolean;
  /** Owning session's name at spawn time — lands in PERCH_SESSION. */
  sessionName: string;
  /** The app server that announced itself, for the shell to report commands to. */
  serverUrl?: string | null;
  cwd: string;
  command?: string;
  cols: number;
  rows: number;
  shell: string;
  scrollbackLines: number;
  /** Byte cap for the raw-scrollback sidecar (T1.6). */
  rawScrollbackBytes: number;
  /** Replayed into the headless terminal only — never written to the PTY. */
  restoredScrollback?: string;
  /** Raw sidecar bytes from a prior life, for byte-exact replay after restore. */
  restoredRaw?: Buffer;
  /** When false, a declared command is recorded but not typed into the new shell. */
  runCommand?: boolean;
  /** For a restored window: what was running in it when the snapshot was
   *  taken, so a client can offer to pick that work back up. */
  restoredCommands?: string[];
};

export type OutputSink = { writeOutput(data: Buffer): void };

/** "#rrggbb" as the X11 rgb:rrrr/gggg/bbbb form terminals answer color queries in. */
function xParseColor(hex: string): string | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return null;
  const [, r, g, b] = m;
  return `rgb:${r}${r}/${g}${g}/${b}${b}`.toLowerCase();
}

/** What XTGETTCAP is answered with, in terminfo's own text form (`\E` is ESC).
 *  Ms: set the selection through OSC 52, which the browser engine writes to
 *  the clipboard. */
const TERMCAP_ANSWERS: Record<string, string> = {
  Ms: '\\E]52;%p1%s;%p2%s\\E\\\\',
};

function hexEncode(text: string): string {
  return Buffer.from(text, 'latin1').toString('hex');
}

function hexDecode(hex: string): string | null {
  return /^(?:[0-9a-fA-F]{2})+$/.test(hex) ? Buffer.from(hex, 'hex').toString('latin1') : null;
}

export class Window {
  readonly id: string;
  name: string;
  autoName: boolean;
  /** What was running in this window before a restore, until a client says
   *  it has dealt with it (window.clearRestored). Null otherwise. */
  restoredCommands: string[] | null;
  command: string | undefined;
  spawnCwd: string;
  cols: number;
  rows: number;
  onExit: ((w: Window) => void) | undefined;
  onActivity: (() => void) | undefined;
  /** True until the snapshotter has written this window's scrollback files;
   *  set again by every PTY chunk and by a resize. Starts true so a new or
   *  restored window is saved by the first snapshot. */
  scrollbackDirty = true;

  #pty: IPty;
  #term: InstanceType<typeof Terminal>;
  #serialize: InstanceType<typeof SerializeAddon>;
  #subs = new Set<OutputSink>();
  #exited = false;
  /** False until any restored scrollback has been parsed — see the onData
   *  handler below. */
  #answerQueries = false;
  #lastOutputAt = Date.now();
  /** The directory the shell last reported (OSC 7), once it's reporting. */
  #reportedCwd: string | null = null;
  /** Theme colors of the viewer that last became active; answers OSC 10/11. */
  #colors: ViewerColors | null = null;
  // Starts a beat in the future so the shell's first prompt doesn't flag a
  // window nobody has opened yet as active.
  #lastSeenAt = Date.now() + 1000;
  #raw: RawScrollback;

  constructor(opts: WindowOpts) {
    this.id = opts.id ?? randomUUID();
    this.name = opts.name;
    this.autoName = opts.autoName ?? true;
    this.restoredCommands = opts.restoredCommands && opts.restoredCommands.length > 0 ? [...opts.restoredCommands] : null;
    this.command = opts.command;
    this.spawnCwd = opts.cwd;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.#term = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollbackLines,
      allowProposedApi: true,
    });
    this.#serialize = new SerializeAddon();
    // The serialize addon is typed against browser xterm; the headless build accepts it.
    this.#term.loadAddon(this.#serialize as never);
    // Seed the raw sidecar from a prior life so restored scrollback stays
    // byte-exact (OSC 8 links, OSC 133 marks). The seed is fed to the headless
    // terminal too, so the serialize fallback still reflects the same history.
    this.#raw = new RawScrollback(opts.rawScrollbackBytes, opts.restoredRaw);
    if (opts.restoredRaw && opts.restoredRaw.length > 0) {
      // Seed the headless terminal from the same bytes. xterm.write() accepts a
      // Uint8Array and does its own UTF-8 decoding (including across chunk
      // boundaries), so the bytes go in unmodified.
      this.#term.write(opts.restoredRaw, () => { this.#answerQueries = true; });
    } else if (opts.restoredScrollback) {
      this.#term.write(opts.restoredScrollback, () => { this.#answerQueries = true; });
    } else {
      this.#answerQueries = true;
    }
    this.#pty = nodePty.spawn(opts.shell, shellLaunchArgs(opts.shell), {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: spawnEnv({ sessionName: opts.sessionName, windowId: this.id, serverUrl: opts.serverUrl }),
    });
    // This terminal answers the shell's capability queries — DA, cursor
    // position — instead of the browser doing it.
    //
    // A browser's answer has to cross a socket twice, and by the time it
    // arrives the program that asked has often stopped reading, so the reply
    // lands at the prompt as visible garbage ("1;2c"). Answering here is
    // in-process and immediate, which is the same reason tmux answers on its
    // client's behalf. The browser is told not to answer these at all, so the
    // asker gets exactly one reply.
    //
    // Gated until the restored scrollback has been parsed: replaying history
    // replays its queries too, and answering those would type the responses
    // into a shell that never asked.
    this.#term.onData((response) => {
      if (!this.#answerQueries || this.#exited) return;
      this.#pty.write(response);
    });

    // Color queries (OSC 10 foreground, OSC 11 background, "?" as the value)
    // are answered from the active viewer's theme, reported on attach. The
    // headless terminal has no colors of its own, and a browser's answer
    // would arrive late (see above). A window no browser has viewed answers
    // nothing, and the asker times out as it would in any headless terminal.
    // A set (non-query) OSC 10/11 falls through untouched.
    const answerColor = (base: 10 | 11) => (payload: string): boolean => {
      if (!this.#answerQueries || this.#exited) return false;
      const replies: string[] = [];
      payload.split(';').forEach((param, i) => {
        if (param !== '?') return;
        const code = base + i; // "10;?;?" asks for the foreground, then the background
        const color = code === 10 ? this.#colors?.foreground : code === 11 ? this.#colors?.background : undefined;
        const rgb = color && xParseColor(color);
        if (rgb) replies.push(`\x1b]${code};${rgb}\x1b\\`);
      });
      if (replies.length === 0) return false;
      this.#pty.write(replies.join(''));
      return true;
    };
    this.#term.parser.registerOscHandler(10, answerColor(10));
    this.#term.parser.registerOscHandler(11, answerColor(11));

    // XTGETTCAP (DCS + q <hex names> ST): a program asking which capabilities
    // this terminal has. `Ms` is the one that matters: it is how nvim decides
    // it may copy through OSC 52, which the browser turns into a real clipboard
    // write. Each name gets its own reply, the shape nvim's vim.tty.query
    // matches; a name this terminal does not know is answered invalid so the
    // asker is not left waiting out its timeout.
    this.#term.parser.registerDcsHandler({ intermediates: '+', final: 'q' }, (data) => {
      if (!this.#answerQueries || this.#exited) return true;
      const replies = data.split(';').filter(Boolean).map((hexName) => {
        const value = TERMCAP_ANSWERS[hexDecode(hexName) ?? ''];
        return value === undefined
          ? '\x1bP0+r\x1b\\'
          : `\x1bP1+r${hexName.toLowerCase()}=${hexEncode(value)}\x1b\\`;
      });
      if (replies.length > 0) this.#pty.write(replies.join(''));
      return true;
    });

    // OSC 7 from the live shell. Ignored while restored history is still being
    // parsed: those reports describe a shell that no longer exists.
    this.#term.parser.registerOscHandler(7, (payload) => {
      if (this.#answerQueries) this.#reportedCwd = directoryFromOsc7(payload) ?? this.#reportedCwd;
      return false;
    });
    this.#pty.onData((data) => {
      this.#term.write(data);
      // node-pty decodes PTY output as UTF-8, so re-encoding as UTF-8 recovers
      // the ORIGINAL byte stream. (latin1 here would clamp every code point to
      // one byte and destroy multi-byte glyphs — box drawing, emoji, CJK.)
      // Encoded once: the scrollback, the bell check and every viewer share it.
      const bytes = Buffer.from(data, 'utf8');
      this.#raw.push(bytes);
      this.#lastOutputAt = Date.now();
      this.scrollbackDirty = true;
      if (this.#subs.size > 0) this.#lastSeenAt = this.#lastOutputAt;
      // A bell is how a program — a coding agent, most usefully — asks for
      // attention. Counted here rather than in the browser, because the browser
      // may well be closed, which is exactly when the signal matters.
      const bells = this.#bell.feed(bytes);
      if (bells > 0) this.onBell?.(this);
      for (const sub of this.#subs) sub.writeOutput(bytes);
      this.onActivity?.();
    });
    this.#pty.onExit(() => {
      this.#exited = true;
      pendingKills.delete(this.#pty.pid);
      this.onExit?.(this);
    });
    // A declared command is typed into the shell rather than exec'd, so the
    // window stays alive (with a prompt) after the command finishes — and the
    // exact same mechanism replays it on restore-after-reboot.
    if (opts.command && opts.runCommand !== false) this.#pty.write(opts.command + '\r');
  }

  readonly #bell = new BellDetector();
  /** Called when this window rings a real bell (not an OSC terminator). */
  onBell?: (window: Window) => void;

  get pid(): number { return this.#pty.pid; }
  get exited(): boolean { return this.#exited; }
  /** Epoch ms of this window's most recent PTY output — activity for the UI. */
  get lastOutputAt(): number { return this.#lastOutputAt; }
  /** Output nobody saw: produced while no viewer was subscribed. */
  get activity(): boolean { return this.#subs.size === 0 && this.#lastOutputAt > this.#lastSeenAt; }

  subscribe(sink: OutputSink): void {
    this.#subs.add(sink);
    this.#lastSeenAt = Date.now();
  }
  unsubscribe(sink: OutputSink): void { this.#subs.delete(sink); }

  write(data: string): void {
    if (!this.#exited) this.#pty.write(data);
  }

  /** The colors of the viewer that just became active. A viewer without any
   *  (the CLI) leaves the last known ones in place. */
  setViewerColors(colors: ViewerColors | null): void {
    if (colors && (colors.foreground || colors.background)) this.#colors = colors;
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    if (!this.#exited) {
      try { this.#pty.resize(cols, rows); } catch { /* races with pty exit */ }
    }
    this.#term.resize(cols, rows);
    this.scrollbackDirty = true;
  }

  /** Escape-sequence replay that reconstructs this window's screen and scrollback. */
  serializeState(scrollbackLines: number): string {
    let out = this.#serialize.serialize({ scrollback: scrollbackLines });
    // Persisted/replayed state must land on the normal buffer: a restored vim
    // frame would swallow keystrokes bound for the fresh shell beneath it.
    if (this.#term.buffer.active.type === 'alternate') out += '\x1b[?1049l';
    return out;
  }

  /** Raw sidecar bytes for persistence (byte image of the live string stream). */
  rawBytes(): Buffer { return this.#raw.bytes(); }

  /**
   * The payload sent to a (re)attaching client to reconstruct this window.
   * On the normal buffer with sidecar bytes available, replay the raw stream —
   * byte-exact, so OSC 8 links, OSC 133 marks, and multi-byte UTF-8 glyphs all
   * survive. When an alt-screen app is in front, or there is nothing in the
   * sidecar, fall back to the SerializeAddon (which forces the normal buffer).
   * Where the pseudo-terminal redraws on its own (platform.rawReplaySafe is
   * false: Windows' ConPTY) the serialized screen is always used.
   * `refreshPrefix` is the clear/reset prepended for the serialize path.
   *
   * Returns a Buffer, never a string: the raw sidecar holds real bytes, and
   * handing them out as a latin1 string would let the frame encoder re-encode
   * them as UTF-8 and corrupt every non-ASCII glyph.
   */
  replayPayload(scrollbackLines: number, refreshPrefix: string): Buffer {
    const raw = this.#raw.bytes();
    if (platform.rawReplaySafe && raw.length > 0 && !this.#raw.onAltScreen) {
      return Buffer.concat([Buffer.from(RESET_PREFIX, 'latin1'), raw]);
    }
    return Buffer.from(refreshPrefix + this.serializeState(scrollbackLines), 'utf8');
  }

  /** Text of the viewport plus the last `extraScrollback` history lines:
   *  plain, or with `styles` each row's styling kept as SGR escapes. */
  capture(extraScrollback = 0, styles = false): string {
    const buf = this.#term.buffer.active;
    const start = Math.max(0, buf.length - this.#term.rows - extraScrollback);
    const lines: string[] = [];
    for (let i = start; i < buf.length; i++) {
      lines.push(styles ? styledRow(buf, i) : (buf.getLine(i)?.translateToString(true) ?? ''));
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  /** The shell's live working directory — what `cd` last set, not where it spawned.
   *  From the OS where it will say, else the shell's own OSC 7 report. */
  liveCwd(): string {
    return platform.cwdOf(this.#pty.pid) ?? this.#reportedCwd ?? this.spawnCwd;
  }

  /**
   * What the window is called right now. While `autoName` is on that is the
   * foreground command ("zsh", then "vim", then "zsh" again) — computed on
   * read rather than tracked, so no poll exists just to keep it fresh. A name
   * that could not be a valid window name (all digits, odd characters) keeps
   * the stored one instead.
   *
   * "/" and "@" are allowed on top of the stored-name charset: a foreground
   * command is named by processLabel, which qualifies a package ("@react-
   * router/serve") or a folder ("perch/server") that way. Neither character
   * is target syntax (":" splits session from window, "@" only leads a whole
   * spec), so "sess:perch/server" still resolves.
   */
  displayName(): string {
    if (!this.autoName) return this.name;
    const fg = this.liveForegroundCommand();
    return fg && /^[@A-Za-z0-9_./-]+$/.test(fg) && !/^\d+$/.test(fg) ? fg : this.name;
  }

  /**
   * tmux's `pane_current_command` equivalent: the shell's own name when idle,
   * or its youngest direct child's name when something is running in the
   * foreground (e.g. "vim", "claude"). A direct-children heuristic, not a
   * true foreground-process-group read (no ioctl(TIOCGPGRP) via node-pty) —
   * good enough for status display, not exact for pipelines.
   */
  liveForegroundCommand(): string | undefined {
    const child = platform.childPids(this.#pty.pid)[0];
    if (child !== undefined) return platform.processName(child) ?? platform.processName(this.#pty.pid);
    return platform.processName(this.#pty.pid);
  }

  /**
   * Process names running under this window's shell, breadth-first, deduped.
   *
   * The single foreground command is not enough to answer "is an agent running
   * here?": agents spawn subprocesses constantly (builds, tests, greps), and
   * the youngest-child heuristic then reports `sleep` or `rg` instead of
   * `claude` — a status dot driven by it would flicker off exactly when the
   * agent is busiest. The whole subtree is stable under that.
   *
   * Mechanism only: the daemon reports what is running and leaves the client to
   * decide which names mean "agent". Capped so a runaway tree can't make this
   * expensive on a per-poll call.
   */
  descendantCommands(limit = 24): string[] {
    const names: string[] = [];
    const seen = new Set<number>();
    const queue: number[] = [this.#pty.pid];
    while (queue.length > 0 && names.length < limit) {
      const pid = queue.shift()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const comm = platform.processName(pid);
      if (comm && !names.includes(comm)) names.push(comm);
      queue.push(...platform.childPids(pid));
    }
    return names;
  }

  applyScrollback(lines: number): void {
    this.#term.options.scrollback = lines;
  }

  /** Hang up everything the shell started, then kill whatever is left after a 2s grace. */
  kill(): void {
    this.#gracefulKill(2000);
  }

  /** For daemon shutdown: no grace, the group dies now. */
  killNow(): void {
    this.#gracefulKill(0);
  }

  #gracefulKill(graceMs: number): void {
    if (this.#exited) return;
    const pid = this.#pty.pid;
    platform.hangUpTree(pid);
    if (graceMs === 0) {
      platform.killTree(pid);
      return;
    }
    pendingKills.add(pid);
    const timer = setTimeout(() => {
      pendingKills.delete(pid);
      if (!this.#exited) {
        platform.killTree(pid);
      }
    }, graceMs);
    timer.unref();
  }
}

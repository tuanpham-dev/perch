import type { Server, Socket } from 'node:net';
import { createServer } from 'node:net';
import {
  FRAME_CONTROL, FRAME_INPUT, FRAME_OUTPUT,
  FrameReader, encodeControl, encodeFrame,
  writeFrame,
} from '../protocol/frames.ts';
import type { Request, Response, ServerEvent, SessionInfo, StatusInfo, ViewerColors, WindowInfo } from '../protocol/messages.ts';
import { SessionStore, StoreError, type Session } from './session-store.ts';
import { Window, type OutputSink } from './window.ts';
import type { Config } from '../util/config.ts';
import { homedir } from 'node:os';

export type DaemonHooks = {
  snapshotNow(): void;
  scheduleSnapshot(): void;
  reloadConfig(): Config;
  shutdown(code?: number): void;
  log(msg: string): void;
};

type Conn = {
  socket: Socket;
  reader: FrameReader;
  attachedSession: string | null;
  /** Set for window.attach connections: pinned to this window id, immune to
   *  the session's current-window switches. null = whole-session attach. */
  pinnedWindowId: string | null;
  cols: number;
  rows: number;
  /** When this viewer was last the user's active view — attach, input, or an
   *  explicit `activate` (focus). The most recently active viewer of a window
   *  decides that window's size, and its colors answer color queries. */
  lastActiveAt: number;
  /** The viewer's theme colors, if it reported any (browsers do; the CLI
   *  does not). */
  colors: ViewerColors | null;
  sink: OutputSink;
  /** Receives bell and sessions-changed events (see events.subscribe). */
  listening: boolean;
};

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
// Reset attributes, leave any alt screen, show cursor, clear screen and client
// scrollback — the serialized replay that follows assumes a blank terminal.
const REFRESH_PREFIX = '\x1b[0m\x1b[?1049l\x1b[?25h\x1b[H\x1b[2J\x1b[3J';

function defaultWindowName(command?: string): string {
  if (!command) return 'shell';
  const first = command.trim().split(/\s+/)[0] ?? 'shell';
  const base = first.split('/').pop() ?? 'shell';
  return /^[A-Za-z0-9_.-]+$/.test(base) && !/^\d+$/.test(base) ? base : 'shell';
}

/**
 * Accept only a loopback HTTP origin as a notification target. The daemon
 * fetches this URL from inside its own process, so an arbitrary one would turn
 * "announce your server" into "make the daemon call anywhere".
 */
export function normalizeNotifyUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'http:') return null;
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) return null;
  return `${url.protocol}//${url.host}`;
}

export class DaemonServer {
  store = new SessionStore<Window>();
  config: Config;
  #hooks: DaemonHooks;
  #server: Server | null = null;
  #attached = new Map<string, Set<Conn>>();
  /** Where to POST bells, announced by the server. Null when no server has
   *  connected — the CLI can run the daemon with nothing to notify. */
  #notifyUrl: string | null = null;
  #startedAt = Date.now();
  #listeners = new Set<Conn>();

  constructor(config: Config, hooks: DaemonHooks) {
    this.config = config;
    this.#hooks = hooks;
  }

  get notifyUrl(): string | null {
    return this.#notifyUrl;
  }

  /** Seeds the URL from the last snapshot so restored shells can report to the
   *  app before it has reconnected and announced itself. The app's announce
   *  replaces it; anything not a loopback address is dropped here too. */
  seedNotifyUrl(url: string | null | undefined): void {
    if (this.#notifyUrl || !url) return;
    this.#notifyUrl = normalizeNotifyUrl(url);
  }

  listen(path: string, onReady: () => void): void {
    this.#server = createServer((socket) => this.#handleConnection(socket));
    this.#server.listen(path, onReady);
  }

  close(): void {
    this.#server?.close();
  }

  #handleConnection(socket: Socket): void {
    const conn: Conn = {
      socket,
      reader: new FrameReader(),
      attachedSession: null,
      pinnedWindowId: null,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      lastActiveAt: 0,
      colors: null,
      listening: false,
      sink: { writeOutput: (data) => writeFrame(socket, FRAME_OUTPUT, data) },
    };
    socket.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = conn.reader.push(chunk);
      } catch (err) {
        this.#hooks.log(`protocol error, dropping connection: ${String(err)}`);
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.type === FRAME_INPUT) this.#handleInput(conn, frame.payload);
        else if (frame.type === FRAME_CONTROL) this.#handleControl(conn, frame.payload);
      }
    });
    socket.on('close', () => {
      this.#listeners.delete(conn);
      this.#detachConn(conn);
    });
    socket.on('error', () => { /* close follows */ });
  }

  #handleInput(conn: Conn, payload: Buffer): void {
    if (!conn.attachedSession) return;
    const session = this.store.sessions.get(conn.attachedSession);
    if (!session || session.windows.length === 0) return;
    // Typing makes a viewer the active one; if that changed which viewer wins,
    // the window reflows to it.
    this.#markActive(conn, session);
    const target = conn.pinnedWindowId
      ? session.windows.find((w) => w.id === conn.pinnedWindowId)
      : this.store.currentWindow(session);
    target?.write(payload.toString('utf8'));
  }

  #handleControl(conn: Conn, payload: Buffer): void {
    let req: Request;
    try {
      req = JSON.parse(payload.toString('utf8')) as Request;
    } catch {
      this.#hooks.log('unparseable control frame, dropping connection');
      conn.socket.destroy();
      return;
    }
    let response: Response;
    try {
      response = { id: req.id, ok: true, data: this.#dispatch(conn, req) };
    } catch (err) {
      const code = err instanceof StoreError ? err.code : 'INTERNAL';
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'INTERNAL') this.#hooks.log(`internal error on ${req.kind}: ${message}`);
      response = { id: req.id, ok: false, error: { code, message } };
    }
    conn.socket.write(encodeControl(response));
  }

  #dispatch(conn: Conn, req: Request): unknown {
    switch (req.kind) {
      case 'session.new': {
        const cwd = req.cwd ?? homedir();
        // Named after the folder it runs in, so several agents are tellable
        // apart in the sidebar, the tab bar and a `send` target. Deliberately
        // req.cwd and not the defaulted cwd: a caller that named no folder
        // isn't in a project, and naming that session after the home directory
        // would label it with the username, which reads as an account rather
        // than as work.
        const sessionName = this.store.resolveNewSessionName(req.name, req.cwd);
        const window = this.#makeWindow({
          name: defaultWindowName(req.command),
          sessionName,
          command: req.command,
          cwd,
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
        });
        const session = this.store.createSession(sessionName, window, cwd);
        this.#structureChanged();
        return { id: session.id, name: session.name, windowId: window.id };
      }
      case 'session.list': {
        const list: SessionInfo[] = [...this.store.sessions.values()].map((s) => {
          const current = s.windows[s.currentIndex];
          return {
            id: s.id,
            name: s.name,
            windows: s.windows.length,
            attached: this.#attached.get(s.name)?.size ?? 0,
            createdAt: s.createdAt,
            currentIndex: s.currentIndex,
            cwd: current?.liveCwd() ?? '',
            rootCwd: s.rootCwd,
            foregroundCommand: current?.liveForegroundCommand(),
            commands: current?.descendantCommands() ?? [],
            lastOutputAt: current?.lastOutputAt ?? s.createdAt,
          };
        });
        return list;
      }
      case 'session.kill': {
        this.#closeSession(this.store.getSession(req.session));
        return {};
      }
      case 'session.rename': {
        const conns = this.#attached.get(req.session);
        this.store.renameSession(req.session, req.to);
        if (conns) {
          this.#attached.delete(req.session);
          this.#attached.set(req.to, conns);
          for (const c of conns) c.attachedSession = req.to;
        }
        this.#structureChanged();
        return {};
      }
      case 'session.attach': {
        if (conn.attachedSession) throw new StoreError('ALREADY_ATTACHED', 'this connection is already attached');
        const session = this.store.getSession(req.session);
        conn.attachedSession = session.name;
        conn.pinnedWindowId = null;
        conn.cols = req.cols;
        conn.rows = req.rows;
        conn.colors = req.colors ?? null;
        conn.lastActiveAt = Date.now(); // a fresh attach is the active view
        let set = this.#attached.get(session.name);
        if (!set) { set = new Set(); this.#attached.set(session.name, set); }
        set.add(conn);
        const current = this.store.currentWindow(session);
        this.#resizeWindow(session, current);
        current.setViewerColors(conn.colors);
        // Response goes first so the client can enter raw mode before output arrives.
        queueMicrotask(() => {
          if (conn.socket.destroyed) return;
          this.#sendRefresh(conn, current);
          current.subscribe(conn.sink);
        });
        return { session: session.name, index: session.currentIndex, name: current.displayName() };
      }
      case 'window.attach': {
        if (conn.attachedSession) throw new StoreError('ALREADY_ATTACHED', 'this connection is already attached');
        const { session, window, index } = this.store.resolveTarget(req.target);
        conn.attachedSession = session.name;
        conn.pinnedWindowId = window.id;
        conn.cols = req.cols;
        conn.rows = req.rows;
        conn.colors = req.colors ?? null;
        conn.lastActiveAt = Date.now(); // a fresh attach is the active view
        let set = this.#attached.get(session.name);
        if (!set) { set = new Set(); this.#attached.set(session.name, set); }
        set.add(conn);
        this.#resizeWindow(session, window);
        window.setViewerColors(conn.colors);
        queueMicrotask(() => {
          if (conn.socket.destroyed) return;
          this.#sendRefresh(conn, window);
          window.subscribe(conn.sink);
        });
        return { session: session.name, index, name: window.displayName(), windowId: window.id };
      }
      case 'session.detach': {
        this.#detachConn(conn);
        return {};
      }
      case 'activate': {
        // The client reports it became the user's focused view; the window
        // reflows to this viewer's size.
        if (!conn.attachedSession) return {};
        const session = this.store.sessions.get(conn.attachedSession);
        if (session) this.#markActive(conn, session);
        return {};
      }
      case 'window.new': {
        const session = this.store.defaultSession(req.session);
        // A new window becomes current, so seed it at the size of the smallest
        // session-attached client (they will switch to view it); #resizeWindow
        // after the switch settles it exactly.
        const size = this.#spawnSize(session);
        const prev = this.store.currentWindow(session);
        const window = this.#makeWindow({
          name: req.name ?? defaultWindowName(req.command),
          autoName: req.name === undefined,
          sessionName: session.name,
          command: req.command,
          cwd: req.cwd ?? homedir(),
          cols: size.cols,
          rows: size.rows,
        });
        const index = this.store.addWindow(session, window, !req.background);
        if (!req.background) this.#switchTo(session, prev);
        this.#structureChanged();
        return { session: session.name, index, name: window.displayName(), windowId: window.id };
      }
      case 'window.list': {
        const session = this.store.defaultSession(req.session);
        const list: WindowInfo[] = session.windows.map((w, i) => ({
          index: i,
          windowId: w.id,
          name: w.displayName(),
          autoName: w.autoName,
          current: i === session.currentIndex,
          command: w.command,
          cwd: w.liveCwd(),
          pid: w.pid,
          foregroundCommand: w.liveForegroundCommand(),
          commands: w.descendantCommands(),
          lastOutputAt: w.lastOutputAt,
          activity: w.activity,
          ...(w.restoredCommands ? { restoredCommands: w.restoredCommands } : {}),
        }));
        return list;
      }
      case 'window.select': {
        const prevTarget = this.store.resolveTarget(req.target);
        const prev = this.store.currentWindow(prevTarget.session);
        const { session } = this.store.selectWindow(req.target);
        this.#switchTo(session, prev);
        this.#structureChanged();
        return { index: session.currentIndex };
      }
      case 'window.next':
      case 'window.prev': {
        const session = this.store.defaultSession(req.session);
        const prev = this.store.currentWindow(session);
        this.store.rotateWindow(session, req.kind === 'window.next' ? 1 : -1);
        this.#switchTo(session, prev);
        this.#structureChanged();
        return { index: session.currentIndex, name: this.store.currentWindow(session).displayName() };
      }
      case 'window.rename': {
        this.store.renameWindow(req.target, req.to);
        this.#structureChanged();
        return {};
      }
      case 'window.clearRestored': {
        const { window } = this.store.resolveTarget(req.target);
        window.restoredCommands = null;
        this.#hooks.snapshotNow();
        return {};
      }
      case 'window.resetName': {
        this.store.resetWindowName(req.target);
        this.#structureChanged();
        return {};
      }
      case 'window.kill': {
        const removed = this.store.removeWindow(req.target);
        const { session, window } = removed;
        window.onExit = undefined; // killed on purpose; skip the exit handler
        window.kill();
        this.#emitToSession(session.name, { event: 'window-closed', session: session.name, index: removed.index });
        this.#closePinnedConns(session.name, window.id);
        if (removed.sessionEmpty) {
          this.#closeSession(session, true);
        } else if (removed.wasCurrent) {
          this.#switchTo(session, window);
        }
        this.#structureChanged();
        return {};
      }
      case 'io.capture': {
        const { window } = this.store.resolveTarget(req.target);
        return { text: window.capture(req.scrollback ?? 0) };
      }
      case 'io.send': {
        const { window } = this.store.resolveTarget(req.target);
        window.write(req.data);
        return {};
      }
      case 'resize': {
        // Only a size that actually changed is the user doing something with
        // this view. Browsers re-measure and re-send the same size for all
        // sorts of idle reasons (a reconnect, a settings sync, a phone's
        // address bar), and letting those claim the window handed it to
        // whichever idle viewer re-measured last, usually the small one.
        const changed = conn.cols !== req.cols || conn.rows !== req.rows;
        conn.cols = req.cols;
        conn.rows = req.rows;
        if (changed && conn.attachedSession) {
          const session = this.store.sessions.get(conn.attachedSession);
          if (session && session.windows.length > 0) {
            // Resizing a view IS using it: the user dragged that window or
            // rotated that device. Claim, so the window reflows to the pane the
            // user is actually manipulating instead of staying sized for some
            // other (possibly forgotten) viewer. #markActive resizes the window.
            this.#markActive(conn, session);
          }
        }
        return {};
      }
      case 'daemon.status': {
        const status: StatusInfo = {
          pid: process.pid,
          startedAt: this.#startedAt,
          sessions: this.store.sessions.size,
          windows: [...this.store.sessions.values()].reduce((n, s) => n + s.windows.length, 0),
          config: { ...this.config },
        };
        return status;
      }
      case 'daemon.stop': {
        setImmediate(() => this.#hooks.shutdown(0));
        return {};
      }
      case 'events.subscribe': {
        conn.listening = true;
        this.#listeners.add(conn);
        return {};
      }
      case 'notify.configure': {
        // Validated here rather than trusted: this URL is fetched from inside
        // the daemon, so only a loopback HTTP address is acceptable.
        this.#notifyUrl = normalizeNotifyUrl(req.url);
        return { url: this.#notifyUrl };
      }

      case 'daemon.reloadConfig': {
        this.config = this.#hooks.reloadConfig();
        for (const s of this.store.sessions.values()) {
          for (const w of s.windows) w.applyScrollback(this.config.scrollbackLines);
        }
        return { config: { ...this.config } };
      }
      default: {
        const kind = (req as { kind?: string }).kind ?? '<missing>';
        throw new StoreError('UNKNOWN_REQUEST', `unknown request kind ${JSON.stringify(kind)}`);
      }
    }
  }

  /** Insert a fully-built session (used by restore-on-boot). */
  adoptSession(id: string, name: string, windows: Window[], currentIndex: number, rootCwd: string, createdAt: number): void {
    for (const w of windows) {
      w.onExit = (x) => this.#windowExited(x);
      w.onActivity = () => this.#hooks.scheduleSnapshot();
      w.onBell = (x) => this.#reportBell(x);
    }
    this.store.sessions.set(name, { id, name, windows, currentIndex, createdAt, rootCwd });
  }

  #makeWindow(opts: { name: string; autoName?: boolean; sessionName: string; command?: string; cwd: string; cols: number; rows: number }): Window {
    const window = new Window({
      ...opts,
      // Whichever server last announced itself here, so a shell reports its
      // commands to the perch that actually owns this daemon rather than to
      // whatever port happened to write the integration script last.
      serverUrl: this.#notifyUrl,
      shell: this.config.shell,
      scrollbackLines: this.config.scrollbackLines,
      rawScrollbackBytes: this.config.rawScrollbackBytes,
    });
    window.onExit = (w) => this.#windowExited(w);
    window.onActivity = () => this.#hooks.scheduleSnapshot();
    window.onBell = (w) => this.#reportBell(w);
    return window;
  }

  /** The shell in a window exited on its own (typed `exit`, or was killed). */
  #windowExited(w: Window): void {
    const found = this.store.findWindowById(w.id);
    if (!found) return;
    const { session, index } = found;
    const { wasCurrent, sessionEmpty } = this.store.removeWindowAt(session, index);
    this.#emitToSession(session.name, { event: 'window-closed', session: session.name, index });
    this.#closePinnedConns(session.name, w.id);
    if (sessionEmpty) {
      this.#closeSession(session, true);
    } else if (wasCurrent) {
      this.#switchTo(session, w);
    }
    this.#structureChanged();
  }

  /** End every connection pinned (window.attach) to a now-gone window. Session
   *  attaches are untouched — they follow the survivor via #switchTo. */
  #closePinnedConns(sessionName: string, windowId: string): void {
    for (const conn of [...(this.#attached.get(sessionName) ?? [])]) {
      if (conn.pinnedWindowId !== windowId) continue;
      conn.socket.write(encodeControl({ event: 'window-closed', session: sessionName, index: -1 } satisfies ServerEvent));
      this.#detachConn(conn);
      conn.socket.end();
    }
  }

  #closeSession(session: Session<Window>, alreadyRemoved = false): void {
    if (!alreadyRemoved && this.store.sessions.has(session.name)) this.store.removeSession(session.name);
    else this.store.sessions.delete(session.name);
    for (const conn of this.#attached.get(session.name) ?? []) {
      conn.attachedSession = null;
      conn.socket.write(encodeControl({ event: 'session-closed', session: session.name } satisfies ServerEvent));
      conn.socket.end();
    }
    this.#attached.delete(session.name);
    for (const w of session.windows) {
      w.onExit = undefined;
      w.kill();
    }
    this.#structureChanged();
    if (this.store.sessions.size === 0) {
      this.#hooks.log('last session closed; daemon exiting');
      setImmediate(() => this.#hooks.shutdown(0));
    }
  }

  #detachConn(conn: Conn): void {
    if (!conn.attachedSession) return;
    const name = conn.attachedSession;
    const pinned = conn.pinnedWindowId;
    conn.attachedSession = null;
    conn.pinnedWindowId = null;
    this.#attached.get(name)?.delete(conn);
    if (this.#attached.get(name)?.size === 0) this.#attached.delete(name);
    const session = this.store.sessions.get(name);
    if (session && session.windows.length > 0) {
      // Unsubscribe from whichever window this conn was viewing, and resize
      // that window down now that it has one fewer viewer.
      const viewed = pinned
        ? session.windows.find((w) => w.id === pinned)
        : this.store.currentWindow(session);
      if (viewed) {
        viewed.unsubscribe(conn.sink);
        this.#resizeWindow(session, viewed);
      }
    }
  }

  /**
   * Promote a connection to "active" and reflow its window if that changed the
   * winner. Cheap and idempotent: when the conn was already active, the size
   * recompute yields the same numbers and #resizeWindow's early-out in
   * Window.resize makes it a no-op.
   */
  #markActive(conn: Conn, session: Session<Window>): void {
    const now = Date.now();
    if (conn.lastActiveAt === now) return;
    conn.lastActiveAt = now;
    if (session.windows.length === 0) return;
    const viewed = conn.pinnedWindowId
      ? session.windows.find((w) => w.id === conn.pinnedWindowId)
      : this.store.currentWindow(session);
    if (viewed) {
      this.#resizeWindow(session, viewed);
      viewed.setViewerColors(conn.colors);
    }
  }

  /** Initial size for a freshly created window: the smallest session-attached
   *  (unpinned) client, since a new window becomes current and those conns will
   *  view it. Default when nothing is attached. */
  #spawnSize(session: Session<Window>): { cols: number; rows: number } {
    const conns = this.#attached.get(session.name);
    let cols = Infinity;
    let rows = Infinity;
    for (const c of conns ?? []) {
      if (c.pinnedWindowId) continue;
      cols = Math.min(cols, c.cols);
      rows = Math.min(rows, c.rows);
    }
    if (!Number.isFinite(cols)) return { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
    return { cols: Math.max(2, cols), rows: Math.max(2, rows) };
  }

  /**
   * A window is sized to its ACTIVE viewer — the one most recently attached,
   * typed into, or focused — not to the smallest viewer.
   *
   * tmux uses smallest-client-wins because every client is a real terminal it
   * cannot resize. Our viewers are browser panes that re-render on demand,
   * so shrinking a desktop to a phone's grid (and keeping it there while the
   * phone sits idle in a pocket) is the wrong trade: it degrades the view the
   * user is actually looking at. Instead the window reflows to whoever is
   * driving it, and other viewers mirror that grid — a larger one simply has
   * unused space, a smaller one scrolls.
   *
   * Ties (same timestamp) fall back to the smaller viewer, so a brand-new
   * attach can't briefly overflow a still-active smaller pane.
   * A window nobody views keeps its last size.
   */
  #windowSize(session: Session<Window>, window: Window): { cols: number; rows: number } | null {
    const conns = this.#attached.get(session.name);
    if (!conns) return null;
    const isCurrent = this.store.currentWindow(session) === window;
    let best: Conn | null = null;
    for (const c of conns) {
      // A half-closed socket must never win: a viewer whose page is gone but
      // whose close event hasn't landed would otherwise hold the window at its
      // size forever, and nothing the live viewers do could take it back.
      if (c.socket.destroyed) continue;
      const views = c.pinnedWindowId ? c.pinnedWindowId === window.id : isCurrent;
      if (!views) continue;
      if (
        !best ||
        c.lastActiveAt > best.lastActiveAt ||
        (c.lastActiveAt === best.lastActiveAt && c.cols * c.rows < best.cols * best.rows)
      ) {
        best = c;
      }
    }
    if (!best) return null;
    return { cols: Math.max(2, best.cols), rows: Math.max(2, best.rows) };
  }

  /** Resize one window to its viewers and tell those viewers the new size. */
  #resizeWindow(session: Session<Window>, window: Window): void {
    const size = this.#windowSize(session, window);
    if (!size) return; // unviewed — leave it at its last size
    window.resize(size.cols, size.rows);
    const isCurrent = this.store.currentWindow(session) === window;
    for (const conn of this.#attached.get(session.name) ?? []) {
      const views = conn.pinnedWindowId ? conn.pinnedWindowId === window.id : isCurrent;
      if (views) conn.socket.write(encodeControl({ event: 'resize', cols: size.cols, rows: size.rows } satisfies ServerEvent));
    }
  }

  #switchTo(session: Session<Window>, prev: Window | null): void {
    if (session.windows.length === 0) return;
    const current = this.store.currentWindow(session);
    if (current === prev) return;
    // Only session-attached (unpinned) conns follow window switches; pinned
    // window conns stay on their own window.
    for (const conn of this.#attached.get(session.name) ?? []) {
      if (conn.pinnedWindowId) continue;
      if (prev && !prev.exited) prev.unsubscribe(conn.sink);
      conn.socket.write(encodeControl({
        event: 'window-switch', session: session.name, index: session.currentIndex, name: current.displayName(),
      } satisfies ServerEvent));
      this.#sendRefresh(conn, current);
      current.subscribe(conn.sink);
    }
    // The window gaining/losing session-viewers may need to resize.
    if (prev && !prev.exited) this.#resizeWindow(session, prev);
    this.#resizeWindow(session, current);
  }

  /** Tell listeners (the app server, which owns push subscriptions) a window
   *  rang. The daemon never makes the HTTP call itself: whoever is listening
   *  decides what a bell means. */
  #reportBell(window: Window): void {
    const session = this.#sessionNameOf(window);
    if (session) this.#broadcast({ event: 'bell', session, windowId: window.id });
  }

  #sessionNameOf(window: Window): string | null {
    for (const session of this.store.sessions.values()) {
      if (session.windows.includes(window)) return session.name;
    }
    return null;
  }

  #sendRefresh(conn: Conn, window: Window): void {
    // replayPayload prefers a byte-exact raw replay (preserving OSC 8 links and
    // OSC 133 marks) and falls back to the serialize path (with REFRESH_PREFIX)
    // on the alt screen or when the sidecar is empty.
    conn.socket.write(encodeFrame(FRAME_OUTPUT, window.replayPayload(this.config.persistScrollbackLines, REFRESH_PREFIX)));
    // Ordered after the payload on the same socket, so a viewer can tell
    // exactly where replayed history ends and live output begins.
    conn.socket.write(encodeControl({ event: 'replayed', session: conn.attachedSession ?? '' } satisfies ServerEvent));
  }

  /** A session or window was created, removed, renamed or reselected. */
  #structureChanged(): void {
    this.#hooks.snapshotNow();
    this.#broadcast({ event: 'sessions-changed' });
  }

  #broadcast(event: ServerEvent): void {
    for (const conn of this.#listeners) {
      if (!conn.socket.destroyed) conn.socket.write(encodeControl(event));
    }
  }

  #emitToSession(name: string, event: ServerEvent): void {
    for (const conn of this.#attached.get(name) ?? []) {
      conn.socket.write(encodeControl(event));
    }
  }

  /** Used at shutdown: hard-kill every window's process group. */
  killAllWindows(): void {
    for (const session of this.store.sessions.values()) {
      for (const w of session.windows) {
        w.onExit = undefined;
        w.killNow();
      }
    }
  }
}

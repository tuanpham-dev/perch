/** A viewer's theme colors (`#rrggbb`), so the daemon can answer a program's
 *  color queries (OSC 10/11) on that viewer's behalf. */
export type ViewerColors = { foreground?: string; background?: string };

export type ErrorInfo = { code: string; message: string };

export type Request =
  | { id: number; kind: 'session.new'; name?: string; command?: string; cwd?: string }
  | { id: number; kind: 'session.list' }
  | { id: number; kind: 'session.kill'; session: string }
  | { id: number; kind: 'session.rename'; session: string; to: string }
  | { id: number; kind: 'session.attach'; session: string; cols: number; rows: number; colors?: ViewerColors }
  | { id: number; kind: 'window.attach'; target: string; cols: number; rows: number; colors?: ViewerColors }
  | { id: number; kind: 'session.detach' }
  /** This connection became the user's active view — it drives the window size. */
  | { id: number; kind: 'activate' }
  // background: create without making it the session's current window, so
  // viewers following the session stay where they are.
  | { id: number; kind: 'window.new'; session?: string; name?: string; command?: string; cwd?: string; background?: boolean }
  | { id: number; kind: 'window.list'; session?: string }
  | { id: number; kind: 'window.select'; target: string }
  | { id: number; kind: 'window.next'; session?: string }
  | { id: number; kind: 'window.prev'; session?: string }
  | { id: number; kind: 'window.rename'; target: string; to: string }
  | { id: number; kind: 'window.resetName'; target: string }
  // A client has acted on (or declined) a restored window's restoredCommands.
  | { id: number; kind: 'window.clearRestored'; target: string }
  | { id: number; kind: 'window.kill'; target: string }
  | { id: number; kind: 'io.capture'; target: string; scrollback?: number }
  | { id: number; kind: 'io.send'; target: string; data: string }
  | { id: number; kind: 'resize'; cols: number; rows: number }
  | { id: number; kind: 'daemon.status' }
  | { id: number; kind: 'daemon.stop' }
  | { id: number; kind: 'daemon.reloadConfig' }
  // Where to POST bell notifications. The daemon outlives any one server
  // process and can be started by the CLI with no server at all, so the server
  // announces itself rather than the daemon guessing a port.
  | { id: number; kind: 'notify.configure'; url: string | null }
  // Turns this connection into a listener for daemon-wide events (bell,
  // sessions-changed) without attaching to anything. The app server holds one
  // so it hears about every window, including ones nobody is looking at.
  | { id: number; kind: 'events.subscribe' };

export type RequestKind = Request['kind'];

export type Response =
  | { id: number; ok: true; data?: unknown }
  | { id: number; ok: false; error: ErrorInfo };

export type ServerEvent =
  | { event: 'window-switch'; session: string; index: number; name: string }
  | { event: 'window-closed'; session: string; index: number }
  | { event: 'session-closed'; session: string }
  | { event: 'resize'; cols: number; rows: number }
  // Emitted immediately after a replay payload. A viewer must know where the
  // replayed history ends, because replaying raw bytes replays any capability
  // QUERIES the history contains, and a terminal answers those — the answers
  // would arrive at the shell as typed input.
  | { event: 'replayed'; session: string }
  // To events.subscribe listeners only.
  | { event: 'bell'; session: string; windowId: string }
  | { event: 'sessions-changed' };

export type ControlMessage = Request | Response | ServerEvent;

export type SessionInfo = {
  /** Stable across renames and restores. */
  id: string;
  name: string;
  windows: number;
  attached: number;
  createdAt: number;
  currentIndex: number;
  // Current window's live details, so the sidebar renders a session row from a
  // single session.list call (parity with perch's listSessions format).
  cwd: string;
  /** Where the session was started. Unlike `cwd` this never moves, so a client
   *  can say which project a session belongs to without the answer changing
   *  every time someone cds or opens a window elsewhere. */
  rootCwd: string;
  foregroundCommand?: string;
  /** Process names under the current window's shell (breadth-first, deduped).
   *  Lets a client answer "is an agent running here?" without the foreground
   *  heuristic flickering when the agent spawns a subprocess. */
  commands: string[];
  lastOutputAt: number;
};
export type WindowInfo = {
  index: number;
  /** Stable window uuid (matches PERCH_WINDOW in the shell's env). */
  windowId: string;
  /** The live name: the foreground command while `autoName` is on. */
  name: string;
  /** False once somebody renamed the window; `window.resetName` turns it back on. */
  autoName: boolean;
  current: boolean;
  command?: string;
  cwd: string;
  /** pid of the window's shell (session leader) — walk its process group to find what it owns. */
  pid: number;
  /** tmux's pane_current_command equivalent; see Window.liveForegroundCommand. */
  foregroundCommand?: string;
  /** Process names under this window's shell; see Window.descendantCommands. */
  commands: string[];
  /** epoch ms of the window's most recent output — activity indicator. */
  lastOutputAt: number;
  /** Set on a restored window: the processes that were running under its
   *  shell before the restart (e.g. ["claude"]). Cleared by window.clearRestored. */
  restoredCommands?: string[];
  /** Output arrived while nobody was viewing this window (tmux's
   *  window_activity_flag). Clears once a viewer shows it. */
  activity: boolean;
};
export type StatusInfo = { pid: number; startedAt: number; sessions: number; windows: number; config: Record<string, string | number | boolean> };

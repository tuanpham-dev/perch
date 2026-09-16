// Command event store (plans/warp-features.md Phase 1): pairs the start/end
// reports posted by the shell-integration snippet (shellIntegration.ts) into
// per-pane command history, and fans live events out to subscribers — the
// /ws/attach connections (live "commandEvent" frames) and push.ts
// (finished-command notifications). In-memory only: history is a
// convenience view over what's still on screen in the terminal, not a durable log,
// so losing it on restart is fine.

export interface CompletedCommand {
  command: string;
  cwd: string;
  startedAt: number;
  endedAt: number;
  exitCode: number;
  durationMs: number;
}

export interface RunningCommand {
  command: string;
  cwd: string;
  startedAt: number;
  // Pair key (see shellIntegration.ts's report comment): the reporting
  // shell's pid and its per-shell sequence counter.
  shellPid: number;
  seq: number;
}

export interface CommandEventFrame {
  pane: string;
  // The pane's session name — what clients display and extensions compare
  // against the active context.
  sessionName: string;
  // Group-or-name routing key: what wsAttach matches against its own attach
  // target, which on the tmux backend is usually a grouped
  // perch-view-* session whose NAME never equals sessionName.
  sessionKey: string;
  event: "start" | "end";
  command: string;
  cwd: string;
  exitCode?: number;
  durationMs?: number;
}

interface PaneState {
  running: RunningCommand | null;
  history: CompletedCommand[];
  // Pair key of the most recent end report — a start arriving AFTER its own
  // end (both are fire-and-forget curls; fast commands genuinely reorder)
  // matches this and is dropped instead of becoming a stuck running entry.
  lastEnd: { shellPid: number; seq: number } | null;
  lastTouched: number;
}

// Last 200 completed commands per pane (plan), and a pane cap so panes that
// died keep leaking state forever — least-recently-touched pane is evicted.
const HISTORY_LIMIT = 200;
const PANE_LIMIT = 200;

const panes = new Map<string, PaneState>();
const listeners = new Set<(frame: CommandEventFrame) => void>();

// Whether any report has ever arrived this server lifetime — the Settings
// card's "integration active" signal.
let receivedAny = false;

export function hasReceivedEvents(): boolean {
  return receivedAny;
}

export function subscribeCommandEvents(listener: (frame: CommandEventFrame) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(frame: CommandEventFrame): void {
  for (const listener of listeners) listener(frame);
}

function touch(pane: string): PaneState {
  let state = panes.get(pane);
  if (!state) {
    state = { running: null, history: [], lastEnd: null, lastTouched: 0 };
    panes.set(pane, state);
    if (panes.size > PANE_LIMIT) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [key, s] of panes) {
        if (s.lastTouched < oldestAt) {
          oldestAt = s.lastTouched;
          oldestKey = key;
        }
      }
      if (oldestKey) panes.delete(oldestKey);
    }
  }
  state.lastTouched = Date.now();
  return state;
}

export function recordStart(
  pane: string,
  sessionName: string,
  sessionKey: string,
  shellPid: number,
  seq: number,
  command: string,
  cwd: string,
): void {
  receivedAny = true;
  const state = touch(pane);
  // This start's own end already arrived (fast command, reports reordered) —
  // recording it as running now would leave it stuck there forever.
  if (state.lastEnd && state.lastEnd.shellPid === shellPid && seq <= state.lastEnd.seq) return;
  state.running = { command, cwd, startedAt: Date.now(), shellPid, seq };
  emit({ pane, sessionName, sessionKey, event: "start", command, cwd });
}

// Timestamps are receipt times: for a paired end the duration is
// end-receipt minus start-receipt (curl lag roughly cancels); for an end
// that won the race against its own start, startedAt === endedAt — a
// command fast enough to reorder ran for less than the curl lag anyway.
export function recordEnd(
  pane: string,
  sessionName: string,
  sessionKey: string,
  shellPid: number,
  seq: number,
  command: string,
  exitCode: number,
  cwd: string,
): void {
  receivedAny = true;
  const state = touch(pane);
  state.lastEnd = { shellPid, seq };
  const running = state.running;
  const matched = running !== null && running.shellPid === shellPid && running.seq === seq;
  // A non-matching running entry from the SAME shell is stale (its end was
  // lost); one from another shell (a nested shell that just exited back to
  // its parent) is equally finished. Either way this end supersedes it.
  state.running = null;
  const endedAt = Date.now();
  const completed: CompletedCommand = {
    command: matched ? running.command : command,
    cwd: (matched ? running.cwd : "") || cwd,
    startedAt: matched ? running.startedAt : endedAt,
    endedAt,
    exitCode,
    durationMs: matched ? endedAt - running.startedAt : 0,
  };
  // An end with no command text from either source (report lost AND payload
  // empty) would be a noise row.
  if (!completed.command) return;
  state.history.push(completed);
  if (state.history.length > HISTORY_LIMIT) state.history.shift();
  emit({
    pane,
    sessionName,
    sessionKey,
    event: "end",
    command: completed.command,
    cwd: completed.cwd,
    exitCode,
    durationMs: completed.durationMs,
  });
}

export function paneHistory(pane: string): { running: RunningCommand | null; history: CompletedCommand[] } {
  const state = panes.get(pane);
  if (!state) return { running: null, history: [] };
  return { running: state.running, history: state.history };
}

// The app's view of its terminals: sessions of windows, addressed the way the
// client and extensions address them (a session name, a window index), built
// on whatever engine getMultiplexer() returns. Routes, the extension host and
// the attach bridge call these; none of them knows which engine is running.
import { homedir } from "node:os";
import { expandHome, getGitRoot, shortenHome } from "./files.js";
import { getMultiplexer, type MuxSession, type MuxWindow } from "./multiplexer.js";

export interface TerminalWindow {
  // Stable id — survives renumbering, renames and a daemon restart, unlike
  // index. Lets the client re-target a tab whose window moved.
  id: string;
  index: number;
  name: string;
  active: boolean;
  // `~`-shortened.
  cwd: string;
  activity: boolean;
  // The foreground command ("zsh", "vim", "claude") — lets extensions gate a
  // per-window action on what's actually running there.
  command: string;
}

export interface TerminalSession {
  // Stable id — survives rename, unlike name.
  id: string;
  name: string;
  // Epoch seconds (what the client has always received).
  created: number;
  attached: number;
  // Where the session started, `~`-shortened — the key the client matches
  // sessions to registered projects by, since it survives renames.
  path: string;
  windows: TerminalWindow[];
}


// Thrown when a window addressed by index is gone by the time it's acted on,
// so a route can answer 404 and the client can recover quietly.
export class WindowGoneError extends Error {}

const mux = () => getMultiplexer();

function toTerminalWindow(w: MuxWindow): TerminalWindow {
  return {
    id: w.id,
    index: w.index,
    name: w.name,
    active: w.current,
    cwd: shortenHome(w.cwd),
    activity: w.activity,
    command: w.command,
  };
}

function toTerminalSession(s: MuxSession): TerminalSession {
  return {
    id: s.id,
    name: s.name,
    created: Math.floor(s.createdAt / 1000),
    attached: s.attached,
    path: shortenHome(s.rootCwd),
    windows: s.windows.map(toTerminalWindow),
  };
}

// Every open tab polls /api/sessions; share one listing across all of them
// for a beat. Mutations made through this server invalidate it on response
// (api.ts's middleware) and daemon-wide changes invalidate it on the event.
const SESSIONS_TTL_MS = 500;
let cache: { at: number; value: MuxSession[] } | null = null;
let inFlight: Promise<MuxSession[]> | null = null;
let listeningForChanges = false;

export function invalidateSessionsCache(): void {
  cache = null;
}

function rawSessions(): Promise<MuxSession[]> {
  if (!listeningForChanges) {
    listeningForChanges = true;
    mux().onEvent((e) => {
      if (e.event === "sessions-changed") invalidateSessionsCache();
    });
  }
  if (cache && Date.now() - cache.at < SESSIONS_TTL_MS) return Promise.resolve(cache.value);
  if (inFlight) return inFlight;
  inFlight = mux()
    .listSessions()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function freshSessions(): Promise<MuxSession[]> {
  invalidateSessionsCache();
  return rawSessions();
}

export async function listSessions(): Promise<TerminalSession[]> {
  return (await rawSessions()).map(toTerminalSession);
}

async function findSession(name: string): Promise<MuxSession> {
  const s = (await rawSessions()).find((x) => x.name === name) ?? (await freshSessions()).find((x) => x.name === name);
  if (!s) throw new Error(`can't find session: ${name}`);
  return s;
}

// A new session starts at the git repo root containing `cwd` (matching the
// FILES panel's rooting), else `cwd` itself — unless exactCwd: a project
// session must start at the registered folder so its path round-trips to the
// project's cwd. With no cwd at all, NEW_SESSION_CWD, then home.
export async function createSession(name?: string, cwd?: string, exactCwd = false): Promise<TerminalSession> {
  const dir = cwd || (process.env.NEW_SESSION_CWD ? expandHome(process.env.NEW_SESSION_CWD) : undefined);
  const start = dir ? (exactCwd ? dir : ((await getGitRoot(dir)) ?? dir)) : homedir();
  const created = await mux().createSession({ name, cwd: start });
  const session = (await freshSessions()).find((s) => s.id === created.id);
  if (!session) throw new Error(`session "${created.name}" not found after create`);
  return toTerminalSession(session);
}

// Idempotent: killing a session that's already gone is not an error.
export async function killSession(name: string): Promise<void> {
  try {
    await mux().killSession(name);
  } catch (err) {
    if (!/no session named/i.test((err as Error).message)) throw err;
  }
}

export async function renameSession(name: string, newName: string): Promise<void> {
  await mux().renameSession(name, newName);
}

export async function selectWindow(session: string, index: number): Promise<void> {
  await mux().selectWindow(`${session}:${index}`);
}

// Idempotent for the same reason as killSession.
export async function killWindow(session: string, index: number): Promise<void> {
  try {
    await mux().killWindow(`${session}:${index}`);
  } catch (err) {
    if (!/no session named|has no window/i.test((err as Error).message)) throw err;
  }
}

// A new terminal starts at the session's own folder, not wherever its active
// window has cd'd to. A name given here stays; without one the window is named
// after what runs in it. Returns the new window's index.
export async function createWindow(session: string, cwd?: string, name?: string): Promise<number> {
  const dir = cwd ? expandHome(cwd) : (await findSession(session)).rootCwd;
  return (await mux().createWindow(session, { cwd: dir, name })).index;
}

// The session's lazygit window — by running command, or by name for one
// momentarily running something else — or a new one running lazygit.
export async function openLazygitWindow(session: string, cwd?: string): Promise<number> {
  const s = await findSession(session);
  const existing = s.windows.find((w) => w.command === "lazygit" || w.name === "lazygit");
  if (existing) return existing.index;
  const current = s.windows.find((w) => w.current);
  const dir = cwd ? expandHome(cwd) : (current?.cwd ?? s.rootCwd);
  return (await mux().createWindow(session, { cwd: dir, name: "lazygit", command: "lazygit" })).index;
}

// A tab showing one window: the attach name is that window's id target, which
// the attach bridge connects to pinned. Nothing is created — the engine pins
// a viewer to a window directly.
export async function createWindowTab(session: string, index: number): Promise<string> {
  const s = await findSession(session);
  const w = s.windows.find((x) => x.index === index);
  if (!w) throw new WindowGoneError(`window ${index} of ${session} is gone`);
  return `@${w.id}`;
}

export function isWindowTabName(name: string): boolean {
  return name.startsWith("@");
}

// Nothing to clean up: a pinned attach ends when its viewer disconnects.
export async function killWindowTab(_attachName: string): Promise<void> {}

export async function renameWindow(session: string, index: number, newName: string): Promise<void> {
  await mux().renameWindow(`${session}:${index}`, newName);
}

// Hands the window's name back to what's running in it.
export async function resetWindowName(session: string, index: number): Promise<void> {
  await mux().resetWindowName(`${session}:${index}`);
}

// Types `text` into a session's window, optionally submitting it. Submit is a
// separate write after a short settle rather than a trailing "\r" in the same
// one: Ink-based TUIs like Claude Code drop an Enter that arrives with the
// paste. Without windowIndex, the session's current window.
const SEND_TEXT_SETTLE_MS = 150;

export async function sendTextToSession(
  session: string,
  text: string,
  submit: boolean,
  windowIndex?: number,
): Promise<void> {
  if (!session) throw new Error("session is required");
  const target = windowIndex !== undefined ? `${session}:${windowIndex}` : session;
  await mux().sendText(target, text);
  if (submit) {
    await new Promise((resolve) => setTimeout(resolve, SEND_TEXT_SETTLE_MS));
    await mux().sendText(target, "\r");
  }
}

// A window's screen as plain text: its visible rows plus `scrollback` history
// lines above them. Rejects when the window is gone or the running engine
// cannot read screens.
export async function captureWindow(windowId: string, scrollback = 0): Promise<string> {
  const engine = mux();
  if (!engine.capture) throw new Error("the terminal backend cannot read window screens");
  return engine.capture(`@${windowId}`, Math.max(0, Math.floor(scrollback)));
}

export async function sendTextToWindow(windowId: string, text: string, submit: boolean): Promise<void> {
  await mux().sendText(`@${windowId}`, text);
  if (submit) {
    await new Promise((resolve) => setTimeout(resolve, SEND_TEXT_SETTLE_MS));
    await mux().sendText(`@${windowId}`, "\r");
  }
}

// What a tab's attach target names: a session name means that session's
// current window; "@<windowId>" (a window tab, see isWindowTabName) means
// exactly that window, whatever the session's own current-window pointer says.
// Routes the client addresses by a tab's attach name resolve it through here.
// `fresh` skips the short-lived listing cache, for callers that act on what is
// running in the window right now (the editor deciding whether nvim is open).
export async function resolveAttachTarget(
  target: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<{ session: MuxSession; window: MuxWindow }> {
  if (fresh) invalidateSessionsCache();
  if (isWindowTabName(target)) {
    const id = target.slice(1);
    for (const sessions of [await rawSessions(), await freshSessions()]) {
      for (const s of sessions) {
        const w = s.windows.find((x) => x.id === id);
        if (w) return { session: s, window: w };
      }
    }
    throw new Error(`can't find window: ${target}`);
  }
  const s = await findSession(target);
  const w = s.windows.find((x) => x.current) ?? s.windows[0];
  if (!w) throw new Error(`can't find session: ${target}`);
  return { session: s, window: w };
}

// The target window's live cwd — what relative terminal paths resolve against.
export async function paneCurrentPath(target: string): Promise<string> {
  const { session, window } = await resolveAttachTarget(target);
  return window.cwd ?? session.rootCwd;
}

// One entry per window. Windows are single terminals, so a "pane" and a
// window are the same thing; the shape is kept for the command-history and
// open-file callers built around panes. `id` is the window id.
export interface SessionPane {
  windowIndex: number;
  paneIndex: number;
  paneActive: boolean;
  active: boolean;
  id: string;
  command: string;
  pid: number;
  title: string;
}

export async function listSessionPanes(session: string): Promise<SessionPane[]> {
  const s = await findSession(session);
  return s.windows.map((w) => ({
    windowIndex: w.index,
    paneIndex: 0,
    paneActive: true,
    active: w.current,
    id: w.id,
    command: w.command,
    pid: w.pid,
    title: w.name,
  }));
}

export interface WindowLocation {
  session: string;
  window: MuxWindow;
}

export async function findWindow(windowId: string): Promise<WindowLocation | null> {
  for (const sessions of [await rawSessions(), await freshSessions()]) {
    for (const s of sessions) {
      const w = s.windows.find((x) => x.id === windowId);
      if (w) return { session: s.name, window: w };
    }
  }
  return null;
}

export interface WindowPidMaps {
  // A window's shell pid → owning session, for walking a port owner's ppid chain.
  byPid: Map<number, string>;
  // Window id → owning session, for the PERCH_WINDOW environ fallback.
  byWindowId: Map<string, string>;
}

export async function listAllWindowPids(): Promise<WindowPidMaps> {
  const byPid = new Map<number, string>();
  const byWindowId = new Map<string, string>();
  for (const s of await rawSessions()) {
    for (const w of s.windows) {
      if (w.pid > 1) byPid.set(w.pid, s.name);
      byWindowId.set(w.id, s.name);
    }
  }
  return { byPid, byWindowId };
}

// A window-id target's session and index, for callers that still speak
// session:index (push notifications, the client's tab model).
export async function windowAddress(windowId: string): Promise<{ session: string; index: number } | null> {
  const found = await findWindow(windowId);
  return found ? { session: found.session, index: found.window.index } : null;
}

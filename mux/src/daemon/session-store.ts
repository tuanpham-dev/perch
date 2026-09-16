import { randomUUID } from 'node:crypto';

export class StoreError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'StoreError';
  }
}

/** The store is generic so its ordering/naming logic tests without spawning PTYs. */
export interface WindowLike {
  readonly id: string;
  name: string;
  autoName?: boolean;
  /** The live name, when it can differ from `name` (automatic naming). */
  displayName?(): string;
}

export type Session<W extends WindowLike> = {
  /** Stable for the session's life and across restores; names change on rename. */
  id: string;
  name: string;
  windows: W[];
  currentIndex: number;
  createdAt: number;
  /**
   * Where the session was started — fixed for its lifetime.
   *
   * Distinct from the cwd a client sees in session.list, which is the current
   * window's live directory and moves with every cd. Something has to stay
   * still for a session to be identified with a project at all.
   */
  rootCwd: string;
};

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

function checkSessionName(name: string): void {
  if (!NAME_RE.test(name)) throw new StoreError('BAD_NAME', `session name ${JSON.stringify(name)} may only contain letters, digits, . _ -`);
}

// Window names are labels people choose ("dev [web]"), so almost anything
// goes. What can't: a colon or a leading "@" (they would read as a target),
// control characters, and all digits (it would shadow index targets like
// "sess:2").
export const WINDOW_NAME_RE = /^(?!@)[^\x00-\x1f\x7f:]{1,64}$/;

function checkWindowName(name: string): void {
  if (!WINDOW_NAME_RE.test(name)) throw new StoreError('BAD_NAME', `window name ${JSON.stringify(name)} can't contain ":" or control characters, start with "@", or be longer than 64 characters`);
  if (/^\d+$/.test(name)) throw new StoreError('BAD_NAME', `window name ${JSON.stringify(name)} is all digits, which would shadow index targets like "sess:2"`);
}

export type Target<W extends WindowLike> = { session: Session<W>; index: number; window: W };

/** Longer than this and the name stops fitting the places it has to appear —
 *  a sidebar row, a tab, `session:window` targets typed by hand. */
const MAX_DERIVED_NAME = 32;

/**
 * A session name from the folder it runs in: /works/perch -> "perch".
 *
 * With several agents running, "session-1, session-2, session-3" tells you
 * nothing about which is which — in the sidebar, the tab bar, the switcher, or
 * a `perch send` target. The folder is what you actually call the work.
 *
 * Returns null when the path yields nothing usable, leaving the caller on its
 * session-N fallback rather than inventing something worse.
 */
export function sessionNameFromCwd(cwd: string | undefined): string | null {
  if (!cwd) return null;
  // Not path.basename: a trailing slash, a bare "/", and "." all need to fall
  // through to the fallback rather than produce "" or ".".
  const segment = cwd.split('/').filter((s) => s && s !== '.' && s !== '..').pop();
  if (!segment) return null;
  const cleaned = segment
    // Anything outside the allowed set becomes a dash, so a folder named
    // "my project (v2)" is still recognisable rather than rejected.
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_DERIVED_NAME);
  return cleaned === '' ? null : cleaned;
}

/** `name`, or the first free `name-2`, `name-3`… */
export function dedupeName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  // Starts at 2: the first duplicate of "perch" is "perch-2", which reads as
  // the second one rather than implying a "perch-1" that doesn't exist.
  for (let n = 2; ; n++) {
    const candidate = `${name}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

export class SessionStore<W extends WindowLike> {
  sessions = new Map<string, Session<W>>();

  /** The name a new session WILL get — resolved before the first window spawns,
   *  so the window's PERCH_SESSION env var can carry it. Dispatch is
   *  single-threaded, so resolve-then-create in one handler cannot race. */
  resolveNewSessionName(name: string | undefined, cwd?: string): string {
    if (name !== undefined) {
      // An explicitly requested name is never silently renamed — a caller that
      // asked for "build" and got "build-2" would go on to address the wrong
      // session.
      checkSessionName(name);
      if (this.sessions.has(name)) throw new StoreError('SESSION_EXISTS', `session ${JSON.stringify(name)} already exists`);
      return name;
    }
    const fromCwd = sessionNameFromCwd(cwd);
    if (fromCwd) return dedupeName(fromCwd, (c) => this.sessions.has(c));
    // No usable folder name — a session started at "/" or with no cwd at all.
    let n = 1;
    while (this.sessions.has(`session-${n}`)) n++;
    return `session-${n}`;
  }

  createSession(name: string | undefined, firstWindow: W, rootCwd: string): Session<W> {
    const finalName = this.resolveNewSessionName(name);
    const session: Session<W> = {
      id: randomUUID(), name: finalName, windows: [firstWindow], currentIndex: 0, createdAt: Date.now(), rootCwd,
    };
    this.sessions.set(finalName, session);
    return session;
  }

  getSession(name: string): Session<W> {
    const s = this.sessions.get(name);
    if (!s) throw new StoreError('NO_SESSION', `no session named ${JSON.stringify(name)}`);
    return s;
  }

  /** With no name: the sole session if exactly one exists, else an error. */
  defaultSession(name?: string): Session<W> {
    if (name !== undefined) return this.getSession(name);
    if (this.sessions.size === 1) return this.sessions.values().next().value as Session<W>;
    if (this.sessions.size === 0) throw new StoreError('NO_SESSION', 'no sessions exist');
    throw new StoreError('AMBIGUOUS_SESSION', `${this.sessions.size} sessions exist; pick one with -t`);
  }

  removeSession(name: string): Session<W> {
    const s = this.getSession(name);
    this.sessions.delete(name);
    return s;
  }

  renameSession(from: string, to: string): Session<W> {
    checkSessionName(to);
    const s = this.getSession(from);
    if (this.sessions.has(to)) throw new StoreError('SESSION_EXISTS', `session ${JSON.stringify(to)} already exists`);
    this.sessions.delete(from);
    s.name = to;
    this.sessions.set(to, s);
    return s;
  }

  addWindow(session: Session<W>, w: W, makeCurrent = true): number {
    if (w.name) checkWindowName(w.name);
    session.windows.push(w);
    const index = session.windows.length - 1;
    if (makeCurrent) session.currentIndex = index;
    return index;
  }

  /** Parses "@<window-id>", "sess", "sess:2", or "sess:name". Bare "sess" means its current window. */
  resolveTarget(spec: string): Target<W> {
    // "@" can't appear in a session name, so an id target is never ambiguous.
    // Ids are what the app holds: they survive renames, renumbering and restore.
    if (spec.startsWith('@')) {
      const found = this.findWindowById(spec.slice(1));
      if (!found) throw new StoreError('NO_WINDOW', `no window with id ${JSON.stringify(spec.slice(1))}`);
      return found;
    }
    const colon = spec.indexOf(':');
    const sessionName = colon === -1 ? spec : spec.slice(0, colon);
    const session = this.getSession(sessionName);
    let index: number;
    if (colon === -1) {
      index = session.currentIndex;
    } else {
      const part = spec.slice(colon + 1);
      if (/^\d+$/.test(part)) {
        index = Number(part);
        if (index >= session.windows.length) {
          throw new StoreError('NO_WINDOW', `session ${JSON.stringify(sessionName)} has no window ${index} (it has ${session.windows.length})`);
        }
      } else {
        index = session.windows.findIndex((w) => (w.displayName?.() ?? w.name) === part);
        if (index === -1) index = session.windows.findIndex((w) => w.name === part);
        if (index === -1) throw new StoreError('NO_WINDOW', `session ${JSON.stringify(sessionName)} has no window named ${JSON.stringify(part)}`);
      }
    }
    return { session, index, window: session.windows[index] as W };
  }

  currentWindow(session: Session<W>): W {
    return session.windows[session.currentIndex] as W;
  }

  selectWindow(spec: string): { session: Session<W>; changed: boolean } {
    const { session, index } = this.resolveTarget(spec);
    const changed = session.currentIndex !== index;
    session.currentIndex = index;
    return { session, changed };
  }

  rotateWindow(session: Session<W>, step: 1 | -1): boolean {
    if (session.windows.length < 2) return false;
    session.currentIndex = (session.currentIndex + step + session.windows.length) % session.windows.length;
    return true;
  }

  renameWindow(spec: string, to: string): Target<W> {
    checkWindowName(to);
    const t = this.resolveTarget(spec);
    t.window.name = to;
    t.window.autoName = false;
    return t;
  }

  /** Hands the name back to the foreground command. */
  resetWindowName(spec: string): Target<W> {
    const t = this.resolveTarget(spec);
    t.window.autoName = true;
    return t;
  }

  /** Removes the window at the target; positional indices shift down past it. */
  removeWindow(spec: string): Target<W> & { wasCurrent: boolean; sessionEmpty: boolean } {
    const t = this.resolveTarget(spec);
    return { ...t, ...this.removeWindowAt(t.session, t.index) };
  }

  removeWindowAt(session: Session<W>, index: number): { wasCurrent: boolean; sessionEmpty: boolean } {
    const wasCurrent = index === session.currentIndex;
    session.windows.splice(index, 1);
    if (index < session.currentIndex) session.currentIndex--;
    if (session.currentIndex >= session.windows.length) session.currentIndex = Math.max(0, session.windows.length - 1);
    return { wasCurrent, sessionEmpty: session.windows.length === 0 };
  }

  /** Locates a window by its stable id, e.g. when its PTY exits. */
  findWindowById(id: string): { session: Session<W>; index: number; window: W } | null {
    for (const session of this.sessions.values()) {
      const index = session.windows.findIndex((w) => w.id === id);
      if (index !== -1) return { session, index, window: session.windows[index] as W };
    }
    return null;
  }
}

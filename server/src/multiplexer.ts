// What the rest of the server may ask of a terminal engine. Sessions hold
// windows; a window is one terminal. Nothing outside the engine module knows
// how an engine does any of this. The bundled daemon (mux.ts) is built in;
// extensions can register others (the tmux backend), and the user picks one
// in Settings -> Terminal, taking effect when the server restarts.
//
// Targets are strings, the same three forms everywhere:
//   "work"       the session's current window
//   "work:2"     the session's window at index 2
//   "@<uuid>"    one window by its id, wherever it lives

import { daemonMultiplexer } from "./mux.js";

export interface MuxWindow {
  // Stable for the window's life and across a daemon restart.
  id: string;
  index: number;
  // The live name: the foreground command while `autoName` is on.
  name: string;
  autoName: boolean;
  current: boolean;
  // Live working directory (absolute).
  cwd: string;
  // What is running in the foreground right now ("zsh", "vim", "claude").
  command: string;
  // The command the window was created to run, re-typed on restore; "" for a
  // plain shell.
  declaredCommand: string;
  // Process names under the window's shell, breadth-first.
  commands: string[];
  // The shell's pid, for walking what it owns.
  pid: number;
  // Output arrived while nobody was viewing it.
  activity: boolean;
  lastOutputAt: number;
  // On a window brought back by a restore: what was running under its shell
  // before (["claude"]), until clearRestored is called for it.
  restoredCommands: string[] | null;
}

export interface MuxSession {
  id: string;
  name: string;
  // Epoch ms.
  createdAt: number;
  // Connected viewers.
  attached: number;
  // Where the session was started. Never moves.
  rootCwd: string;
  currentIndex: number;
  windows: MuxWindow[];
}

export interface CreateWindowOptions {
  cwd?: string;
  name?: string;
  // Typed into the new shell, so the window outlives the command.
  command?: string;
  // Don't make it the session's current window.
  background?: boolean;
}

export interface TerminalEngineSettings {
  // "" for the account's own shell.
  shell: string;
  saveScrollback: boolean;
  restoreOnStart: boolean;
}

export type MuxEvent =
  | { event: "bell"; session: string; windowId: string }
  | { event: "sessions-changed" };

// Everything a viewer can hear back while attached.
export interface AttachHandlers {
  output(data: Buffer): void;
  // History replay is done; input sent before this reaches a shell that
  // never asked for it.
  replayed(): void;
  // A session attach followed its session to another window.
  windowSwitched(index: number): void;
  resized(cols: number, rows: number): void;
  // The window or session ended, or the engine went away.
  closed(reason: string): void;
}

// A viewer's theme colors, so the backend can answer color queries on its
// behalf. `#rrggbb` only; anything else is dropped before it gets here.
export interface ViewerColors {
  foreground?: string;
  background?: string;
}

export interface AttachHandle {
  write(data: Buffer | string): void;
  resize(cols: number, rows: number): void;
  // This viewer became the one the user is looking at.
  activate(): void;
  close(): void;
}

export interface Multiplexer {
  listSessions(): Promise<MuxSession[]>;
  createSession(opts: { name?: string; cwd: string; command?: string }): Promise<{ id: string; name: string; windowId: string }>;
  killSession(session: string): Promise<void>;
  renameSession(session: string, to: string): Promise<void>;
  createWindow(session: string, opts?: CreateWindowOptions): Promise<{ index: number; windowId: string }>;
  selectWindow(target: string): Promise<void>;
  killWindow(target: string): Promise<void>;
  renameWindow(target: string, to: string): Promise<void>;
  resetWindowName(target: string): Promise<void>;
  // Marks a restored window's restoredCommands as dealt with.
  clearRestored(target: string): Promise<void>;
  // Raw bytes into the window's terminal, exactly as if typed.
  sendText(target: string, data: string): Promise<void>;
  // Plain text of the window's visible rows plus its last `scrollback`
  // history lines, one line per row, trailing blank rows dropped. Optional so
  // an engine registered before this existed still loads; callers treat a
  // missing capture as "this backend cannot read screens".
  capture?(target: string, scrollback?: number): Promise<string>;
  // `pinned` attaches to exactly that window; otherwise to the target's
  // session, following its current window.
  attach(
    target: string,
    opts: { pinned: boolean; cols: number; rows: number; colors?: ViewerColors },
    handlers: AttachHandlers,
  ): Promise<AttachHandle>;
  // Daemon-wide events. Returns an unsubscribe.
  onEvent(listener: (event: MuxEvent) => void): () => void;
  // Whether the engine is up right now (it is started on demand otherwise).
  running(): Promise<boolean>;
  // Applies the user's terminal settings to the engine.
  configure(settings: TerminalEngineSettings): Promise<void>;
}

// ---- Choosing an engine -------------------------------------------------

export const DAEMON_ENGINE_ID = "daemon";

// What a registered engine is handed when it is first used: what every
// terminal it starts needs in order to reach this server.
export interface EngineContext {
  port: number;
  // The environment new terminals start with: this server's, minus its own
  // configuration and its launcher's terminal, plus the browser opener and
  // this server's port.
  env: Record<string, string>;
}

export interface EngineRegistration {
  id: string;
  label: string;
  // One or two sentences shown under the picker in Settings -> Terminal when
  // this engine is chosen: what it is and what the user should expect.
  description?: string;
  create(ctx: EngineContext): Multiplexer;
}

const DAEMON_DESCRIPTION =
  "Terminals run in a background process that comes with the app. They keep running when the server restarts and come back after a reboot. Its settings are below.";

const registered = new Map<
  string,
  { label: string; description: string; create: (ctx: EngineContext) => Multiplexer; instance: Multiplexer | null }
>();
let selectedId = DAEMON_ENGINE_ID;
let context: EngineContext = { port: 0, env: {} };
let active: Multiplexer = daemonMultiplexer;
let activeId = DAEMON_ENGINE_ID;

// Until the chosen engine is known to be there or not, calls wait: an engine
// from an extension registers only once extension hooks load, and anything
// that reached the daemon first would start one for nothing.
let settle: () => void = () => {};
let ready: Promise<void> = Promise.resolve();

// Called once at startup with the saved choice, before extensions load.
export function selectEngine(id: string, ctx: EngineContext): void {
  selectedId = id || DAEMON_ENGINE_ID;
  context = ctx;
  if (selectedId !== DAEMON_ENGINE_ID && !registered.has(selectedId)) {
    ready = new Promise((resolve) => (settle = resolve));
  }
  refreshActive();
}

// Extension hooks have loaded: a chosen engine that still isn't registered
// isn't coming, so the daemon answers from here on.
export function enginesSettled(): void {
  if (selectedId !== DAEMON_ENGINE_ID && !registered.has(selectedId)) {
    console.error(`terminal engine "${selectedId}" is not available (is its extension enabled?), using the bundled daemon`);
  }
  settle();
}

export function whenEngineReady(): Promise<void> {
  return ready;
}

export function activeEngineId(): string {
  return activeId;
}

export function registerEngine(reg: EngineRegistration): () => void {
  if (reg.id === DAEMON_ENGINE_ID) throw new Error(`engine id "${reg.id}" is reserved`);
  registered.set(reg.id, { label: reg.label, description: reg.description ?? "", create: reg.create, instance: null });
  refreshActive();
  return () => {
    if (registered.get(reg.id)?.create !== reg.create) return;
    registered.delete(reg.id);
    refreshActive();
  };
}

export function listEngines(): { id: string; label: string; description: string; selected: boolean; active: boolean }[] {
  return [
    { id: DAEMON_ENGINE_ID, label: "Bundled terminal daemon", description: DAEMON_DESCRIPTION },
    ...[...registered].map(([id, r]) => ({ id, label: r.label, description: r.description })),
  ].map((e) => ({ ...e, selected: e.id === selectedId, active: e.id === activeId }));
}

function refreshActive(): void {
  let nextId = DAEMON_ENGINE_ID;
  let next: Multiplexer = daemonMultiplexer;
  const entry = selectedId === DAEMON_ENGINE_ID ? undefined : registered.get(selectedId);
  if (entry) {
    try {
      entry.instance ??= entry.create(context);
      next = entry.instance;
      nextId = selectedId;
    } catch (err) {
      console.error(`terminal engine "${selectedId}" failed to start, using the bundled daemon:`, err);
    }
  }
  if (nextId === selectedId) settle();
  if (next === active) return;
  active = next;
  activeId = nextId;
  console.log(`terminal engine: ${activeId}`);
  resubscribe();
}

// Event listeners outlive a switch: they move to the new engine, and hear a
// sessions-changed because the whole listing just changed under them.
const eventListeners = new Set<(event: MuxEvent) => void>();
let unsubscribeActive: (() => void) | null = null;

function resubscribe(): void {
  unsubscribeActive?.();
  unsubscribeActive = null;
  if (eventListeners.size === 0) return;
  unsubscribeActive = active.onEvent((event) => {
    for (const l of eventListeners) l(event);
  });
  for (const l of eventListeners) l({ event: "sessions-changed" });
}

// Callers keep this object; every call goes to whichever engine is active.
const engine: Multiplexer = {
  listSessions: () => ready.then(() => active.listSessions()),
  createSession: (opts) => ready.then(() => active.createSession(opts)),
  killSession: (session) => ready.then(() => active.killSession(session)),
  renameSession: (session, to) => ready.then(() => active.renameSession(session, to)),
  createWindow: (session, opts) => ready.then(() => active.createWindow(session, opts)),
  selectWindow: (target) => ready.then(() => active.selectWindow(target)),
  killWindow: (target) => ready.then(() => active.killWindow(target)),
  renameWindow: (target, to) => ready.then(() => active.renameWindow(target, to)),
  resetWindowName: (target) => ready.then(() => active.resetWindowName(target)),
  clearRestored: (target) => ready.then(() => active.clearRestored(target)),
  sendText: (target, data) => ready.then(() => active.sendText(target, data)),
  capture: (target, scrollback) =>
    ready.then(() => {
      if (!active.capture) throw new Error("the terminal backend cannot read window screens");
      return active.capture(target, scrollback);
    }),
  attach: (target, opts, handlers) => ready.then(() => active.attach(target, opts, handlers)),
  onEvent: (listener) => {
    eventListeners.add(listener);
    if (eventListeners.size === 1) {
      void ready.then(() => {
        if (unsubscribeActive || eventListeners.size === 0) return;
        unsubscribeActive = active.onEvent((event) => {
          for (const l of eventListeners) l(event);
        });
      });
    }
    return () => {
      eventListeners.delete(listener);
      if (eventListeners.size === 0) {
        unsubscribeActive?.();
        unsubscribeActive = null;
      }
    };
  },
  running: () => ready.then(() => active.running()),
  configure: (settings) => ready.then(() => active.configure(settings)),
};

export function getMultiplexer(): Multiplexer {
  return engine;
}

// The bundled terminal daemon (mux/) as a Multiplexer. This is the only file
// in the server that speaks the daemon's protocol; everything else goes
// through multiplexer.ts.
//
// Each call is one short request on its own connection, and a daemon that
// isn't running is started on the way. Reads degrade to empty when the daemon
// can't be reached, so a listing endpoint answers [] rather than 500ing
// before anything has started. Writes surface the error.
import { connectOrSpawn, tryConnect, type ClientConn } from "perch-mux/client";
import { setConfigKey, unsetConfigKey } from "perch-mux/config";
import type { SessionInfo, WindowInfo } from "perch-mux/protocol";
import type { AttachHandle, AttachHandlers, Multiplexer, MuxEvent, MuxSession, MuxWindow, ViewerColors } from "./multiplexer.js";
import { openShimPath, shimBinDir } from "./openUrl.js";
import { spawnEnv } from "./spawnEnv.js";

let serverPort = Number(process.env.PORT ?? 3001);

// The environment a daemon starts with, and so every shell it spawns: this
// server's environment minus its own config (spawnEnv), plus what panes need
// to reach this server — the browser-opener shim and the port `perch
// open` uses to find the instance that owns the terminal.
function daemonEnv(): NodeJS.ProcessEnv {
  return { ...spawnEnv(), ...terminalEnv(serverPort) };
}

// What any engine's new terminals get so they can reach this server: the
// browser opener, the port, and the shim folder first on PATH so the
// clipboard and xdg-open shims stand in for tools a headless host lacks.
export function terminalEnv(port: number): Record<string, string> {
  const env: Record<string, string> = { BROWSER: openShimPath, PERCH_PORT: String(port) };
  if (process.platform !== "win32") env.PATH = withShimsFirst(process.env.PATH);
  return env;
}

export function withShimsFirst(pathVar: string | undefined, dir: string = shimBinDir): string {
  const rest = (pathVar ?? "").split(":").filter((entry) => entry && entry !== dir);
  return [dir, ...rest].join(":");
}

function connect(): Promise<ClientConn> {
  return connectOrSpawn([], daemonEnv());
}

async function request<T>(req: Parameters<ClientConn["request"]>[0]): Promise<T> {
  const conn = await connect();
  try {
    return (await conn.request(req)) as T;
  } finally {
    conn.close();
  }
}

function toWindow(w: WindowInfo): MuxWindow {
  return {
    id: w.windowId,
    index: w.index,
    name: w.name,
    autoName: w.autoName,
    current: w.current,
    cwd: w.cwd,
    command: w.foregroundCommand ?? "",
    declaredCommand: w.command ?? "",
    commands: w.commands,
    pid: w.pid,
    activity: w.activity,
    lastOutputAt: w.lastOutputAt,
    restoredCommands: w.restoredCommands ?? null,
  };
}

async function listSessions(): Promise<MuxSession[]> {
  let conn: ClientConn;
  try {
    conn = await connect();
  } catch {
    return [];
  }
  try {
    const sessions = (await conn.request({ kind: "session.list" })) as SessionInfo[];
    // One connection for the whole listing: a window.list per session.
    // A session killed between the two requests is simply left out.
    const listed = await Promise.all(
      sessions.map(async (s): Promise<MuxSession | null> => {
        try {
          const windows = (await conn.request({ kind: "window.list", session: s.name })) as WindowInfo[];
          return {
            id: s.id,
            name: s.name,
            createdAt: s.createdAt,
            attached: s.attached,
            rootCwd: s.rootCwd,
            currentIndex: s.currentIndex,
            windows: windows.map(toWindow),
          };
        } catch {
          return null;
        }
      }),
    );
    return listed.filter((s): s is MuxSession => s !== null);
  } catch {
    return [];
  } finally {
    conn.close();
  }
}

async function attach(
  target: string,
  opts: { pinned: boolean; cols: number; rows: number; colors?: ViewerColors },
  handlers: AttachHandlers,
): Promise<AttachHandle> {
  const conn = await connect();
  let closed = false;
  const close = (reason: string) => {
    if (closed) return;
    closed = true;
    handlers.closed(reason);
  };
  conn.onOutput = (data) => handlers.output(data);
  conn.onEvent = (event) => {
    if (event.event === "replayed") handlers.replayed();
    else if (event.event === "window-switch") handlers.windowSwitched(event.index);
    else if (event.event === "resize") handlers.resized(event.cols, event.rows);
    else if (event.event === "window-closed" || event.event === "session-closed") close(event.event);
  };
  conn.onClose = () => close("daemon-closed");
  try {
    if (opts.pinned) {
      await conn.request({ kind: "window.attach", target, cols: opts.cols, rows: opts.rows, colors: opts.colors });
    } else {
      // A session attach names the session; "@id" and "sess:2" forms resolve
      // to their session through a listing.
      const session = target.startsWith("@") || target.includes(":") ? await sessionOf(target) : target;
      await conn.request({ kind: "session.attach", session, cols: opts.cols, rows: opts.rows, colors: opts.colors });
    }
  } catch (err) {
    closed = true;
    conn.destroy();
    throw err;
  }
  return {
    write: (data) => conn.sendInput(typeof data === "string" ? Buffer.from(data, "utf8") : data),
    resize: (cols, rows) => void conn.request({ kind: "resize", cols, rows }).catch(() => {}),
    activate: () => void conn.request({ kind: "activate" }).catch(() => {}),
    close: () => {
      closed = true;
      conn.close();
    },
  };
}

async function sessionOf(target: string): Promise<string> {
  if (!target.startsWith("@")) return target.slice(0, target.indexOf(":"));
  const id = target.slice(1);
  const found = (await listSessions()).find((s) => s.windows.some((w) => w.id === id));
  if (!found) throw new Error(`no window with id ${JSON.stringify(id)}`);
  return found.name;
}

// ---- Daemon-wide events -------------------------------------------------

const listeners = new Set<(event: MuxEvent) => void>();
let eventConn: ClientConn | null = null;
let eventRetry: NodeJS.Timeout | null = null;
const EVENT_RETRY_MS = 2_000;

// One long-lived listening connection, held only while somebody is
// subscribed, and re-established when the daemon restarts.
function ensureEventConn(): void {
  if (eventConn || eventRetry || listeners.size === 0) return;
  connect()
    .then(async (conn) => {
      conn.onEvent = (event) => {
        if (event.event === "bell" || event.event === "sessions-changed") {
          for (const l of listeners) l(event);
        }
      };
      conn.onClose = () => {
        eventConn = null;
        scheduleEventRetry();
        // A new daemon may have started with different sessions.
        for (const l of listeners) l({ event: "sessions-changed" });
      };
      await conn.request({ kind: "events.subscribe" });
      eventConn = conn;
    })
    .catch(() => scheduleEventRetry());
}

function scheduleEventRetry(): void {
  if (eventRetry || listeners.size === 0) return;
  eventRetry = setTimeout(() => {
    eventRetry = null;
    ensureEventConn();
  }, EVENT_RETRY_MS);
  eventRetry.unref?.();
}

export const daemonMultiplexer: Multiplexer = {
  listSessions,
  createSession: (opts) => request({ kind: "session.new", name: opts.name, cwd: opts.cwd, command: opts.command }),
  killSession: async (session) => {
    await request({ kind: "session.kill", session });
  },
  renameSession: async (session, to) => {
    await request({ kind: "session.rename", session, to });
  },
  createWindow: (session, opts = {}) =>
    request({ kind: "window.new", session, name: opts.name, cwd: opts.cwd, command: opts.command, background: opts.background }),
  selectWindow: async (target) => {
    await request({ kind: "window.select", target });
  },
  killWindow: async (target) => {
    await request({ kind: "window.kill", target });
  },
  renameWindow: async (target, to) => {
    await request({ kind: "window.rename", target, to });
  },
  resetWindowName: async (target) => {
    await request({ kind: "window.resetName", target });
  },
  clearRestored: async (target) => {
    await request({ kind: "window.clearRestored", target });
  },
  sendText: async (target, data) => {
    await request({ kind: "io.send", target, data });
  },
  capture: async (target, scrollback = 0) => {
    const reply = await request<{ text: string }>({ kind: "io.capture", target, scrollback });
    return reply.text;
  },
  attach,
  onEvent: (listener) => {
    listeners.add(listener);
    ensureEventConn();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        eventConn?.close();
        eventConn = null;
      }
    };
  },
  // Written to the daemon's own config file (the restore choice has to be
  // there before any server connects, since restore happens as the daemon
  // starts), then reloaded into a running daemon.
  configure: async (settings) => {
    if (settings.shell.trim()) setConfigKey("shell", settings.shell.trim());
    else unsetConfigKey("shell");
    setConfigKey("persistScrollback", String(settings.saveScrollback));
    setConfigKey("restore", String(settings.restoreOnStart));
    const conn = await tryConnect();
    if (!conn) return;
    try {
      await conn.request({ kind: "daemon.reloadConfig" });
    } finally {
      conn.close();
    }
  },
  // Never starts one: this is the question "is it up?", not a request.
  running: async () => {
    const conn = await tryConnect();
    conn?.close();
    return conn !== null;
  },
};

// ---- Announcing this server ---------------------------------------------

const REANNOUNCE_MS = 30_000;

// Tells the daemon which server its shells report to, and keeps saying it.
// The daemon remembers one server; announcing only at startup would let the
// last server to start keep that slot after it exits, so a live server
// reclaims it within half a minute of another one going away.
// `inUse` says whether the daemon is the engine in use; while another engine
// is, announcing would start a daemon nobody needs.
export function startDaemonLink(port: number, inUse: () => Promise<boolean>): () => void {
  serverPort = port;
  const announce = () =>
    void inUse()
      .then((yes) => (yes ? request({ kind: "notify.configure", url: `http://127.0.0.1:${port}` }) : undefined))
      .catch(() => {});
  announce();
  const timer = setInterval(announce, REANNOUNCE_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

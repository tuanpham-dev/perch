import type { IncomingMessage } from "node:http";
import { release } from "node:os";
import { WebSocket } from "ws";
import { toClientPath } from "./clientPaths.js";
import { subscribeCommandEvents } from "./commandEvents.js";
import { scrollHorizontal } from "./editor.js";
import { getMultiplexer, type AttachHandle } from "./multiplexer.js";
import { findWindow, isWindowTabName, listSessions } from "./terminals.js";

// Bridges one browser WebSocket to one attach on the terminal engine. The
// `session` query parameter is either a session name (the viewer follows the
// session's current window) or a window tab's "@<window-id>" (pinned to that
// window). Terminal bytes travel as binary frames; control as JSON text.
// Closing the socket only detaches: the terminal keeps running.

interface ClientMsg {
  type: "input" | "resize" | "activate" | "hscroll" | "ping";
  data?: string;
  cols?: number;
  rows?: number;
  amount?: number;
}

// A client that vanishes without a TCP FIN (phone sleep, network drop, NAT
// idle timeout) never fires "close" on its own. Protocol-level pings (browsers
// answer automatically) detect the dead path; terminate() then fires "close",
// which detaches.
const PEER_PING_MS = 30_000;

// How often a viewer is told what's running in its window, so a tab can show
// "vim" or react to an agent starting.
const COMMAND_POLL_MS = 1_000;

export function handleAttach(ws: WebSocket, req: IncomingMessage): void {
  const url = new URL(req.url ?? "", "http://localhost");
  const target = url.searchParams.get("session");
  if (!target) {
    ws.close(4000, "missing session parameter");
    return;
  }
  const parseDim = (v: string | null): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n <= 10_000 ? n : null;
  };
  const cols = parseDim(url.searchParams.get("cols")) ?? 80;
  const rows = parseDim(url.searchParams.get("rows")) ?? 24;
  // The viewer's theme colors, for the backend to answer color queries with.
  const parseColor = (v: string | null): string | undefined =>
    v && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined;
  const colors = { foreground: parseColor(url.searchParams.get("fg")), background: parseColor(url.searchParams.get("bg")) };
  const pinned = isWindowTabName(target);
  const windowId = pinned ? target.slice(1) : null;

  const send = (payload: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  // The terminals run on this machine. On Windows they're ConPTY
  // pseudo-terminals, which reflow and redraw differently, and the browser's
  // terminal needs to know that (and the Windows build) to match them.
  if (process.platform === "win32") {
    send({ type: "host", platform: "win32", windowsBuild: Number(release().split(".")[2]) || 0 });
  }

  let peerAlive = true;
  ws.on("pong", () => {
    peerAlive = true;
  });
  const peerPing = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!peerAlive) {
      ws.terminate();
      return;
    }
    peerAlive = false;
    ws.ping();
  }, PEER_PING_MS);

  let handle: AttachHandle | null = null;
  let ended = false;
  // Which session this viewer belongs to, for routing command events and
  // following window switches. Resolved after attach for a pinned window.
  let sessionName: string | null = pinned ? null : target;
  let lastCommand: string | null = null;
  let commandPoll: NodeJS.Timeout | null = null;

  const end = () => {
    if (ended) return;
    ended = true;
    clearInterval(peerPing);
    if (commandPoll) clearInterval(commandPoll);
    unsubscribeEvents();
    handle?.close();
    handle = null;
  };

  const unsubscribeEvents = subscribeCommandEvents((frame) => {
    if (sessionName !== null && frame.sessionKey === sessionName) {
      send({ type: "commandEvent", ...frame, cwd: toClientPath(frame.cwd) });
    }
  });

  const pollCommand = async () => {
    const sessions = await listSessions();
    let command: string | undefined;
    if (windowId) {
      for (const s of sessions) {
        const w = s.windows.find((x) => x.id === windowId);
        if (w) {
          sessionName = s.name;
          command = w.command;
        }
      }
    } else {
      command = sessions.find((s) => s.name === sessionName)?.windows.find((w) => w.active)?.command;
    }
    if (command !== undefined && command !== lastCommand) {
      lastCommand = command;
      send({ type: "command", command });
    }
  };

  // Messages that arrive while the attach is still being set up are held and
  // replayed once it exists, so a fast first keystroke or resize isn't lost.
  const early: ClientMsg[] = [];

  const handleMessage = (msg: ClientMsg) => {
    if (!handle) {
      early.push(msg);
      return;
    }
    if (msg.type === "input" && typeof msg.data === "string") {
      handle.write(msg.data);
    } else if (msg.type === "resize" && Number.isInteger(msg.cols) && Number.isInteger(msg.rows) && msg.cols! > 0 && msg.rows! > 0) {
      handle.resize(msg.cols!, msg.rows!);
    } else if (msg.type === "activate") {
      handle.activate();
    } else if (msg.type === "hscroll" && Number.isFinite(msg.amount)) {
      const where = windowId ? { windowId } : { session: target };
      void scrollHorizontal(where, msg.amount!).catch(() => {});
    }
  };

  ws.on("message", (raw) => {
    if (ended) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // App-level liveness probe from the client's half-open detection —
    // protocol pings aren't visible to browser JS.
    if (msg.type === "ping") {
      send({ type: "pong" });
      return;
    }
    handleMessage(msg);
  });

  ws.on("close", end);
  ws.on("error", end);

  getMultiplexer()
    .attach(target, { pinned, cols, rows, colors }, {
      output: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      replayed: () => send({ type: "replayed" }),
      windowSwitched: (index) => send({ type: "windowSwitched", windowIndex: index }),
      resized: (c, r) => send({ type: "resize", cols: c, rows: r }),
      closed: () => {
        send({ type: "exit" });
        end();
        if (ws.readyState === WebSocket.OPEN) ws.close();
      },
    })
    .then(async (h) => {
      if (ended) {
        h.close();
        return;
      }
      handle = h;
      if (windowId) sessionName = (await findWindow(windowId))?.session ?? null;
      for (const msg of early.splice(0)) handleMessage(msg);
      void pollCommand().catch(() => {});
      commandPoll = setInterval(() => void pollCommand().catch(() => {}), COMMAND_POLL_MS);
    })
    .catch(() => {
      send({ type: "exit" });
      end();
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });
}

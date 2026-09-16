import net from "node:net";
import { WebSocket } from "ws";
import { getTunnelablePorts } from "./ports.js";

// Frame format shared with cli/tunnel.mjs (kept in sync manually — the CLI
// must stay a single dependency-free file, so this codec can't be imported):
//   [type:1][channel:4 uint32 BE][payload...]
const FRAME_OPEN = 1; // client -> server, payload: uint16 BE remote port
const FRAME_OPEN_OK = 2; // server -> client
const FRAME_OPEN_FAIL = 3; // server -> client, payload: utf8 error code
const FRAME_DATA = 4; // both directions, payload: raw bytes
const FRAME_CLOSE = 5; // both directions, peer's TCP side ended
const FRAME_WINDOW = 6; // both directions, payload: uint32 BE bytes consumed
// client -> server, payload: utf8 JSON array of the remote ports the client
// currently has bound locally. Sent on connect and whenever --all's poll
// changes that set, so the app can say whether a port is reachable at
// localhost:<port>. Purely informational: nothing is authorized by it, and a
// client that never sends it (an older CLI) just reports no ports.
const FRAME_PORTS = 7;

// Per-channel flow-control credit. Caps memory per channel without one
// stalled channel blocking the others sharing the WebSocket.
const WINDOW_SIZE = 1024 * 1024;

interface Channel {
  socket: net.Socket;
  connected: boolean;
  sendCredit: number;
  unacked: number;
  drainScheduled: boolean;
}

function encodeFrame(type: number, channel: number, payload: Buffer): Buffer {
  const buf = Buffer.allocUnsafe(5 + payload.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(channel, 1);
  payload.copy(buf, 5);
  return buf;
}

function decodeFrame(
  buf: Buffer,
): { type: number; channel: number; payload: Buffer } | null {
  if (buf.length < 5) return null;
  return {
    type: buf.readUInt8(0),
    channel: buf.readUInt32BE(1),
    payload: buf.subarray(5),
  };
}

function encodeUint32(n: number): Buffer {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32BE(n, 0);
  return buf;
}

function errCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return err instanceof Error ? err.message : String(err);
}

// Every connected tunnel client and the ports it says it has bound. The
// server has no other way to know: channels only open when a local
// connection actually arrives, so they say nothing about what is merely
// listening. Module-level because /api/tunnel-status reads it from outside
// any one socket's closure.
const tunnels = new Map<WebSocket, Set<number>>();

export interface TunnelStatus {
  connected: boolean;
  // The union across every connected client.
  ports: number[];
}

export function tunnelStatus(): TunnelStatus {
  const ports = new Set<number>();
  for (const reported of tunnels.values()) for (const port of reported) ports.add(port);
  return { connected: tunnels.size > 0, ports: [...ports].sort((a, b) => a - b) };
}

export function handleTunnel(ws: WebSocket): void {
  const channels = new Map<number, Channel>();
  tunnels.set(ws, new Set());
  // Channel ids with a terminal-ownership check in flight — guards against a
  // duplicate FRAME_OPEN for the same id (channels.has(id) can't catch it,
  // since the channel isn't created until the check resolves).
  const pendingOpens = new Set<number>();

  const flushAck = (id: number, ch: Channel) => {
    if (ch.unacked > 0 && ws.readyState === WebSocket.OPEN) {
      ws.send(encodeFrame(FRAME_WINDOW, id, encodeUint32(ch.unacked)));
    }
    ch.unacked = 0;
  };

  const openChannel = async (id: number, payload: Buffer) => {
    if (channels.has(id) || pendingOpens.has(id) || payload.length < 2) return;
    const port = payload.readUInt16BE(0);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      ws.send(encodeFrame(FRAME_OPEN_FAIL, id, Buffer.from("invalid port", "utf8")));
      return;
    }

    pendingOpens.add(id);
    let allowed: Set<number>;
    try {
      allowed = await getTunnelablePorts();
    } finally {
      pendingOpens.delete(id);
    }
    if (!allowed.has(port)) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeFrame(FRAME_OPEN_FAIL, id, Buffer.from("port not allowed", "utf8")));
      }
      return;
    }
    // The socket may have connected via a race (client retried, or ws closed
    // mid-check) — re-check now that the async gap has closed.
    if (channels.has(id) || ws.readyState !== WebSocket.OPEN) return;

    const socket = net.connect(port, "127.0.0.1");
    const ch: Channel = { socket, connected: false, sendCredit: WINDOW_SIZE, unacked: 0, drainScheduled: false };
    channels.set(id, ch);

    socket.on("connect", () => {
      ch.connected = true;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeFrame(FRAME_OPEN_OK, id, Buffer.alloc(0)));
      }
    });

    socket.on("data", (chunk) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(encodeFrame(FRAME_DATA, id, chunk));
      ch.sendCredit -= chunk.length;
      if (ch.sendCredit <= 0) socket.pause();
    });

    socket.on("error", (err) => {
      if (!ch.connected && channels.has(id)) {
        channels.delete(id);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encodeFrame(FRAME_OPEN_FAIL, id, Buffer.from(errCode(err), "utf8")));
        }
      }
      // If already connected, "close" fires next and sends the CLOSE frame.
    });

    socket.on("close", () => {
      if (!channels.has(id)) return;
      channels.delete(id);
      if (ch.connected && ws.readyState === WebSocket.OPEN) {
        ws.send(encodeFrame(FRAME_CLOSE, id, Buffer.alloc(0)));
      }
    });
  };

  const dataToChannel = (id: number, payload: Buffer) => {
    const ch = channels.get(id);
    if (!ch) return;
    ch.unacked += payload.length;
    const ok = ch.socket.write(payload);
    if (ok) {
      flushAck(id, ch);
    } else if (!ch.drainScheduled) {
      ch.drainScheduled = true;
      ch.socket.once("drain", () => {
        ch.drainScheduled = false;
        flushAck(id, ch);
      });
    }
  };

  const closeChannel = (id: number) => {
    const ch = channels.get(id);
    if (!ch) return;
    channels.delete(id);
    ch.socket.end();
  };

  const grantWindow = (id: number, payload: Buffer) => {
    if (payload.length < 4) return;
    const ch = channels.get(id);
    if (!ch) return;
    ch.sendCredit += payload.readUInt32BE(0);
    if (ch.sendCredit > 0 && ch.socket.isPaused()) ch.socket.resume();
  };

  ws.on("message", (raw, isBinary) => {
    if (!isBinary || !Buffer.isBuffer(raw)) return;
    const frame = decodeFrame(raw);
    if (!frame) return;
    switch (frame.type) {
      case FRAME_OPEN:
        void openChannel(frame.channel, frame.payload);
        break;
      case FRAME_DATA:
        dataToChannel(frame.channel, frame.payload);
        break;
      case FRAME_CLOSE:
        closeChannel(frame.channel);
        break;
      case FRAME_WINDOW:
        grantWindow(frame.channel, frame.payload);
        break;
      case FRAME_PORTS:
        reportPorts(frame.payload);
        break;
      default:
        break;
    }
  });

  // Malformed payloads are ignored rather than closing the tunnel: this
  // frame carries a status readout, and a bad one must not cost the user
  // their forwarding.
  const reportPorts = (payload: Buffer) => {
    const reported = tunnels.get(ws);
    if (!reported) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString("utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    reported.clear();
    for (const value of parsed) {
      if (Number.isInteger(value) && value >= 1 && value <= 65535) reported.add(value as number);
    }
  };

  const pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30_000);

  ws.on("error", () => {
    // Surfaced to the CLI as a WS close; nothing to do server-side beyond
    // avoiding an unhandled "error" event.
  });

  ws.on("close", () => {
    clearInterval(pingTimer);
    tunnels.delete(ws);
    for (const ch of channels.values()) ch.socket.destroy();
    channels.clear();
  });
}

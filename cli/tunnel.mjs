#!/usr/bin/env node
// perch port tunnel — served verbatim from the server at GET /tunnel.mjs.
// Zero dependencies by design: run with `node tunnel.mjs <spec>...` on stock
// Node 20+. See README.md's "Port forwarding" section for usage.
//
// One WebSocket per process carries every forwarded connection as a
// multiplexed "channel" (see the frame format below). The frame codec is
// duplicated in server/src/wsTunnel.ts — keep both copies in sync.

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";

// --- Frame codec (mirrors server/src/wsTunnel.ts) ---------------------
//   [type:1][channel:4 uint32 BE][payload...]
const FRAME_OPEN = 1; // client -> server, payload: uint16 BE remote port
const FRAME_OPEN_OK = 2; // server -> client
const FRAME_OPEN_FAIL = 3; // server -> client, payload: utf8 error code
const FRAME_DATA = 4; // both directions, payload: raw bytes
const FRAME_CLOSE = 5; // both directions, peer's TCP side ended
const FRAME_WINDOW = 6; // both directions, payload: uint32 BE bytes consumed
// client -> server, payload: utf8 JSON array of the remote ports bound
// locally right now. Sent on connect and whenever that set changes, so the
// app can show which ports are reachable at localhost:<port>. Informational
// only — the server authorizes nothing from it.
const FRAME_PORTS = 7;

const WINDOW_SIZE = 1024 * 1024;

function encodeFrame(type, channel, payload) {
  const buf = Buffer.allocUnsafe(5 + payload.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(channel, 1);
  payload.copy(buf, 5);
  return buf;
}

function decodeFrame(buf) {
  if (buf.length < 5) return null;
  return {
    type: buf.readUInt8(0),
    channel: buf.readUInt32BE(1),
    payload: buf.subarray(5),
  };
}

function encodeUint16(n) {
  const buf = Buffer.allocUnsafe(2);
  buf.writeUInt16BE(n, 0);
  return buf;
}

function encodeUint32(n) {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32BE(n, 0);
  return buf;
}

// --- Minimal RFC 6455 client -------------------------------------------
// Node's built-in WebSocket rejects custom headers and URL credentials, and
// this file must stay dependency-free, so the handshake and framing are
// hand-rolled against node:http/https + the raw upgraded socket.

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// URL credentials become a Basic Authorization header on every request the
// CLI makes (WS handshake and --all port-list polls alike).
function withUrlAuth(url, headers) {
  if (!url.username && !url.password) return headers;
  const cred = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return { ...headers, Authorization: `Basic ${Buffer.from(cred).toString("base64")}` };
}

function buildFrame(opcode, payload, masked) {
  const len = payload.length;
  let offset = 2;
  let headerLen = 2;
  if (len >= 65536) headerLen += 8;
  else if (len >= 126) headerLen += 2;
  if (masked) headerLen += 4;

  const buf = Buffer.allocUnsafe(headerLen + len);
  buf[0] = 0x80 | opcode; // FIN=1, no fragmentation
  if (len < 126) {
    buf[1] = len;
  } else if (len < 65536) {
    buf[1] = 126;
    buf.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    buf[1] = 127;
    buf.writeBigUInt64BE(BigInt(len), 2);
    offset = 10;
  }
  if (masked) {
    buf[1] |= 0x80;
    const mask = crypto.randomBytes(4);
    mask.copy(buf, offset);
    offset += 4;
    for (let i = 0; i < len; i++) buf[offset + i] = payload[i] ^ mask[i % 4];
  } else {
    payload.copy(buf, offset);
  }
  return buf;
}

// Incremental parser: handles frames split across TCP reads and
// continuation (fragmented) WebSocket messages defensively, even though our
// own server never fragments in practice.
class FrameParser {
  constructor(onFrame) {
    this.buf = Buffer.alloc(0);
    this.onFrame = onFrame;
    this.fragments = [];
    this.fragmentOpcode = null;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < offset + 2) return;
        len = this.buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buf.length < offset + 8) return;
        len = Number(this.buf.readBigUInt64BE(offset));
        offset += 8;
      }
      let mask;
      if (masked) {
        if (this.buf.length < offset + 4) return;
        mask = this.buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buf.length < offset + len) return;

      let payload = this.buf.subarray(offset, offset + len);
      if (masked) {
        const unmasked = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
      } else {
        payload = Buffer.from(payload);
      }
      this.buf = this.buf.subarray(offset + len);

      if (opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = [];
          const finalOpcode = this.fragmentOpcode;
          this.fragmentOpcode = null;
          this.onFrame(finalOpcode, full);
        }
      } else if (!fin) {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
      } else {
        this.onFrame(opcode, payload);
      }
    }
  }
}

function connectWebSocket(urlStr, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isTls = url.protocol === "https:" || url.protocol === "wss:";
    const mod = isTls ? https : http;
    const key = crypto.randomBytes(16).toString("base64");

    const reqHeaders = withUrlAuth(url, {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": key,
      "Sec-WebSocket-Version": "13",
      ...headers,
    });

    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (isTls ? 443 : 80),
      path: `${url.pathname === "/" ? "" : url.pathname}/ws/tunnel`,
      headers: reqHeaders,
    });

    req.on("upgrade", (res, socket, head) => {
      if (res.statusCode !== 101) {
        socket.destroy();
        reject(new Error(`unexpected status ${res.statusCode}`));
        return;
      }
      const expectedAccept = crypto
        .createHash("sha1")
        .update(key + WS_GUID)
        .digest("base64");
      if (res.headers["sec-websocket-accept"] !== expectedAccept) {
        socket.destroy();
        reject(new Error("invalid Sec-WebSocket-Accept"));
        return;
      }
      resolve({ socket, head });
    });

    req.on("response", (res) => {
      reject(new Error(`server did not upgrade (status ${res.statusCode})`));
    });

    req.on("error", reject);
    req.end();
  });
}

// Plain GET against the perch API, honoring the same base path, URL
// credentials, and extra headers as the WebSocket connection.
function httpGetJson(urlStr, apiPath, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isTls = url.protocol === "https:" || url.protocol === "wss:";
    const mod = isTls ? https : http;

    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (isTls ? 443 : 80),
        path: `${url.pathname === "/" ? "" : url.pathname}${apiPath}`,
        headers: withUrlAuth(url, { Accept: "application/json", ...headers }),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`GET ${apiPath} failed (status ${res.statusCode})`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error(`GET ${apiPath}: invalid JSON response`));
          }
        });
      },
    );

    req.on("error", reject);
    req.end();
  });
}

// --- Mux layer -----------------------------------------------------------

class WsTunnel {
  constructor(urlStr, headers) {
    this.urlStr = urlStr;
    this.headers = headers;
    this.socket = null;
    this.parser = null;
    this.channels = new Map();
    this.nextChannelId = 1;
    this.connecting = null;
    // Last set handed to reportPorts, replayed on every (re)connect: the
    // socket is opened lazily and a drop clears the server's registry, so
    // without this the status readout would go stale until the next change.
    this.reportedPorts = [];
  }

  ensureConnected() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this._connect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  async _connect() {
    const { socket, head } = await connectWebSocket(this.urlStr, this.headers);
    this.socket = socket;
    this.parser = new FrameParser((opcode, payload) => this._onWsFrame(opcode, payload));
    socket.on("data", (chunk) => this.parser.push(chunk));
    socket.on("close", () => this._onSocketClosed());
    socket.on("error", () => {});
    if (head && head.length) this.parser.push(head);
    console.log(`connected to ${this.urlStr}`);
    this._sendPorts();
  }

  _onSocketClosed() {
    this.socket = null;
    for (const ch of this.channels.values()) ch.localSocket.destroy();
    this.channels.clear();
  }

  _sendControl(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(buildFrame(opcode, payload, true));
  }

  _send(type, channel, payload = Buffer.alloc(0)) {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(buildFrame(0x2, encodeFrame(type, channel, payload), true));
  }

  _onWsFrame(opcode, payload) {
    if (opcode === 0x8) {
      this._sendControl(0x8, Buffer.alloc(0));
      this.socket?.end();
      return;
    }
    if (opcode === 0x9) {
      this._sendControl(0xa, payload);
      return;
    }
    if (opcode === 0xa) return; // pong
    if (opcode === 0x2) {
      const frame = decodeFrame(payload);
      if (frame) this._onTunnelFrame(frame.type, frame.channel, frame.payload);
    }
  }

  _flushAck(id, ch) {
    if (ch.unacked > 0) this._send(FRAME_WINDOW, id, encodeUint32(ch.unacked));
    ch.unacked = 0;
  }

  _onTunnelFrame(type, id, payload) {
    const ch = this.channels.get(id);
    if (!ch) return;
    switch (type) {
      case FRAME_OPEN_OK:
        ch.connected = true;
        ch.localSocket.on("data", (chunk) => {
          this._send(FRAME_DATA, id, chunk);
          ch.sendCredit -= chunk.length;
          if (ch.sendCredit <= 0) ch.localSocket.pause();
        });
        break;
      case FRAME_OPEN_FAIL:
        console.error(`[remote:${ch.remotePort}] connection refused: ${payload.toString("utf8")}`);
        this.channels.delete(id);
        ch.localSocket.destroy();
        break;
      case FRAME_DATA: {
        ch.unacked += payload.length;
        const ok = ch.localSocket.write(payload);
        if (ok) {
          this._flushAck(id, ch);
        } else if (!ch.drainScheduled) {
          ch.drainScheduled = true;
          ch.localSocket.once("drain", () => {
            ch.drainScheduled = false;
            this._flushAck(id, ch);
          });
        }
        break;
      }
      case FRAME_CLOSE:
        this.channels.delete(id);
        ch.localSocket.end();
        break;
      case FRAME_WINDOW:
        if (payload.length < 4) return;
        ch.sendCredit += payload.readUInt32BE(0);
        if (ch.sendCredit > 0 && ch.localSocket.isPaused()) ch.localSocket.resume();
        break;
      default:
        break;
    }
  }

  // opts.onListenError makes a failed local bind non-fatal (--all keeps
  // running and retries on later polls); without it the process exits, which
  // is the right behavior for explicitly requested specs.
  // Tells the server which remote ports are bound locally right now (see
  // FRAME_PORTS). Cheap and idempotent, so callers can just re-send the whole
  // set whenever it changes.
  reportPorts(ports) {
    this.reportedPorts = [...ports];
    // Connects if needed: with only --all running there may be no channel
    // yet, and the report is exactly what the app is waiting for.
    void this.ensureConnected().then(
      () => this._sendPorts(),
      () => {},
    );
  }

  _sendPorts() {
    this._send(FRAME_PORTS, 0, Buffer.from(JSON.stringify(this.reportedPorts), "utf8"));
  }

  forward(localPort, remotePort, opts = {}) {
    const server = net.createServer((localSocket) => {
      const id = this.nextChannelId++;
      const ch = {
        localSocket,
        connected: false,
        openSent: false,
        canceled: false,
        sendCredit: WINDOW_SIZE,
        unacked: 0,
        drainScheduled: false,
        remotePort,
      };
      this.channels.set(id, ch);

      localSocket.on("error", () => {});
      localSocket.on("close", () => {
        if (!this.channels.has(id)) return;
        this.channels.delete(id);
        if (ch.openSent) this._send(FRAME_CLOSE, id);
        else ch.canceled = true;
      });

      this.ensureConnected()
        .then(() => {
          if (ch.canceled) return;
          ch.openSent = true;
          this._send(FRAME_OPEN, id, encodeUint16(remotePort));
        })
        .catch((err) => {
          console.error(`tunnel connection failed: ${err.message}`);
          localSocket.destroy();
        });
    });

    server.on("error", (err) => {
      if (opts.onListenError) {
        opts.onListenError(err);
        return;
      }
      console.error(`failed to listen on 127.0.0.1:${localPort}: ${err.message}`);
      process.exit(1);
    });

    server.listen(localPort, "127.0.0.1", () => {
      console.log(
        `localhost:${localPort} -> remote:${remotePort}${opts.label ? ` (${opts.label})` : ""}`,
      );
      if (opts.onListen) opts.onListen();
    });
    return server;
  }
}

// --- Auto-forward (--all) -------------------------------------------------
// Polls the server's terminal-attributed port list and keeps one local listener
// per remote port: new ports appear without restarting, vanished ports close
// their listeners (in-flight connections drain). A local port that can't be
// bound (something already listening on this machine) is reported once and
// silently retried on later polls.

const AUTO_POLL_MS = 3000;

function startAutoForward(tunnel, urlStr, headers, skipPorts) {
  const active = new Map(); // remote port -> local net.Server
  const reportBound = () => tunnel.reportPorts([...active.keys()].filter((p) => !bindFailed.has(p)));
  const bindFailed = new Set(); // local bind failures already reported
  let lastFetchError = null;

  const poll = async () => {
    let list;
    try {
      list = await httpGetJson(urlStr, "/api/ext/perch.ports/list", headers);
      if (lastFetchError) {
        console.log("port list reachable again");
        lastFetchError = null;
      }
    } catch (err) {
      // Report each distinct failure once, not every 3s.
      if (err.message !== lastFetchError) {
        console.error(`port list fetch failed: ${err.message}`);
        lastFetchError = err.message;
      }
      return;
    }

    const current = new Set();
    for (const entry of Array.isArray(list) ? list : []) {
      const port = entry?.port;
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      current.add(port);
      if (skipPorts.has(port) || active.has(port)) continue;

      const label = `${entry.process ?? "?"} in ${entry.session}`;
      const server = tunnel.forward(port, port, {
        label,
        onListen: () => bindFailed.delete(port),
        onListenError: (err) => {
          active.delete(port);
          if (!bindFailed.has(port)) {
            bindFailed.add(port);
            console.error(`skipping ${port} (${label}): cannot listen locally: ${err.message}`);
          }
        },
      });
      active.set(port, server);
    }

    for (const [port, server] of active) {
      if (!current.has(port)) {
        active.delete(port);
        server.close();
        console.log(`localhost:${port} closed (no longer listening on server)`);
      }
    }
    // A vanished port's bind failure is stale — report again if it returns.
    for (const port of bindFailed) {
      if (!current.has(port)) bindFailed.delete(port);
    }
    // Only ports actually bound: a port in bindFailed is listening on the
    // server but NOT reachable at localhost here, and reporting it would put
    // a "forwarded" marker on a dead link.
    reportBound();
  };

  void poll();
  // Deliberately not unref'd: with zero forwards yet, this timer is what
  // keeps the process alive.
  setInterval(() => void poll(), AUTO_POLL_MS);
}

// --- CLI ------------------------------------------------------------------

function printUsage() {
  console.error(
    "Usage: node tunnel.mjs [--url http://host:port] [--header 'Name: value']... [--all] [<spec>...]\n" +
      "  spec = PORT            forward localhost:PORT -> remote 127.0.0.1:PORT\n" +
      "       | LOCAL:REMOTE    forward localhost:LOCAL -> remote 127.0.0.1:REMOTE\n" +
      "  --all                  forward every port listening inside the server's terminals\n" +
      "                         sessions; polls so new ports are picked up and vanished\n" +
      "                         ones closed without restarting",
  );
}

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return port;
}

function parseSpec(spec) {
  const parts = spec.split(":");
  if (parts.length === 1) {
    const port = parsePort(parts[0], "port");
    return { local: port, remote: port };
  }
  if (parts.length === 2) {
    return { local: parsePort(parts[0], "local port"), remote: parsePort(parts[1], "remote port") };
  }
  throw new Error(`invalid spec: ${spec}`);
}

function parseArgs(argv) {
  let url = process.env.PERCH_URL || "http://127.0.0.1:3001";
  let all = false;
  const headers = {};
  const specs = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--url") {
      url = argv[++i];
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--header") {
      const raw = argv[++i] ?? "";
      const idx = raw.indexOf(":");
      if (idx === -1) throw new Error(`invalid --header value: ${raw}`);
      headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      specs.push(parseSpec(arg));
    }
  }
  if (specs.length === 0 && !all) throw new Error("no port specs given (or use --all)");
  return { url, headers, specs, all };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    printUsage();
    process.exit(1);
  }

  const tunnel = new WsTunnel(args.url, args.headers);
  // Report a spec's remote port only once its local listener is actually up
  // (and withdraw it if the bind fails) — the same rule --all follows, so
  // the app never marks a port reachable at a localhost address that isn't
  // bound.
  const bound = new Set();
  const reportBound = () => tunnel.reportPorts([...bound]);
  for (const spec of args.specs) {
    tunnel.forward(spec.local, spec.remote, {
      onListen: () => {
        bound.add(spec.remote);
        reportBound();
      },
      onListenError: () => {
        bound.delete(spec.remote);
        reportBound();
      },
    });
  }
  if (args.all) {
    // Explicitly requested local ports stay owned by their specs.
    startAutoForward(tunnel, args.url, args.headers, new Set(args.specs.map((s) => s.local)));
  }
}

main();

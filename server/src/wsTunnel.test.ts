import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { handleTunnel, tunnelStatus } from "./wsTunnel.js";

// Enough of a socket for handleTunnel: it only listens, pings and (on the
// paths these tests take) never writes. The real frame codec is exercised by
// feeding it the bytes a tunnel CLI would send.
class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  ping(): void {}
  send(): void {}
}

const FRAME_PORTS = 7;

function portsFrame(ports: number[]): Buffer {
  const payload = Buffer.from(JSON.stringify(ports), "utf8");
  const frame = Buffer.alloc(5 + payload.length);
  frame.writeUInt8(FRAME_PORTS, 0);
  frame.writeUInt32BE(0, 1);
  payload.copy(frame, 5);
  return frame;
}

const open = (address: string | null, ports: number[] = []) => {
  const socket = new FakeSocket();
  handleTunnel(socket as unknown as WebSocket, address);
  if (ports.length > 0) socket.emit("message", portsFrame(ports), true);
  return socket;
};

const sockets: FakeSocket[] = [];
const connect = (address: string | null, ports?: number[]) => {
  const socket = open(address, ports);
  sockets.push(socket);
  return socket;
};

afterEach(() => {
  // "close" is what clears the registry and the ping timer.
  while (sockets.length > 0) sockets.pop()!.emit("close");
});

describe("tunnelStatus", () => {
  it("reports a tunnel from the asking machine", () => {
    connect("203.0.113.7", [3000, 5173]);
    expect(tunnelStatus("203.0.113.7")).toEqual({ connected: true, ports: [3000, 5173] });
  });

  it("does not report someone else's tunnel", () => {
    connect("203.0.113.7", [3000]);
    expect(tunnelStatus("198.51.100.4")).toEqual({ connected: false, ports: [] });
  });

  it("unions only the tunnels on the asking machine", () => {
    connect("203.0.113.7", [3000]);
    connect("203.0.113.7", [8080]);
    connect("198.51.100.4", [9999]);
    expect(tunnelStatus("203.0.113.7")).toEqual({ connected: true, ports: [3000, 8080] });
  });

  it("reads the two spellings of loopback, and an IPv4-mapped address, as one machine", () => {
    connect("::1", [4000]);
    expect(tunnelStatus("127.0.0.1")).toEqual({ connected: true, ports: [4000] });
    expect(tunnelStatus("::ffff:127.0.0.1")).toEqual({ connected: true, ports: [4000] });
  });

  it("answers nothing when either side has no address to match on", () => {
    connect(null, [3000]);
    expect(tunnelStatus("127.0.0.1")).toEqual({ connected: false, ports: [] });
    expect(tunnelStatus(undefined)).toEqual({ connected: false, ports: [] });
  });

  it("forgets a tunnel once it closes", () => {
    const socket = connect("203.0.113.7", [3000]);
    socket.emit("close");
    expect(tunnelStatus("203.0.113.7")).toEqual({ connected: false, ports: [] });
  });

  it("a connected client that reports no ports is still a connection", () => {
    connect("203.0.113.7");
    expect(tunnelStatus("203.0.113.7")).toEqual({ connected: true, ports: [] });
  });
});

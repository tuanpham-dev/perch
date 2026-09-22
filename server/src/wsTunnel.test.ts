import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { handleTunnel, tunnelStatus } from "./wsTunnel.js";

// Enough of a socket for handleTunnel: it only listens, pings and (on the
// paths these tests take) never writes. The real frame codec is exercised by
// feeding it the bytes a tunnel CLI would send.
class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  terminated = false;
  ping(): void {}
  send(): void {}
  terminate(): void {
    this.terminated = true;
    this.emit("close");
  }
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

const open = (client: string | null, ports: number[] = []) => {
  const socket = new FakeSocket();
  handleTunnel(socket as unknown as WebSocket, client);
  if (ports.length > 0) socket.emit("message", portsFrame(ports), true);
  return socket;
};

const sockets: FakeSocket[] = [];
const connect = (client: string | null, ports?: number[]) => {
  const socket = open(client, ports);
  sockets.push(socket);
  return socket;
};

afterEach(() => {
  // "close" is what clears the registry and the ping timer.
  while (sockets.length > 0) sockets.pop()!.emit("close");
});

describe("tunnelStatus", () => {
  it("reports a tunnel started for the asking browser", () => {
    connect("laptop", [3000, 5173]);
    expect(tunnelStatus("laptop")).toEqual({ connected: true, ports: [3000, 5173] });
  });

  it("does not report a tunnel started for another browser", () => {
    connect("laptop", [3000]);
    expect(tunnelStatus("phone")).toEqual({ connected: false, ports: [] });
  });

  it("unions only the tunnels started for the asking browser", () => {
    connect("laptop", [3000]);
    connect("laptop", [8080]);
    connect("desktop", [9999]);
    expect(tunnelStatus("laptop")).toEqual({ connected: true, ports: [3000, 8080] });
  });

  it("counts a tunnel with no id for no one", () => {
    connect(null, [3000]);
    expect(tunnelStatus("laptop")).toEqual({ connected: false, ports: [] });
    expect(tunnelStatus(null)).toEqual({ connected: false, ports: [] });
  });

  it("ignores an id that isn't a plain token, on either side", () => {
    connect("a b", [3000]);
    expect(tunnelStatus("a b")).toEqual({ connected: false, ports: [] });
  });

  it("forgets a tunnel once it closes", () => {
    const socket = connect("laptop", [3000]);
    socket.emit("close");
    expect(tunnelStatus("laptop")).toEqual({ connected: false, ports: [] });
  });

  it("a connected client that reports no ports is still a connection", () => {
    connect("laptop");
    expect(tunnelStatus("laptop")).toEqual({ connected: true, ports: [] });
  });
});

describe("tunnel liveness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops a tunnel that stops answering pings", () => {
    vi.useFakeTimers();
    const socket = connect("laptop", [3000]);
    vi.advanceTimersByTime(30_000); // ping sent
    expect(tunnelStatus("laptop").connected).toBe(true);
    vi.advanceTimersByTime(30_000); // no pong since
    expect(socket.terminated).toBe(true);
    expect(tunnelStatus("laptop")).toEqual({ connected: false, ports: [] });
  });

  it("keeps a tunnel that answers", () => {
    vi.useFakeTimers();
    const socket = connect("laptop", [3000]);
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(30_000);
      socket.emit("pong");
    }
    expect(socket.terminated).toBe(false);
    expect(tunnelStatus("laptop").connected).toBe(true);
  });
});

import net from 'node:net';
import { platform } from '../platform/index.ts';
import {
  FRAME_CONTROL, FRAME_INPUT, FRAME_OUTPUT,
  FrameReader, encodeControl, encodeFrame,
} from '../protocol/frames.ts';
import type { ServerEvent } from '../protocol/messages.ts';
import { daemonEntryPath, ensureStateDirs, logPath, socketPath } from '../util/paths.ts';

export class MuxError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'MuxError';
  }
}

type Pending = { resolve: (data: unknown) => void; reject: (err: Error) => void };

export class ClientConn {
  onOutput: ((data: Buffer) => void) | undefined;
  onEvent: ((event: ServerEvent) => void) | undefined;
  onClose: (() => void) | undefined;

  #socket: net.Socket;
  #reader = new FrameReader();
  #nextId = 1;
  #pending = new Map<number, Pending>();

  constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = this.#reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.type === FRAME_OUTPUT) {
          this.onOutput?.(frame.payload);
        } else if (frame.type === FRAME_CONTROL) {
          const msg = JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>;
          if (typeof msg.id === 'number') {
            const pending = this.#pending.get(msg.id);
            if (pending) {
              this.#pending.delete(msg.id);
              if (msg.ok) pending.resolve(msg.data);
              else {
                const e = msg.error as { code: string; message: string };
                pending.reject(new MuxError(e.code, e.message));
              }
            }
          } else if (typeof msg.event === 'string') {
            this.onEvent?.(msg as unknown as ServerEvent);
          }
        }
      }
    });
    socket.on('close', () => {
      for (const p of this.#pending.values()) p.reject(new MuxError('DISCONNECTED', 'the terminal daemon closed the connection'));
      this.#pending.clear();
      this.onClose?.();
    });
    socket.on('error', () => { /* close follows */ });
  }

  request(req: { kind: string } & Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(encodeControl({ ...req, id }));
    });
  }

  sendInput(data: Buffer): void {
    this.#socket.write(encodeFrame(FRAME_INPUT, data));
  }

  close(): void { this.#socket.end(); }
  destroy(): void { this.#socket.destroy(); }
}

export function tryConnect(timeoutMs = 400): Promise<ClientConn | null> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath());
    const timer = setTimeout(() => { socket.destroy(); resolve(null); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolve(new ClientConn(socket)); });
    socket.once('error', () => { clearTimeout(timer); resolve(null); });
  });
}

/**
 * Connect to the daemon, spawning one first if none answers the socket.
 *
 * `env` is the environment a newly spawned daemon gets, and through it every
 * shell it starts. A caller holding secrets in its own environment (the app
 * server's AUTH_TOKEN) passes a scrubbed copy rather than letting the daemon
 * inherit them.
 */
export async function connectOrSpawn(daemonArgs: string[] = [], env?: NodeJS.ProcessEnv): Promise<ClientConn> {
  const existing = await tryConnect();
  if (existing) return existing;
  const problem = platform.addressProblem(socketPath());
  if (problem) throw new MuxError('SOCKET_PATH_TOO_LONG', problem);
  ensureStateDirs();
  platform.spawnDetached(process.execPath, [daemonEntryPath(), ...daemonArgs], env);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    const conn = await tryConnect(200);
    if (conn) return conn;
  }
  throw new MuxError('DAEMON_START_FAILED', `could not start the terminal daemon; check ${logPath()}`);
}

/** Run one request-cycle against the daemon and always close the connection. */
export async function withConn<T>(fn: (conn: ClientConn) => Promise<T>, daemonArgs: string[] = []): Promise<T> {
  const conn = await connectOrSpawn(daemonArgs);
  try {
    return await fn(conn);
  } finally {
    conn.close();
  }
}

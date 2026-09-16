// Wire format: 4-byte big-endian payload length, 1-byte frame type, payload.
export const FRAME_CONTROL = 0x01; // JSON control message (request/response/event)
export const FRAME_OUTPUT = 0x02;  // PTY output bytes, server -> client
export const FRAME_INPUT = 0x03;   // PTY input bytes, client -> server

export const MAX_PAYLOAD = 8 * 1024 * 1024;

export type Frame = { type: number; payload: Buffer };

export function encodeFrame(type: number, payload: Buffer | string): Buffer {
  const p = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (p.length > MAX_PAYLOAD) throw new Error(`frame payload of ${p.length} bytes exceeds ${MAX_PAYLOAD}`);
  const head = Buffer.allocUnsafe(5);
  head.writeUInt32BE(p.length, 0);
  head.writeUInt8(type, 4);
  return Buffer.concat([head, p]);
}

// The same frame written as header then payload, without copying the payload
// into a new buffer: for output, which is most of what the daemon sends.
export function writeFrame(socket: { cork(): void; uncork(): void; write(chunk: Buffer): boolean }, type: number, payload: Buffer): void {
  if (payload.length > MAX_PAYLOAD) throw new Error(`frame payload of ${payload.length} bytes exceeds ${MAX_PAYLOAD}`);
  const head = Buffer.allocUnsafe(5);
  head.writeUInt32BE(payload.length, 0);
  head.writeUInt8(type, 4);
  socket.cork();
  socket.write(head);
  socket.write(payload);
  socket.uncork();
}

export function encodeControl(msg: unknown): Buffer {
  return encodeFrame(FRAME_CONTROL, JSON.stringify(msg));
}

/** Buffers partial frames across arbitrary chunk boundaries. */
export class FrameReader {
  #buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    const frames: Frame[] = [];
    while (this.#buf.length >= 5) {
      const len = this.#buf.readUInt32BE(0);
      if (len > MAX_PAYLOAD) throw new Error(`incoming frame claims ${len} bytes, over the ${MAX_PAYLOAD} limit`);
      if (this.#buf.length < 5 + len) break;
      // Copy the payload out so a small frame doesn't pin a large backing buffer.
      frames.push({ type: this.#buf.readUInt8(4), payload: Buffer.from(this.#buf.subarray(5, 5 + len)) });
      this.#buf = this.#buf.length === 5 + len ? Buffer.alloc(0) : Buffer.from(this.#buf.subarray(5 + len));
    }
    return frames;
  }
}

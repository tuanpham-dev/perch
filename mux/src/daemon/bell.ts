// Detecting a real bell in a stream of PTY output.
//
// BEL (0x07) is not only a bell: it is also a legal terminator for an OSC
// string. Shells set the window title with `ESC ] 0 ; title BEL` on virtually
// every prompt, so scanning for the byte alone would report a bell several
// times a second and make the notification worthless.
//
// So this tracks whether the stream is inside an OSC string. A BEL inside one
// ends that string; a BEL outside one is a bell the program actually rang —
// which is what a coding agent does when it wants your attention.

const ESC = 0x1b;
const BEL = 0x07;
const OSC = 0x5d; // "]"
const ST_BACKSLASH = 0x5c; // "\" — the second byte of ESC \, the other terminator
const OSC_START = Buffer.from([ESC, OSC]);
const ST = Buffer.from([ESC, ST_BACKSLASH]);

// Whether the byte after this chunk follows an ESC. Every ESC arms it and
// every other byte clears it, so only the last byte matters.
function endsInEsc(chunk: Buffer): boolean {
  return chunk[chunk.length - 1] === ESC;
}

export class BellDetector {
  /** Inside an OSC string, where BEL is a terminator rather than a bell. */
  #inOsc = false;
  /** The previous byte was ESC, so the next one decides what this is. */
  #afterEsc = false;

  /**
   * Feed a chunk; returns how many real bells it contained.
   *
   * State carries between calls because a sequence can be split across reads —
   * a chunk boundary in the middle of an OSC string is ordinary, and losing
   * track there would turn the next title into a false bell.
   */
  feed(chunk: Buffer): number {
    // Most output rings no bell. Without a BEL the only thing to learn is the
    // OSC state at the end, which the last ESC ] or ESC \ decides (found with
    // a native search instead of a loop over every byte).
    if (chunk.indexOf(BEL) === -1) {
      if (this.#afterEsc && chunk.length > 0) {
        if (chunk[0] === OSC) this.#inOsc = true;
        else if (chunk[0] === ST_BACKSLASH) this.#inOsc = false;
      }
      const open = chunk.lastIndexOf(OSC_START);
      const close = chunk.lastIndexOf(ST);
      if (open !== -1 || close !== -1) this.#inOsc = open > close;
      if (chunk.length > 0) this.#afterEsc = endsInEsc(chunk);
      return 0;
    }
    let bells = 0;
    for (const byte of chunk) {
      if (this.#afterEsc) {
        this.#afterEsc = false;
        if (byte === OSC) { this.#inOsc = true; continue; }
        // ESC \ is the String Terminator; it ends an OSC string too.
        if (byte === ST_BACKSLASH) { this.#inOsc = false; continue; }
        // Any other sequence (CSI, charset selection…) doesn't change OSC state.
        if (byte === ESC) { this.#afterEsc = true; }
        continue;
      }

      if (byte === ESC) { this.#afterEsc = true; continue; }

      if (byte === BEL) {
        if (this.#inOsc) this.#inOsc = false; // terminator, not a bell
        else bells++;
        continue;
      }
    }
    return bells;
  }

  /** Exposed for tests and for reasoning about a stuck state. */
  get insideOsc(): boolean { return this.#inOsc; }

  reset(): void {
    this.#inOsc = false;
    this.#afterEsc = false;
  }
}

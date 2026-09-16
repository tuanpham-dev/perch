// SGR (DEC mode 1006) mouse-report encoding. ghostty-web renders and parses
// terminal output but sends nothing to the PTY for mouse input, so
// TerminalView encodes reports itself and ships them over the attach
// socket's {type:"input"} channel — the same bytes a native terminal
// (xterm, Ghostty, iTerm) would write to the pty. SGR-only: the tmux backend always
// enables 1006 alongside 1000/1002 when `mouse on` is set, so the legacy
// X10/UTF-8 encodings are dead weight here.

export type SgrKind = "press" | "release" | "motion" | "wheelUp" | "wheelDown";

export interface SgrMods {
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

// `button`: 0 left, 1 middle, 2 right (ignored for wheel kinds).
// `col`/`row` are 1-based, as the wire format requires.
export function encodeSgrMouse(
  kind: SgrKind,
  button: 0 | 1 | 2,
  col: number,
  row: number,
  mods: SgrMods = {},
): string {
  let b: number;
  if (kind === "wheelUp") b = 64;
  else if (kind === "wheelDown") b = 65;
  else b = button;
  // Motion reports flag bit 5 on top of the held button (button-event
  // tracking, mode 1002).
  if (kind === "motion") b += 32;
  if (mods.shift) b += 4;
  if (mods.alt) b += 8;
  if (mods.ctrl) b += 16;
  return `\x1b[<${b};${col};${row}${kind === "release" ? "m" : "M"}`;
}

// Pixel point -> 1-based cell, clamped to the grid. `rect` is the canvas's
// bounding rect (cells start at the canvas origin, not the padded host's).
export function cellFromPoint(
  x: number,
  y: number,
  rect: { left: number; top: number },
  charWidth: number,
  charHeight: number,
  cols: number,
  rows: number,
): { col: number; row: number } {
  const col = Math.min(cols, Math.max(1, Math.floor((x - rect.left) / charWidth) + 1));
  const row = Math.min(rows, Math.max(1, Math.floor((y - rect.top) / charHeight) + 1));
  return { col, row };
}

// WheelEvent.deltaMode values (named locally so tests can run without a DOM).
const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

// Port of xterm.js's Viewport wheel math (Viewport.getLinesScrolled +
// _applyScrollModifier), so wheel feel matches what the app shipped with:
//  - pixel-mode deltas divide by the cell height, with the fractional
//    remainder carried between events (smooth trackpads emit sub-line
//    deltas that must accumulate rather than vanish);
//  - line-mode deltas pass through;
//  - page-mode deltas multiply by the viewport row count;
//  - holding Alt applies xterm's default fastScrollSensitivity (5x).
// Returns whole lines: positive = scroll down, negative = up.
export class WheelLineAccumulator {
  private partial = 0;

  linesFor(
    ev: { deltaY: number; deltaMode: number; altKey?: boolean },
    cellHeight: number,
    rows: number,
  ): number {
    if (ev.deltaY === 0) return 0;
    let amount = ev.deltaY * (ev.altKey ? 5 : 1);
    if (ev.deltaMode === DOM_DELTA_PIXEL) {
      amount /= cellHeight;
      this.partial += amount;
      // + 0 normalizes Math.trunc's -0 for sub-line negative deltas.
      const lines = Math.trunc(this.partial) + 0;
      this.partial -= lines;
      return lines;
    }
    if (ev.deltaMode === DOM_DELTA_PAGE) return Math.round(amount * rows);
    if (ev.deltaMode === DOM_DELTA_LINE) return Math.round(amount);
    return 0;
  }

  reset(): void {
    this.partial = 0;
  }
}

// Focus-in/out reports (DEC mode 1004) — the terminal forwards these to apps that
// asked for them (nvim's FocusGained/FocusLost autocmds).
export function focusReport(focused: boolean): string {
  return focused ? "\x1b[I" : "\x1b[O";
}

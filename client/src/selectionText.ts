// Copy-time selection extraction shared by both terminal engines via the
// @perch/engine-support shim. tmux repaints attached clients with
// explicit cursor positioning, so the engines' buffers usually lack the
// isWrapped flags their own getSelection() relies on to join soft-wrapped
// rows — a redrawn wrapped line would copy with a hard "\n" at every wrap
// column. This rebuilds the text from the buffer and joins a row to the
// next when the buffer still says so (isWrapped) OR the row is filled to
// its last column (recovers the wraps tmux's redraw destroyed, same
// tradeoff as tmux's own `capture-pane -J`).

// 0-based, buffer-absolute coordinates with an EXCLUSIVE end column. The
// engines' getSelectionPosition() semantics differ (xterm 6: end.x
// exclusive despite its 1-based IBufferRange typing; ghostty-web 0.4:
// end.x inclusive), so each caller normalizes at its own edge.
export interface SelectionRangeExclusive {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

// Structural subset of both engines' buffer line — xterm's IBufferLine and
// ghostty-web's expose identical signatures.
export interface SelectionBufferCell {
  getChars(): string;
  getWidth(): number;
}

export interface SelectionBufferLine {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
  getCell?(x: number): SelectionBufferCell | undefined;
}

export interface SelectionTextTerminal {
  readonly cols: number;
  buffer: {
    active: {
      getLine(y: number): SelectionBufferLine | null | undefined;
    };
  };
}

// A row continues onto the next when its final column holds real content.
// Prefer cell inspection, which distinguishes three cases the rendered
// string cannot (verified against @xterm/xterm's Constants.ts and
// BufferLine.translateToString):
//   - width 0: a wide char's spacer, i.e. the wide char spans INTO the last
//     column — filled;
//   - getChars() "": the NULL_CELL, a cell never written to (width 1, and
//     translateToString renders it as WHITESPACE_CELL_CHAR " ") — not
//     filled;
//   - getChars() " ": a REAL space the program wrote. A greedy wrapper
//     breaking between words puts one here, so the row did run to the edge
//     — filled. But a row the program padded with spaces also ends in one,
//     and joining that would splice unrelated rows; the two are told apart
//     by the column before it, since wrapped text runs up to the edge while
//     padding is a run of blanks.
// The string fallback, for lines without getCell (ghostty-web), cannot make
// any of these distinctions — it yields " " for both an unwritten cell and
// a written space — so it keeps treating both as not filled.
function rowFilledToEdge(line: SelectionBufferLine, cols: number): boolean {
  const getCell = line.getCell?.bind(line);
  const cell = getCell?.(cols - 1);
  if (getCell && cell) {
    if (cell.getWidth() === 0) return true;
    const chars = cell.getChars();
    if (chars === "") return false;
    if (chars !== " ") return true;
    // Written space in the last column: real content only if the column
    // before it also holds real content (a wide char's spacer counts).
    const before = getCell(cols - 2);
    if (!before) return false;
    if (before.getWidth() === 0) return true;
    const beforeChars = before.getChars();
    return beforeChars !== "" && beforeChars !== " ";
  }
  const tail = line.translateToString(false, cols - 1, cols);
  return tail !== "" && tail !== " ";
}

export function joinedSelectionText(term: SelectionTextTerminal, range: SelectionRangeExclusive): string {
  const buffer = term.buffer.active;
  const cols = term.cols;
  const lines: string[] = [];
  let current = "";
  // Trailing whitespace is trimmed only at hard line ends (matching the
  // engines' own per-row trimming), never at a join point — a joined row is
  // full to the edge, so there is nothing to trim there anyway.
  const endLine = () => {
    lines.push(current.replace(/\s+$/, ""));
    current = "";
  };
  for (let y = range.startY; y <= range.endY; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const sx = y === range.startY ? range.startX : 0;
    const ex = y === range.endY ? range.endX : cols;
    current += line.translateToString(false, sx, ex);
    if (y === range.endY) break;
    const joined = buffer.getLine(y + 1)?.isWrapped || rowFilledToEdge(line, cols);
    if (!joined) endLine();
  }
  endLine();
  return lines.join("\n");
}

// A line that opens a list item — "- ", "* ", "+ ", "• ", "1. ", "2) ".
// Load-bearing for unwrapParagraphs below: without it, consecutive bullets
// would collapse into one run-on line.
const LIST_MARKER_RE = /^(?:[-*+•]|\d+[.)])\s/;

// Joins the line breaks a PROGRAM made while word-wrapping its own output,
// which joinedSelectionText above cannot: a wrap the terminal introduced is
// visible in the buffer (the row ran to the last column), but a renderer
// like Ink emits a real "\n" plus a continuation indent, and no
// terminal-level signal distinguishes that from a newline the program meant
// to keep. So this is deliberately LOSSY — code, `ls` output and log lines
// all collapse to one line per block — and never runs on the default copy
// path; it backs the per-copy "Copy as Paragraph" action and the opt-in
// "paragraph" copy mode.
//
// Within a run of non-blank lines every line is joined to the previous with
// a single space and its leading indent dropped. Two rules start a new
// line instead: a blank line (paragraph separator, preserved), and a line
// opening a list item. Idempotent — running it on its own output is a
// no-op.
export function unwrapParagraphs(text: string): string {
  const out: string[] = [];
  let current: string | null = null;
  const flush = () => {
    if (current !== null) out.push(current.replace(/\s+$/, ""));
    current = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") {
      flush();
      out.push("");
      continue;
    }
    // The paragraph's own first line keeps its indent (an indented list
    // item or code line stays where it is); only continuations lose theirs.
    if (current === null || LIST_MARKER_RE.test(line.trimStart())) {
      flush();
      current = line;
      continue;
    }
    current += ` ${line.trimStart()}`;
  }
  flush();
  return out.join("\n");
}

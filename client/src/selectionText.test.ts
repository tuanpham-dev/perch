import { describe, expect, it } from "vitest";
import {
  joinedSelectionText,
  unwrapParagraphs,
  type SelectionBufferLine,
  type SelectionTextTerminal,
} from "./selectionText";

// xterm-flavored fake line over per-cell entries, matching @xterm/xterm's
// real cell semantics (verified against common/buffer/Constants.ts and
// BufferLine.translateToString):
//   - a normal cell is its one char, width 1;
//   - an UNWRITTEN cell (null here) is the NULL_CELL: getChars() "" with
//     NULL_CELL_WIDTH 1, rendered as WHITESPACE_CELL_CHAR " " by
//     translateToString — so "" via getCell but " " in the string;
//   - a WRITTEN space is " " through both;
//   - a wide char occupies two cells — its char then a width-0 spacer
//     ("" in the cells array) contributing "" to the string.
// The distinction between an unwritten cell and a written space is exactly
// what rowFilledToEdge depends on, so the fake must not blur them.
type FakeCell = string | null;

function line(cells: FakeCell[], isWrapped = false): SelectionBufferLine {
  return {
    isWrapped,
    translateToString(trimRight = false, startColumn = 0, endColumn = cells.length) {
      const text = cells
        .slice(startColumn, endColumn)
        .map((c) => (c === null ? " " : c))
        .join("");
      return trimRight ? text.replace(/\s+$/, "") : text;
    },
    getCell(x) {
      if (x < 0 || x >= cells.length) return undefined;
      const c = cells[x];
      if (c === null) return { getChars: () => "", getWidth: () => 1 };
      return { getChars: () => c, getWidth: () => (c === "" ? 0 : 1) };
    },
  };
}

// ghostty-flavored fake: no getCell, and translateToString yields "" (not
// " ") for cells past the written length — the shape that regressed live.
function ghosttyLine(text: string, isWrapped = false): SelectionBufferLine {
  return {
    isWrapped,
    translateToString(trimRight = false, startColumn = 0, endColumn = text.length) {
      const t = [...text].slice(startColumn, endColumn).join("");
      return trimRight ? t.replace(/\s+$/, "") : t;
    },
  };
}

function cellsOf(text: string, cols: number): FakeCell[] {
  const cells: FakeCell[] = [...text];
  while (cells.length < cols) cells.push(null);
  return cells;
}

function term(cols: number, lines: (SelectionBufferLine | undefined)[]): SelectionTextTerminal {
  return { cols, buffer: { active: { getLine: (y) => lines[y] } } };
}

function fullSelection(t: SelectionTextTerminal, rows: number): string {
  return joinedSelectionText(t, { startX: 0, startY: 0, endX: t.cols, endY: rows - 1 });
}

describe("joinedSelectionText", () => {
  it("joins a full-width row to the next even without isWrapped (tmux redraw lost the flag)", () => {
    const t = term(10, [line(cellsOf("0123456789", 10)), line(cellsOf("abc", 10))]);
    expect(fullSelection(t, 2)).toBe("0123456789abc");
  });

  it("joins on isWrapped", () => {
    const t = term(10, [line(cellsOf("0123456789", 10)), line(cellsOf("abc", 10), true)]);
    expect(fullSelection(t, 2)).toBe("0123456789abc");
  });

  it("emits a newline after a short row and right-trims it", () => {
    const t = term(10, [line(cellsOf("abc", 10)), line(cellsOf("def", 10))]);
    expect(fullSelection(t, 2)).toBe("abc\ndef");
  });

  it("clamps start and end columns to the selection", () => {
    const t = term(10, [line(cellsOf("abcdefghij", 10)), line(cellsOf("klmnopqrst", 10))]);
    expect(joinedSelectionText(t, { startX: 2, startY: 0, endX: 4, endY: 1 })).toBe("abcdefghijklmn".slice(2));
  });

  it("returns a plain slice for a single-row selection", () => {
    const t = term(10, [line(cellsOf("abcdef", 10))]);
    expect(joinedSelectionText(t, { startX: 1, startY: 0, endX: 4, endY: 0 })).toBe("bcd");
  });

  it("joins when the wrap lands on a written space in the last column", () => {
    // A greedy wrapper broke between words, so the row's final cell holds a
    // real space (getChars() " ") preceded by text — the row still ran to
    // the edge and continues on the next one.
    const t = term(10, [line(["a", "b", "c", "d", "e", "f", "g", "h", "i", " "]), line(cellsOf("jkl", 10))]);
    expect(fullSelection(t, 2)).toBe("abcdefghi jkl");
  });

  it("does not join a row a program padded to the edge with spaces", () => {
    // Trailing run of written spaces (not text running to the edge) — the
    // newline after it is the program's own.
    const t = term(10, [line(["a", "b", "c", "d", "e", "f", "g", "h", " ", " "]), line(cellsOf("jkl", 10))]);
    expect(fullSelection(t, 2)).toBe("abcdefgh\njkl");
  });

  it("treats a wide-char placeholder in the last column as filled", () => {
    // "ab" + wide char spanning cols 2-3 (placeholder cell contributes "").
    const t = term(4, [line(["a", "b", "宽", ""]), line(cellsOf("cd", 4))]);
    expect(fullSelection(t, 2)).toBe("ab宽cd");
  });

  it("tolerates missing buffer lines", () => {
    const t = term(10, [line(cellsOf("abc", 10)), undefined, line(cellsOf("def", 10))]);
    expect(fullSelection(t, 3)).toBe("abc\ndef");
  });

  it("does not join a hard newline between two short rows selected mid-row", () => {
    const t = term(10, [line(cellsOf("hello", 10)), line(cellsOf("world", 10))]);
    expect(joinedSelectionText(t, { startX: 0, startY: 0, endX: 3, endY: 1 })).toBe("hello\nwor");
  });

  it("does not join ghostty-style short rows whose unwritten tail reads as empty string", () => {
    const t = term(10, [ghosttyLine("abc"), ghosttyLine("def")]);
    expect(fullSelection(t, 2)).toBe("abc\ndef");
  });

  it("joins a ghostty-style full-width row", () => {
    const t = term(10, [ghosttyLine("0123456789"), ghosttyLine("abc")]);
    expect(fullSelection(t, 2)).toBe("0123456789abc");
  });
});

describe("unwrapParagraphs", () => {
  it("joins a renderer's own word-wrap and drops the continuation indent", () => {
    // The reported case: Claude Code (Ink) wrapped a numbered list item and
    // indented the continuation by two spaces, so the break is a real "\n"
    // that joinedSelectionText correctly refuses to join.
    const text = [
      "2. The pane's stored size and the client's differ across the same resize. The visible",
      "  screen looks fine because the foreground program redraws itself.",
    ].join("\n");
    expect(unwrapParagraphs(text)).toBe(
      "2. The pane's stored size and the client's differ across the same resize. The visible screen looks fine because the foreground program redraws itself.",
    );
  });

  it("keeps consecutive bullets apart", () => {
    expect(unwrapParagraphs("- alpha\n- beta\n* gamma\n+ delta\n• epsilon")).toBe(
      "- alpha\n- beta\n* gamma\n+ delta\n• epsilon",
    );
  });

  it("keeps consecutive numbered items apart", () => {
    expect(unwrapParagraphs("1. one\n2. two\n3) three")).toBe("1. one\n2. two\n3) three");
  });

  it("joins a bullet's own wrapped continuation into it", () => {
    expect(unwrapParagraphs("- a bullet that ran on\n  and continued here\n- next")).toBe(
      "- a bullet that ran on and continued here\n- next",
    );
  });

  it("preserves blank lines as paragraph separators", () => {
    expect(unwrapParagraphs("first para line one\nline two\n\nsecond para")).toBe(
      "first para line one line two\n\nsecond para",
    );
  });

  it("keeps the first line's own indent", () => {
    expect(unwrapParagraphs("    indented start\n    continuation")).toBe("    indented start continuation");
  });

  it("is idempotent", () => {
    const text = "- a bullet that ran on\n  and continued here\n\ntrailing para\nwrapped";
    const once = unwrapParagraphs(text);
    expect(unwrapParagraphs(once)).toBe(once);
  });

  it("collapses a code block — the documented lossy case", () => {
    // Paragraph mode is never the default precisely because of this: it has
    // no way to tell prose from code, so code is chosen per copy or not at all.
    expect(unwrapParagraphs("const a = 1;\nconst b = 2;")).toBe("const a = 1; const b = 2;");
  });

  it("returns empty text unchanged", () => {
    expect(unwrapParagraphs("")).toBe("");
  });
});

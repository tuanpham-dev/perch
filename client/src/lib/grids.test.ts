import { describe, expect, it } from "vitest";
import type { TerminalSession } from "../types";
import {
  addCell,
  adjacentCellId,
  cellPlacements,
  directionalCellId,
  evenTracks,
  fitTracks,
  neighborAfterRemoval,
  nextGridName,
  parseStoredGrids,
  reconcileGridCells,
  removeCell,
  setTracks,
  swapCells,
  tiledShape,
  toggleZoom,
  type Grid,
  type GridCell,
} from "./grids";

function cell(i: number, session = "s"): GridCell {
  return { id: `c${i}`, sessionName: session, windowIndex: i, attachName: `@w${i}` };
}

function gridOf(n: number): Grid {
  let g: Grid = { id: "g", projectKey: "~/p", name: "Grid", cells: [], colSizes: [], rowSizes: [], zoomedCellId: null };
  for (let i = 0; i < n; i++) g = addCell(g, cell(i));
  return g;
}

describe("tiledShape", () => {
  it("matches tmux tiled for 1..9", () => {
    const shapes = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => {
      const { cols, rows } = tiledShape(n);
      return `${cols}x${rows}`;
    });
    expect(shapes).toEqual(["1x1", "2x1", "2x2", "2x2", "3x2", "3x2", "3x3", "3x3", "3x3"]);
  });
});

describe("cellPlacements", () => {
  it("fills row-major and spans the last cell of a partial row", () => {
    expect(cellPlacements(3)[2]).toEqual({ col: 0, row: 1, colSpan: 2 });
    expect(cellPlacements(5)[4]).toEqual({ col: 1, row: 1, colSpan: 2 });
    expect(cellPlacements(4)[3]).toEqual({ col: 1, row: 1, colSpan: 1 });
    expect(cellPlacements(1)).toEqual([{ col: 0, row: 0, colSpan: 1 }]);
  });
});

describe("fitTracks", () => {
  it("appends the mean and drops trailing tracks", () => {
    expect(fitTracks([2, 1], 3)).toEqual([2, 1, 1.5]);
    expect(fitTracks([2, 1, 1.5], 2)).toEqual([2, 1]);
    expect(fitTracks([], 2)).toEqual([1, 1]);
  });
  it("returns the same reference when the length matches", () => {
    const s = [1, 2];
    expect(fitTracks(s, 2)).toBe(s);
  });
});

describe("addCell / removeCell", () => {
  it("keeps adjusted column ratios when the column count grows", () => {
    let g = gridOf(4);
    g = setTracks(g, "col", [3, 1]);
    g = addCell(g, cell(4));
    expect(g.colSizes).toEqual([3, 1, 2]);
    expect(g.rowSizes).toEqual([1, 1]);
  });
  it("ignores a window already in the grid", () => {
    const g = gridOf(2);
    expect(addCell(g, { ...cell(1), id: "other" })).toBe(g);
  });
  it("clears zoom on add and remove", () => {
    let g = toggleZoom(gridOf(2), "c0");
    expect(g.zoomedCellId).toBe("c0");
    expect(addCell(g, cell(5)).zoomedCellId).toBeNull();
    expect(removeCell(g, "c1").zoomedCellId).toBeNull();
  });
  it("can remove down to zero cells", () => {
    expect(removeCell(gridOf(1), "c0").cells).toEqual([]);
  });
  it("returns the same reference for an unknown id", () => {
    const g = gridOf(2);
    expect(removeCell(g, "nope")).toBe(g);
  });
});

describe("swapCells", () => {
  it("swaps positions", () => {
    const g = swapCells(gridOf(3), "c0", "c2");
    expect(g.cells.map((c) => c.id)).toEqual(["c2", "c1", "c0"]);
  });
  it("is a no-op for unknown or equal ids", () => {
    const g = gridOf(2);
    expect(swapCells(g, "c0", "c0")).toBe(g);
    expect(swapCells(g, "c0", "x")).toBe(g);
  });
});

describe("setTracks", () => {
  it("rejects a wrong length or non-positive sizes", () => {
    const g = gridOf(4);
    expect(setTracks(g, "col", [1, 1, 1])).toBe(g);
    expect(setTracks(g, "row", [1, 0])).toBe(g);
    expect(setTracks(g, "row", [2, 1]).rowSizes).toEqual([2, 1]);
  });
});

describe("toggleZoom", () => {
  it("round-trips and ignores unknown cells", () => {
    const g = gridOf(2);
    const z = toggleZoom(g, "c1");
    expect(z.zoomedCellId).toBe("c1");
    expect(toggleZoom(z, "c1").zoomedCellId).toBeNull();
    expect(toggleZoom(g, "x")).toBe(g);
  });
});

describe("nextGridName", () => {
  it("picks the lowest free name", () => {
    expect(nextGridName([])).toBe("Grid");
    expect(nextGridName(["Grid", "Grid 3"])).toBe("Grid 2");
  });
});

describe("adjacentCellId / neighborAfterRemoval", () => {
  it("wraps row-major", () => {
    const g = gridOf(3);
    expect(adjacentCellId(g, "c2", 1)).toBe("c0");
    expect(adjacentCellId(g, "c0", -1)).toBe("c2");
    expect(adjacentCellId(g, undefined, 1)).toBe("c0");
  });
  it("prefers the next cell, else the previous", () => {
    const g = gridOf(3);
    expect(neighborAfterRemoval(g, "c1")).toBe("c2");
    expect(neighborAfterRemoval(g, "c2")).toBe("c1");
  });
});

describe("reconcileGridCells", () => {
  const session = (windows: { id: string; index: number }[], name = "s", id = "sid"): TerminalSession => ({
    id,
    name,
    created: 0,
    attached: 0,
    path: "~/p",
    windows: windows.map((w) => ({ ...w, name: "zsh", active: false, cwd: "~/p", activity: false, command: "zsh" })),
  });

  const seen = (g: Grid): Grid => ({
    ...g,
    cells: g.cells.map((c) => ({ ...c, sessionId: "sid", windowId: `w${c.windowIndex}` })),
  });

  it("keeps a cell no poll has matched yet", () => {
    const grids = { g: gridOf(1) };
    expect(reconcileGridCells(grids, [])).toBe(grids);
  });

  it("drops a cell whose window is gone and deletes an emptied grid", () => {
    const grids = { g: seen(gridOf(2)), h: { ...seen(gridOf(1)), id: "h" } };
    const next = reconcileGridCells(grids, [session([{ id: "w0", index: 0 }])]);
    expect(next.g.cells.map((c) => c.id)).toEqual(["c0"]);
    expect(next.g.colSizes).toEqual([1]);
    expect(next.h.cells.map((c) => c.id)).toEqual(["c0"]);
    const gone = reconcileGridCells({ g: seen(gridOf(1)) }, []);
    expect(gone).toEqual({});
  });

  it("follows a session rename by id and keeps the reference when stable", () => {
    const first = reconcileGridCells({ g: gridOf(1) }, [session([{ id: "w0", index: 0 }])]);
    expect(first.g.cells[0].sessionId).toBe("sid");
    const renamed = reconcileGridCells(first, [session([{ id: "w0", index: 0 }], "renamed")]);
    expect(renamed.g.cells[0].sessionName).toBe("renamed");
    expect(reconcileGridCells(renamed, [session([{ id: "w0", index: 0 }], "renamed")])).toBe(renamed);
  });
});

describe("parseStoredGrids", () => {
  it("rejects garbage", () => {
    expect(parseStoredGrids(null)).toEqual({});
    expect(parseStoredGrids([])).toEqual({});
    expect(parseStoredGrids({ g: { id: "g" } })).toEqual({});
    expect(parseStoredGrids({ g: { ...gridOf(1), cells: [] } })).toEqual({});
  });
  it("keeps a valid grid and refits mismatched tracks", () => {
    const g = gridOf(5);
    expect(parseStoredGrids({ g })).toEqual({ g });
    const bad = parseStoredGrids({ g: { ...g, colSizes: [1], zoomedCellId: "missing" } });
    expect(bad.g.colSizes).toEqual(evenTracks(3));
    expect(bad.g.zoomedCellId).toBeNull();
  });
});

describe("directionalCellId", () => {
  // 5 cells: row 0 = c0 c1 c2, row 1 = c3, c4 (c4 spans columns 1-2)
  const g = gridOf(5);
  it("moves within a row and wraps", () => {
    expect(directionalCellId(g, "c0", "right")).toBe("c1");
    expect(directionalCellId(g, "c2", "right")).toBe("c0");
    expect(directionalCellId(g, "c0", "left")).toBe("c2");
    expect(directionalCellId(g, "c4", "left")).toBe("c3");
  });
  it("moves between rows by column, through a spanning cell", () => {
    expect(directionalCellId(g, "c2", "down")).toBe("c4");
    expect(directionalCellId(g, "c1", "down")).toBe("c4");
    expect(directionalCellId(g, "c4", "up")).toBe("c1");
    expect(directionalCellId(g, "c0", "up")).toBe("c3");
    expect(directionalCellId(g, "c3", "down")).toBe("c0");
  });
  it("has nowhere to go in a single row or single cell", () => {
    expect(directionalCellId(gridOf(2), "c0", "down")).toBeUndefined();
    expect(directionalCellId(gridOf(1), "c0", "left")).toBeUndefined();
  });
  it("stacked: only up/down move", () => {
    expect(directionalCellId(g, "c1", "down", true)).toBe("c2");
    expect(directionalCellId(g, "c0", "up", true)).toBe("c4");
    expect(directionalCellId(g, "c1", "right", true)).toBeUndefined();
  });
});

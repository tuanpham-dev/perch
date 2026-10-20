// Pure model for project grid tabs (plans/project-grid-tab.md): several of
// one project's terminal windows tiled inside a single tab, tmux "tiled"
// style, with shared column/row tracks. No React, no DOM — useTabs owns the
// state, useGrids mutates it through these functions, GridView renders it.

import type { TerminalSession } from "../types";
import { tabStorage } from "./detachedWindows";

// One terminal window shown in a grid. `attachName` is what the cell's
// TerminalView attaches to — the same "@<windowId>" name a window tab gets
// from api.openWindowTab, which the server treats as stateless, so any number
// of views (linked grid copies, a window tab elsewhere) may share it.
export interface GridCell {
  id: string;
  sessionName: string;
  windowIndex: number;
  attachName: string;
  // Stable ids, resolved from the session poll — let a cell survive an
  // out-of-band rename/renumber, mirroring Tab's own sessionId/windowId.
  sessionId?: string;
  windowId?: string;
  // Added by a managed grid's provider (see reconcileManagedGrid) — the
  // provider may take it away again. A cell the user added, or moved in
  // over a provider cell, never has it.
  byProvider?: boolean;
}

// A grid may hold windows of any project, and is shared by every tab whose
// Tab.gridId points at it — split copies are linked, so cells, tracks and
// zoom are grid state, not tab state. Which chip its tab sits in is derived
// from its cells (gridChipKey), never stored.
export interface Grid {
  id: string;
  // The project the grid was created in (useTabs' projectKeyForSession):
  // its default-name scope, and where Add Terminal goes with no cells to
  // follow. Empty for a managed grid.
  projectKey: string;
  name: string;
  cells: GridCell[];
  // Flex weights (CSS fr), one per column / row — only ratios matter.
  colSizes: number[];
  rowSizes: number[];
  zoomedCellId: string | null;
  // Set on a grid an extension manages (ctx.registerManagedGrid): the
  // provider's namespaced id. A managed grid survives having no cells.
  providerId?: string;
  // Managed grids: wanted windows the user closed or popped out, kept out
  // until they leave the provider's list (spec R14).
  hiddenWindowIds?: string[];
}

export const GRIDS_STORAGE_KEY = "grids";

// tmux's tiled layout: a near-square grid, filled row-major.
export function tiledShape(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  const cols = Math.ceil(Math.sqrt(n));
  return { cols, rows: Math.ceil(n / cols) };
}

// 0-based placement of each of `n` cells. The last cell of a partial final
// row spans the remaining columns, so the grid never shows an empty slot.
export function cellPlacements(n: number): { col: number; row: number; colSpan: number }[] {
  const { cols } = tiledShape(n);
  const out: { col: number; row: number; colSpan: number }[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const colSpan = i === n - 1 ? cols - col : 1;
    out.push({ col, row, colSpan });
  }
  return out;
}

export function evenTracks(count: number): number[] {
  return Array.from({ length: count }, () => 1);
}

// Resizes a track list to `count` while keeping the kept tracks' ratios: a
// new track gets the mean share, a removed one (always trailing) is dropped.
// Same reference when the length already matches.
export function fitTracks(sizes: number[], count: number): number[] {
  if (sizes.length === count) return sizes;
  if (count < sizes.length) return sizes.slice(0, count);
  const mean = sizes.length > 0 ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 1;
  return [...sizes, ...Array.from({ length: count - sizes.length }, () => mean)];
}

function refit(grid: Grid, cells: GridCell[]): Grid {
  const { cols, rows } = tiledShape(cells.length);
  return {
    ...grid,
    cells,
    colSizes: fitTracks(grid.colSizes, cols),
    rowSizes: fitTracks(grid.rowSizes, rows),
    zoomedCellId: null,
  };
}

// The distinct projects of a grid's cells, in cell order.
export function gridProjectKeys(grid: Grid, keyForSession: (sessionName: string) => string): string[] {
  return [...new Set(grid.cells.map((c) => keyForSession(c.sessionName)))];
}

// The chip a grid tab belongs in: its one project, or null — outside chips —
// when its cells span several projects or an extension manages it. A grid
// with no cells keeps its home project.
export function gridChipKey(grid: Grid, keyForSession: (sessionName: string) => string): string | null {
  if (grid.providerId !== undefined) return null;
  const keys = gridProjectKeys(grid, keyForSession);
  if (keys.length === 0) return grid.projectKey;
  return keys.length === 1 ? keys[0] : null;
}

export function hasWindow(grid: Grid, sessionName: string, windowIndex: number): GridCell | undefined {
  return grid.cells.find((c) => c.sessionName === sessionName && c.windowIndex === windowIndex);
}

// Appends a cell (a window appears at most once per grid — same reference
// when it's already there). Any add clears zoom.
export function addCell(grid: Grid, cell: GridCell): Grid {
  if (hasWindow(grid, cell.sessionName, cell.windowIndex)) return grid;
  return refit(grid, [...grid.cells, cell]);
}

export function removeCell(grid: Grid, cellId: string): Grid {
  if (!grid.cells.some((c) => c.id === cellId)) return grid;
  return refit(
    grid,
    grid.cells.filter((c) => c.id !== cellId),
  );
}

export function swapCells(grid: Grid, aId: string, bId: string): Grid {
  if (aId === bId) return grid;
  const a = grid.cells.findIndex((c) => c.id === aId);
  const b = grid.cells.findIndex((c) => c.id === bId);
  if (a === -1 || b === -1) return grid;
  const cells = [...grid.cells];
  [cells[a], cells[b]] = [cells[b], cells[a]];
  return { ...grid, cells };
}

function validSizes(sizes: unknown, length: number): sizes is number[] {
  return (
    Array.isArray(sizes) &&
    sizes.length === length &&
    sizes.every((s) => typeof s === "number" && Number.isFinite(s) && s > 0)
  );
}

export function setTracks(grid: Grid, axis: "col" | "row", sizes: number[]): Grid {
  const current = axis === "col" ? grid.colSizes : grid.rowSizes;
  if (!validSizes(sizes, current.length)) return grid;
  return axis === "col" ? { ...grid, colSizes: sizes } : { ...grid, rowSizes: sizes };
}

export function toggleZoom(grid: Grid, cellId: string): Grid {
  if (!grid.cells.some((c) => c.id === cellId)) return grid;
  return { ...grid, zoomedCellId: grid.zoomedCellId === cellId ? null : cellId };
}

export function nextGridName(existing: string[]): string {
  const taken = new Set(existing);
  if (!taken.has("Grid")) return "Grid";
  for (let n = 2; ; n++) {
    if (!taken.has(`Grid ${n}`)) return `Grid ${n}`;
  }
}

// Row-major neighbor of `cellId`, wrapping — Grid: Focus Next/Previous Cell.
export function adjacentCellId(grid: Grid, cellId: string | undefined, delta: 1 | -1): string | undefined {
  if (grid.cells.length === 0) return undefined;
  const idx = grid.cells.findIndex((c) => c.id === cellId);
  if (idx === -1) return grid.cells[0].id;
  return grid.cells[(idx + delta + grid.cells.length) % grid.cells.length].id;
}

export type GridDirection = "left" | "right" | "up" | "down";

// tmux select-pane -L/-R/-U/-D: the cell beside `cellId` in `direction`,
// wrapping at the grid's edge. `stacked` is the phone layout (one column,
// one row per cell), where only up/down move. Left/right stay in the row;
// up/down land on the cell of the next row that covers this cell's first
// column (a spanning last cell covers several). Undefined when there is
// nowhere else to go.
export function directionalCellId(
  grid: Grid,
  cellId: string | undefined,
  direction: GridDirection,
  stacked = false,
): string | undefined {
  const n = grid.cells.length;
  if (n === 0) return undefined;
  const idx = grid.cells.findIndex((c) => c.id === cellId);
  if (idx === -1) return grid.cells[0].id;
  const places = stacked
    ? grid.cells.map((_, i) => ({ col: 0, row: i, colSpan: 1 }))
    : cellPlacements(n);
  const rows = stacked ? n : tiledShape(n).rows;
  const here = places[idx];
  const at = (row: number, col: number) =>
    places.findIndex((p) => p.row === row && col >= p.col && col < p.col + p.colSpan);
  let target = -1;
  if (direction === "left" || direction === "right") {
    const inRow = places
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.row === here.row)
      .sort((a, b) => a.p.col - b.p.col);
    const pos = inRow.findIndex(({ i }) => i === idx);
    const step = direction === "right" ? 1 : -1;
    target = inRow[(pos + step + inRow.length) % inRow.length].i;
  } else {
    const step = direction === "down" ? 1 : -1;
    for (let k = 1; k < rows && target === -1; k++) {
      target = at((here.row + step * k + rows * k) % rows, here.col);
    }
  }
  return target === -1 || target === idx ? undefined : grid.cells[target].id;
}

// The cell that should take focus after `cellId` leaves: the next one, or
// the previous when it was last.
export function neighborAfterRemoval(grid: Grid, cellId: string): string | undefined {
  const idx = grid.cells.findIndex((c) => c.id === cellId);
  if (idx === -1) return grid.cells[0]?.id;
  return (grid.cells[idx + 1] ?? grid.cells[idx - 1])?.id;
}

// Follows out-of-band renames/renumbers by stable id (adopting ids on first
// sight) and drops cells whose window is gone (once a poll has seen them);
// a grid left empty is deleted.
// Same reference when nothing changed.
export function reconcileGridCells(
  grids: Record<string, Grid>,
  sessions: TerminalSession[],
): Record<string, Grid> {
  let changed = false;
  const next: Record<string, Grid> = {};
  for (const [id, grid] of Object.entries(grids)) {
    let gridChanged = false;
    const kept: GridCell[] = [];
    for (const cell of grid.cells) {
      const session = cell.sessionId
        ? sessions.find((s) => s.id === cell.sessionId)
        : ((cell.windowId ? sessions.find((s) => s.windows.some((w) => w.id === cell.windowId)) : undefined) ??
          sessions.find((s) => s.name === cell.sessionName));
      const win = session
        ? cell.windowId
          ? session.windows.find((w) => w.id === cell.windowId)
          : session.windows.find((w) => w.index === cell.windowIndex)
        : undefined;
      if (!session || !win) {
        // A cell never yet matched by a poll (no windowId) is kept: its
        // window may be newer than the poll that produced `sessions`.
        // Its own attach's exit still removes it if the window is truly gone.
        if (!cell.windowId) {
          kept.push(cell);
          continue;
        }
        gridChanged = true;
        continue;
      }
      if (
        cell.sessionId === session.id &&
        cell.windowId === win.id &&
        cell.sessionName === session.name &&
        cell.windowIndex === win.index
      ) {
        kept.push(cell);
        continue;
      }
      gridChanged = true;
      kept.push({ ...cell, sessionId: session.id, windowId: win.id, sessionName: session.name, windowIndex: win.index });
    }
    if (!gridChanged) {
      next[id] = grid;
      continue;
    }
    changed = true;
    if (kept.length === 0 && grid.providerId === undefined) continue;
    // Removing cells refits tracks; renames alone keep the grid's layout.
    next[id] =
      kept.length === grid.cells.length
        ? { ...grid, cells: kept }
        : refit(grid, kept);
  }
  return changed ? next : grids;
}

function isValidCell(c: unknown): c is GridCell {
  if (typeof c !== "object" || c === null) return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.sessionName === "string" &&
    typeof o.attachName === "string" &&
    typeof o.windowIndex === "number" &&
    Number.isInteger(o.windowIndex) &&
    (o.sessionId === undefined || typeof o.sessionId === "string") &&
    (o.windowId === undefined || typeof o.windowId === "string") &&
    (o.byProvider === undefined || typeof o.byProvider === "boolean")
  );
}

// Validates a JSON value restored from storage — never throws; malformed
// grids are dropped, mismatched track lengths are re-fit.
export function parseStoredGrids(json: unknown): Record<string, Grid> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return {};
  const out: Record<string, Grid> = {};
  for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const g = value as Record<string, unknown>;
    if (g.id !== key || typeof g.projectKey !== "string" || typeof g.name !== "string") continue;
    const providerId = typeof g.providerId === "string" ? g.providerId : undefined;
    if (!Array.isArray(g.cells) || !g.cells.every(isValidCell)) continue;
    if (g.cells.length === 0 && providerId === undefined) continue;
    const cells = g.cells as GridCell[];
    const { cols, rows } = tiledShape(cells.length);
    const zoomed =
      typeof g.zoomedCellId === "string" && cells.some((c) => c.id === g.zoomedCellId) ? g.zoomedCellId : null;
    out[key] = {
      id: key,
      projectKey: g.projectKey,
      name: g.name,
      cells,
      colSizes: validSizes(g.colSizes, cols) ? g.colSizes : evenTracks(cols),
      rowSizes: validSizes(g.rowSizes, rows) ? g.rowSizes : evenTracks(rows),
      zoomedCellId: zoomed,
      ...(providerId !== undefined
        ? {
            providerId,
            hiddenWindowIds: Array.isArray(g.hiddenWindowIds)
              ? g.hiddenWindowIds.filter((w): w is string => typeof w === "string")
              : [],
          }
        : {}),
    };
  }
  return out;
}

export function loadStoredGrids(): Record<string, Grid> {
  try {
    return parseStoredGrids(JSON.parse(tabStorage().getItem(GRIDS_STORAGE_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

// One window a managed grid's provider wants shown (ctx.registerManagedGrid's
// setWindows). icon / iconUrl are the window's mark in its cell header.
export interface ManagedGridWindow {
  windowId: string;
  sessionName: string;
  windowIndex: number;
  icon?: string;
  iconUrl?: string;
}

// Folds a provider's wanted list into its grid (spec R13, R14): provider
// cells whose window left the list go, a hidden window that left the list is
// forgotten (so it comes back next time), provider cells follow the list's
// session names and indexes, and wanted windows not yet shown are appended in
// list order. Only windows in `knownWindowIds` (the client's own session
// poll) are added, so reconcileGridCells never drops a cell the poll has not
// caught up with yet. User cells are never touched. Same reference when
// nothing changed.
export function reconcileManagedGrid(
  grid: Grid,
  wanted: ManagedGridWindow[],
  knownWindowIds: ReadonlySet<string>,
  mintId: () => string,
): Grid {
  const byId = new Map(wanted.map((w) => [w.windowId, w]));
  let changed = false;
  const cells: GridCell[] = [];
  for (const cell of grid.cells) {
    if (!cell.byProvider) {
      cells.push(cell);
      continue;
    }
    const w = cell.windowId ? byId.get(cell.windowId) : undefined;
    if (!w) {
      changed = true;
      continue;
    }
    if (w.sessionName !== cell.sessionName || w.windowIndex !== cell.windowIndex) {
      changed = true;
      cells.push({ ...cell, sessionName: w.sessionName, windowIndex: w.windowIndex });
    } else cells.push(cell);
  }
  const prevHidden = grid.hiddenWindowIds ?? [];
  const hidden = prevHidden.filter((id) => byId.has(id));
  if (hidden.length !== prevHidden.length) changed = true;
  const hiddenSet = new Set(hidden);
  const removedCount = grid.cells.length - cells.length;
  let added = 0;
  for (const w of wanted) {
    if (hiddenSet.has(w.windowId) || !knownWindowIds.has(w.windowId)) continue;
    if (cells.some((c) => c.windowId === w.windowId || (c.sessionName === w.sessionName && c.windowIndex === w.windowIndex)))
      continue;
    cells.push({
      id: mintId(),
      sessionName: w.sessionName,
      windowIndex: w.windowIndex,
      windowId: w.windowId,
      attachName: `@${w.windowId}`,
      byProvider: true,
    });
    added++;
  }
  if (!changed && added === 0) return grid;
  const next = { ...grid, hiddenWindowIds: hidden };
  return removedCount > 0 || added > 0 ? refit(next, cells) : { ...next, cells };
}

// Close / pop out on a provider cell keeps its window out of the grid while
// the provider still wants it (spec R14). No-op for a user cell.
export function hideCellWindow(grid: Grid, cellId: string): Grid {
  const cell = grid.cells.find((c) => c.id === cellId);
  if (!cell?.byProvider || !cell.windowId || grid.providerId === undefined) return grid;
  const hidden = grid.hiddenWindowIds ?? [];
  if (hidden.includes(cell.windowId)) return grid;
  return { ...grid, hiddenWindowIds: [...hidden, cell.windowId] };
}

// A window the user moves into a grid where the provider already shows it
// becomes the user's: the provider never removes it.
export function adoptCell(grid: Grid, cellId: string): Grid {
  const cell = grid.cells.find((c) => c.id === cellId);
  if (!cell?.byProvider) return grid;
  return { ...grid, cells: grid.cells.map((c) => (c.id === cellId ? { ...c, byProvider: false } : c)) };
}

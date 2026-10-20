import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getManagedGrid, getManagedGridWindow, getWindowDecorations, useExtensionRegistryVersion } from "../extensions";
import { cellPlacements, evenTracks, type Grid } from "../lib/grids";
import type { Keybinding } from "../keybindings";
import type { AppSettings } from "../settings";
import type { TerminalTheme } from "../engines/types";
import type { MenuItem, TerminalSession } from "../types";
import Icon from "./Icon";
import TerminalView from "./TerminalView";

// The props every cell's TerminalView shares, passed through untouched.
export interface GridTerminalProps {
  settings: AppSettings;
  theme: TerminalTheme | null;
  fontsVersion: number;
  bindings: Record<string, Keybinding[]>;
  onError: (err: unknown) => void;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onOpenFileSecondary?: (path: string, line?: number) => void;
  onPreviewFile?: (path: string) => void;
  isPreviewable?: (path: string) => boolean;
  onWindowSwitch: (sessionName: string, windowIndex: number) => void;
  onSessionSwitch?: (session: string, windowIndex: number) => void;
}

interface Props {
  grid: Grid;
  focusedCellId: string | undefined;
  // The grid tab is the shown tab of its pane.
  visible: boolean;
  // ...and its pane holds keyboard focus (see App's `focused`).
  focused: boolean;
  sessions: TerminalSession[];
  // A cell's title is `project · window` in every grid (spec R6).
  projectLabelForSession: (sessionName: string) => string;
  onFocusCell: (cellId: string) => void;
  onCloseCell: (cellId: string) => void;
  onPopOutCell: (cellId: string) => void;
  onToggleZoom: (cellId: string) => void;
  onSwapCells: (a: string, b: string) => void;
  onSetTracks: (axis: "col" | "row", sizes: number[]) => void;
  onCellExit: (cellId: string) => void;
  // A cell printed while not on screen (TerminalView's own throttled
  // callback) — what gives a hidden grid tab its activity dot (spec R16).
  onOutput: () => void;
  terminal: GridTerminalProps;
}

// The app's phone breakpoint (styles.css's own `max-width: 640px` block):
// cells stack in one column there, without sashes or header drag (spec R10).
export const PHONE_MQ = "(max-width: 640px)";
const MIN_TRACK_FRACTION = 0.05;
const DRAG_THRESHOLD_PX = 6;

function cumulative(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  const out: number[] = [];
  let acc = 0;
  for (const s of sizes) {
    acc += s;
    out.push(acc / total);
  }
  return out;
}

// One project grid (plans/project-grid-tab.md): a single CSS grid whose
// children are keyed by cell id and only ever restyled — adding, removing,
// swapping, zooming and resizing never change a surviving cell's position in
// the React tree, so its terminal never remounts. Sashes are overlays, not
// grid children, for the same reason.
export default function GridView({
  grid,
  focusedCellId,
  visible,
  focused,
  sessions,
  projectLabelForSession,
  onFocusCell,
  onCloseCell,
  onPopOutCell,
  onToggleZoom,
  onSwapCells,
  onSetTracks,
  onCellExit,
  onOutput,
  terminal,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Re-render when a decoration provider refresh()es or a managed grid's
  // window marks change — both are read from the registry per render.
  useExtensionRegistryVersion();
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_MQ).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_MQ);
    const onChange = () => setPhone(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const [swap, setSwap] = useState<{ from: string; over: string | null } | null>(null);
  const swapRef = useRef<{ from: string; startX: number; startY: number; active: boolean; pointerId: number } | null>(
    null,
  );
  const [sashDrag, setSashDrag] = useState<string | null>(null);

  const n = grid.cells.length;
  const zoomed = grid.zoomedCellId;
  const placements = phone
    ? grid.cells.map((_, i) => ({ col: 0, row: i, colSpan: 1 }))
    : cellPlacements(n);
  const colTemplate = phone ? "1fr" : grid.colSizes.map((s) => `${s}fr`).join(" ");
  const rowTemplate = phone ? `repeat(${n}, 1fr)` : grid.rowSizes.map((s) => `${s}fr`).join(" ");

  // Escape cancels a header drag.
  useEffect(() => {
    if (!swap) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      swapRef.current = null;
      setSwap(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [swap]);

  const cellIdAt = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(".grid-cell");
    if (!el || !rootRef.current?.contains(el)) return null;
    return el.dataset.cellId ?? null;
  };

  const onHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>, cellId: string) => {
    if (phone || zoomed || n < 2 || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    swapRef.current = { from: cellId, startX: e.clientX, startY: e.clientY, active: false, pointerId: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHeaderPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = swapRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    if (!s.active) {
      if (Math.hypot(e.clientX - s.startX, e.clientY - s.startY) < DRAG_THRESHOLD_PX) return;
      s.active = true;
    }
    const over = cellIdAt(e.clientX, e.clientY);
    setSwap({ from: s.from, over: over && over !== s.from ? over : null });
  };
  const onHeaderPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = swapRef.current;
    swapRef.current = null;
    setSwap(null);
    if (!s || !s.active || s.pointerId !== e.pointerId) return;
    const over = cellIdAt(e.clientX, e.clientY);
    if (over && over !== s.from) onSwapCells(s.from, over);
  };
  const onHeaderPointerCancel = () => {
    swapRef.current = null;
    setSwap(null);
  };

  const startSash = (e: ReactPointerEvent<HTMLDivElement>, axis: "col" | "row", i: number) => {
    if (e.button !== 0) return;
    const root = rootRef.current;
    if (!root) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = root.getBoundingClientRect();
    const start = axis === "col" ? [...grid.colSizes] : [...grid.rowSizes];
    const total = start.reduce((a, b) => a + b, 0);
    const extent = axis === "col" ? rect.width : rect.height;
    const origin = axis === "col" ? e.clientX : e.clientY;
    const min = total * MIN_TRACK_FRACTION;
    const key = `${axis}-${i}`;
    setSashDrag(key);
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      if (extent <= 0) return;
      const pos = axis === "col" ? ev.clientX : ev.clientY;
      const pair = start[i] + start[i + 1];
      const a = Math.min(Math.max(start[i] + ((pos - origin) / extent) * total, min), pair - min);
      const next = [...start];
      next[i] = a;
      next[i + 1] = pair - a;
      onSetTracks(axis, next);
    };
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      setSashDrag(null);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  // Sash overlays at each interior track boundary. A column boundary that
  // the last row's spanning cell covers stops at that row's top edge.
  const sashes: React.ReactNode[] = [];
  if (!phone && !zoomed && n > 1) {
    const colEdges = cumulative(grid.colSizes);
    const rowEdges = cumulative(grid.rowSizes);
    const cols = grid.colSizes.length;
    const lastStartCol = (n - 1) % cols;
    const lastRowTop = rowEdges.length > 1 ? rowEdges[rowEdges.length - 2] : 0;
    for (let i = 0; i < cols - 1; i++) {
      const coveredInLastRow = n % cols !== 0 && i >= lastStartCol;
      const bottom = coveredInLastRow ? `${(1 - lastRowTop) * 100}%` : "0";
      sashes.push(
        <div
          key={`col-${i}`}
          className={`grid-sash grid-sash-col${sashDrag === `col-${i}` ? " dragging" : ""}`}
          style={{ left: `calc(${colEdges[i] * 100}% - 2px)`, top: 0, bottom }}
          onPointerDown={(e) => startSash(e, "col", i)}
          onDoubleClick={() => onSetTracks("col", evenTracks(cols))}
        />,
      );
    }
    for (let i = 0; i < grid.rowSizes.length - 1; i++) {
      sashes.push(
        <div
          key={`row-${i}`}
          className={`grid-sash grid-sash-row${sashDrag === `row-${i}` ? " dragging" : ""}`}
          style={{ top: `calc(${rowEdges[i] * 100}% - 2px)`, left: 0, right: 0 }}
          onPointerDown={(e) => startSash(e, "row", i)}
          onDoubleClick={() => onSetTracks("row", evenTracks(grid.rowSizes.length))}
        />,
      );
    }
  }

  return (
    <div
      ref={rootRef}
      className={`grid-view${sashDrag ? " resizing" : ""}${swap ? " swapping" : ""}`}
      style={{ gridTemplateColumns: colTemplate, gridTemplateRows: rowTemplate }}
    >
      {grid.cells.map((cell, i) => {
        const p = placements[i];
        const isZoomed = zoomed === cell.id;
        const hiddenByZoom = zoomed !== null && !isZoomed;
        const session = sessions.find((s) => s.name === cell.sessionName);
        const win = session?.windows.find((w) => w.index === cell.windowIndex);
        const isFocused = cell.id === focusedCellId;
        const mark = getManagedGridWindow(grid.providerId, cell.windowId);
        const decorationCtx = win
          ? { sessionName: cell.sessionName, windowIndex: cell.windowIndex, cwd: win.cwd, command: win.command }
          : null;
        const classes = [
          "grid-cell",
          isFocused && n > 1 ? "focused" : "",
          swap?.from === cell.id ? "swap-source" : "",
          swap?.over === cell.id ? "swap-target" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div
            key={cell.id}
            data-cell-id={cell.id}
            className={classes}
            style={
              isZoomed
                ? { gridArea: "1 / 1 / -1 / -1" }
                : {
                    gridColumn: `${p.col + 1} / span ${p.colSpan}`,
                    gridRow: `${p.row + 1}`,
                    display: hiddenByZoom ? "none" : undefined,
                  }
            }
            onPointerDownCapture={() => onFocusCell(cell.id)}
          >
            <div
              className={`grid-cell-header${swap?.from === cell.id ? " dragging" : ""}`}
              title={session ? `${session.name}:${cell.windowIndex}` : undefined}
              onPointerDown={(e) => onHeaderPointerDown(e, cell.id)}
              onPointerMove={onHeaderPointerMove}
              onPointerUp={onHeaderPointerUp}
              onPointerCancel={onHeaderPointerCancel}
              onDoubleClick={(e) => {
                if ((e.target as HTMLElement).closest("button")) return;
                onToggleZoom(cell.id);
              }}
            >
              <Icon name="circle-filled" className="grid-cell-focus-icon" />
              {mark?.iconUrl ? (
                <img src={mark.iconUrl} alt="" className="grid-cell-mark" />
              ) : mark?.icon ? (
                <Icon name={mark.icon} className="grid-cell-mark" />
              ) : null}
              <span className="grid-cell-title">
                {projectLabelForSession(cell.sessionName)} · {win?.name ?? `terminal ${cell.windowIndex}`}
              </span>
              {decorationCtx &&
                getWindowDecorations(decorationCtx).map(({ provider, decoration }) => (
                  <button
                    key={provider.id}
                    type="button"
                    className={`window-decoration-badge${decoration.className ? ` ${decoration.className}` : ""}`}
                    title={decoration.tooltip ?? decoration.badge}
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      provider.onClick?.((e.currentTarget as HTMLElement).getBoundingClientRect(), decorationCtx);
                    }}
                  >
                    {decoration.badge}
                  </button>
                ))}
              <span className="grid-cell-spacer" />
              <button
                type="button"
                className={`grid-cell-header-btn${isZoomed ? " active" : ""}`}
                title={isZoomed ? "Restore Grid" : "Zoom Terminal"}
                aria-pressed={isZoomed}
                onClick={() => onToggleZoom(cell.id)}
              >
                <Icon name={isZoomed ? "screen-normal" : "screen-full"} />
              </button>
              <button
                type="button"
                className="grid-cell-header-btn"
                title="Pop Out to Tab"
                onClick={() => onPopOutCell(cell.id)}
              >
                <Icon name="link-external" />
              </button>
              <button
                type="button"
                className="grid-cell-header-btn"
                title="Close (the terminal keeps running)"
                onClick={() => onCloseCell(cell.id)}
              >
                <Icon name="close" />
              </button>
            </div>
            <div className="grid-cell-body">
              <TerminalView
                attachName={cell.attachName}
                visible={visible && !hiddenByZoom}
                focused={focused && isFocused}
                settings={terminal.settings}
                theme={terminal.theme}
                fontsVersion={terminal.fontsVersion}
                bindings={terminal.bindings}
                onExit={() => onCellExit(cell.id)}
                onError={terminal.onError}
                onOutput={onOutput}
                onWindowSwitch={(windowIndex) => terminal.onWindowSwitch(cell.sessionName, windowIndex)}
                onSessionSwitch={terminal.onSessionSwitch}
                onOpenFile={terminal.onOpenFile}
                onOpenFileSecondary={terminal.onOpenFileSecondary}
                showMenu={terminal.showMenu}
                onPreviewFile={terminal.onPreviewFile}
                isPreviewable={terminal.isPreviewable}
                cwd={win?.cwd}
              />
            </div>
          </div>
        );
      })}
      {sashes}
      {n === 0 && (
        <div className="grid-empty">{getManagedGrid(grid.providerId)?.emptyText || "No terminals in this grid."}</div>
      )}
    </div>
  );
}

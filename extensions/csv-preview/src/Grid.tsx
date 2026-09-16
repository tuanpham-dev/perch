// Presentational cell components plus the pure grid-geometry helpers they
// and client.tsx both need — extracted verbatim from the original
// client/src/components/CsvView.tsx (see extensions/csv-preview's module
// split: this holds everything with no dependency on the main component's
// interactive state).
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import Icon from "../../_shared/Icon";
import type { Bounds, CellRange, SortDir } from "./types";

export function getBounds(sel: CellRange, maxRow: number, maxCol: number): Bounds {
  return {
    minRow: Math.max(0, Math.min(sel.anchor.row, sel.focus.row)),
    maxRow: Math.min(maxRow, Math.max(sel.anchor.row, sel.focus.row)),
    minCol: Math.max(0, Math.min(sel.anchor.col, sel.focus.col)),
    maxCol: Math.min(maxCol, Math.max(sel.anchor.col, sel.focus.col)),
  };
}
export function inBounds(row: number, col: number, b: Bounds) {
  return row >= b.minRow && row <= b.maxRow && col >= b.minCol && col <= b.maxCol;
}
export function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Approximate column width from content (char-based estimation).
export function calcColWidths(hdrs: string[], dataRows: string[][]): Record<number, number> {
  const CHAR_W = 7.5;
  const PAD = 40;
  const MIN_W = 60;
  const MAX_W = 320;
  const SAMPLE = Math.min(dataRows.length, 300);
  const result: Record<number, number> = {};
  hdrs.forEach((h, ci) => {
    let maxChars = h.length + 3;
    for (let ri = 0; ri < SAMPLE; ri++) {
      const cell = dataRows[ri]?.[ci] ?? "";
      const len = cell.includes("\n") ? cell.split("\n").reduce((m, l) => Math.max(m, l.length), 0) : cell.length;
      if (len > maxChars) maxChars = len;
    }
    result[ci] = Math.max(MIN_W, Math.min(MAX_W, Math.round(maxChars * CHAR_W + PAD)));
  });
  return result;
}

// ── Editable cell ─────────────────────────────────────────────────────────

export function EditableCell({
  value, rowIdx, colIdx, selStyle, findHighlight, isEditing, draft, showFillHandle,
  onMouseDown, onDoubleClick, onMouseEnter, onDraftChange, onCommitAndMove, onCancel, onFillHandleMouseDown,
}: {
  value: string; rowIdx: number; colIdx: number;
  selStyle: "anchor" | "range" | "fill" | null;
  findHighlight: "current" | "match" | null;
  isEditing: boolean; draft: string; showFillHandle: boolean;
  onMouseDown: (r: number, c: number, e: ReactMouseEvent) => void;
  onDoubleClick: (r: number, c: number) => void;
  onMouseEnter: (r: number, c: number) => void;
  onDraftChange: (v: string) => void;
  onCommitAndMove: (r: number, c: number, v: string, dir: "down" | "right" | "left" | "none") => void;
  onCancel: () => void;
  onFillHandleMouseDown: (e: ReactMouseEvent) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      const len = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(len, len);
    }
  }, [isEditing]);

  const cellClass = [
    "csv-cell",
    selStyle ? `csv-cell-${selStyle}` : "",
    findHighlight ? `csv-cell-find-${findHighlight}` : "",
  ].join(" ").trim();

  return (
    <div className="csv-cell-wrap">
      {isEditing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onBlur={() => onCommitAndMove(rowIdx, colIdx, draft, "none")}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); onCommitAndMove(rowIdx, colIdx, draft, "down"); }
            else if (e.key === "Tab") { e.preventDefault(); onCommitAndMove(rowIdx, colIdx, draft, e.shiftKey ? "left" : "right"); }
            else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          }}
          className="csv-cell-input"
        />
      ) : (
        <div
          onMouseDown={(e) => onMouseDown(rowIdx, colIdx, e)}
          onDoubleClick={() => onDoubleClick(rowIdx, colIdx)}
          onMouseEnter={() => onMouseEnter(rowIdx, colIdx)}
          className={cellClass}
        >
          {value || <span className="csv-cell-empty">-</span>}
        </div>
      )}
      {showFillHandle && !isEditing && (
        <div onMouseDown={onFillHandleMouseDown} className="csv-fill-handle" title="Drag to fill down" />
      )}
    </div>
  );
}

// ── Editable header cell ─────────────────────────────────────────────────

export function EditableHeaderCell({
  value, colIdx, sortDir, isSelected, onSelectColumn, onSort, onRename, onDelete,
}: {
  value: string; colIdx: number; sortDir: SortDir; isSelected: boolean;
  onSelectColumn: (c: number, shift: boolean, ctrl: boolean) => void;
  onSort: (c: number) => void; onRename: (c: number, v: string) => void; onDelete: (c: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  return (
    <div className={`csv-header-cell${isSelected ? " csv-header-cell-selected" : ""}`}>
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { onRename(colIdx, draft); setEditing(false); }}
          onKeyDown={(e) => {
            // Without this, keystrokes bubble to the table's onKeyDown
            // (handleTableKeyDown), which doesn't know about this
            // component's local `editing` state and treats a plain
            // character key as "start editing the selected cell" — moving
            // focus into row 0's cell mid-typing and splitting the typed
            // text between the header and that cell.
            e.stopPropagation();
            if (e.key === "Enter" || e.key === "Tab" || e.key === "Escape") {
              e.preventDefault();
              onRename(colIdx, draft);
              setEditing(false);
            }
          }}
          onClick={(e) => e.stopPropagation()}
          className="csv-header-input"
        />
      ) : (
        <button
          onClick={(e) => onSelectColumn(colIdx, e.shiftKey, e.ctrlKey || e.metaKey)}
          onDoubleClick={(e) => { e.stopPropagation(); setDraft(value); setEditing(true); }}
          title="Click · Shift+Click range · Ctrl+Click multi-select · Double-click rename"
          className="csv-header-label-button"
        >
          <span className="csv-header-label">{value || `col${colIdx + 1}`}</span>
        </button>
      )}
      {!editing && (
        <button
          onClick={(e) => { e.stopPropagation(); onSort(colIdx); }}
          title={sortDir === "asc" ? "Sorted ascending - click for descending" : sortDir === "desc" ? "Sorted descending - click to clear" : "Sort"}
          className="csv-header-sort"
        >
          {/* Base glyph reads as ascending; flipped to point the other way for
              descending — dropped when this was ported from dev-dashboard's
              rotate-180, leaving only a color change with no direction cue. */}
          <Icon name="chevron-down" className={[sortDir ? "csv-sort-active" : "", sortDir === "desc" ? "icon-flip-y" : ""].filter(Boolean).join(" ")} />
        </button>
      )}
      {!editing && (
        <button onClick={() => onDelete(colIdx)} title="Delete column" className="csv-header-delete">
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}

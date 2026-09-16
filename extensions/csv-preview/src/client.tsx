// Ported from client/src/components/CsvView.tsx. Split into modules per the
// plan's "refactor while moving" decision: Grid.tsx (pure geometry helpers +
// EditableCell/EditableHeaderCell), undo.ts (history stack as a hook),
// Toolbar.tsx (the two portaled/inline toolbar JSX blocks) — all extraction
// only, no logic changes. Everything else (state, selection/editing/fill/
// paste/keyboard/context-menu handlers, and the table body) stays here since
// it's all tightly coupled through the same closures and splitting it
// further would mean rewriting behavior, not just relocating it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import Papa from "papaparse";
import "./style.css";
import { fetchFileText, saveFileText } from "../../_shared/fileApi";
import { copyText } from "../../_shared/clipboard";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import type { MenuItem } from "../../_shared/types";
import Icon from "../../_shared/Icon";
import { calcColWidths, EditableCell, EditableHeaderCell, escapeRegex, getBounds, inBounds } from "./Grid";
import { useUndoHistory } from "./undo";
import { CsvFindBar, CsvToolbar } from "./Toolbar";
import type { Bounds, CellPos, CellRange, SortDir } from "./types";

// Set once from activate() — read-through so flipping csv.clickAction in
// Settings applies live (the registered mode below is a thunk, same
// mechanism as markdown-preview's markdown.clickAction).
interface SettingsApi {
  get(key: string): unknown;
}

let extSettings: SettingsApi | null = null;

function readClickAction(): "edit" | "preview" {
  return extSettings?.get("csv.clickAction") === "preview" ? "preview" : "edit";
}

interface Props {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  openInEditor?: (path: string) => void;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  // Reported on every dirty/clean transition so the host's closeTab/
  // closeOtherTabs can confirm before discarding unsaved edits.
  setDirty?: (dirty: boolean) => void;
  // Bumped by the host when an open/preview action re-targets this
  // already-open tab — re-fetch from disk, unless the grid has unsaved
  // edits (never silently clobber them; the toolbar Reload still asks).
  reloadKey?: number;
}

const ROW_HEIGHT = 32;
const VIRT_BUFFER = 25;
const ROW_NUM_MIN_W = 44;
const DEFAULT_COL_W = 120;

const basenameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function CsvView({ filePath, active, toolbarTarget, openInEditor, showMenu, setDirty, reloadKey }: Props) {
  const basename = basenameOf(filePath);

  const [content, setContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [hasHeader, setHasHeader] = useState(true);
  const [delimiter, setDelimiter] = useState("auto");
  const detectedDelimiterRef = useRef(",");

  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [parseWarning, setParseWarning] = useState<string | null>(null);

  const { pushHistory, clearHistory, undo, redo, canUndo, canRedo, dirty, setDirty: setDirtyState } =
    useUndoHistory(rows, headers, setRows, setHeaders);

  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);

  const [selection, setSelection] = useState<CellRange | null>(null);
  const [editingCell, setEditingCell] = useState<CellPos | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const [fillPreviewRow, setFillPreviewRow] = useState<number | null>(null);
  const isDraggingFillRef = useRef(false);
  const fillBoundsRef = useRef<Bounds | null>(null);
  const fillPreviewRowRef = useRef<number | null>(null);
  const isDraggingSelectRef = useRef(false);

  const [showFind, setShowFind] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIdx, setFindIdx] = useState(0);
  const [showReplace, setShowReplace] = useState(false);
  const [replaceQuery, setReplaceQuery] = useState("");
  const [useRegexFind, setUseRegexFind] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);

  const [wordWrap, setWordWrap] = useState(false);

  const [ctrlSelectedCols, setCtrlSelectedCols] = useState<Set<number> | null>(null);
  const [pinnedCols, setPinnedCols] = useState<Set<number>>(new Set());
  const [hiddenCols, setHiddenCols] = useState<Set<number>>(new Set());
  const [showHiddenPanel, setShowHiddenPanel] = useState(false);
  const hiddenPanelRef = useRef<HTMLDivElement>(null);

  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowNumColWRef = useRef(ROW_NUM_MIN_W);

  const [colWidths, setColWidths] = useState<Record<number, number>>({});
  const resizingColRef = useRef<number | null>(null);
  const resizeStartXRef = useRef(0);
  const resizeStartWRef = useRef(0);

  const [formulaBarFocused, setFormulaBarFocused] = useState(false);
  const [formulaBarDraft, setFormulaBarDraft] = useState("");
  const formulaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetchFileText(filePath)
      .then(setContent)
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setDirty?.(dirty);
  }, [dirty, setDirty]);

  // ── Parse ──────────────────────────────────────────────────────────────

  function applyParsed(data: string[][], detectedDelim: string, errMsg: string | null) {
    detectedDelimiterRef.current = detectedDelim || ",";
    setParseWarning(errMsg);
    clearHistory();
    setDirtyState(false);
    if (!data.length) { setHeaders([]); setRows([]); setColWidths({}); return; }
    let newHeaders: string[];
    let newRows: string[][];
    if (hasHeader) {
      newHeaders = data[0].map((h) => h.trim());
      newRows = data.slice(1);
    } else {
      const colCount = Math.max(...data.map((r) => r.length));
      newHeaders = Array.from({ length: colCount }, (_, i) => `col${i + 1}`);
      newRows = data;
    }
    setHeaders(newHeaders);
    setRows(newRows);
    setColWidths(calcColWidths(newHeaders, newRows));
    setPinnedCols(new Set());
    setHiddenCols(new Set());
    setSelection(null);
    setEditingCell(null);
  }

  function parseAndApply(text: string) {
    if (!text.trim()) { setHeaders([]); setRows([]); setParseWarning(null); clearHistory(); setDirtyState(false); return; }
    const result = Papa.parse<string[]>(text, {
      delimiter: delimiter === "auto" ? "" : delimiter,
      skipEmptyLines: true,
      header: false,
    });
    const errs = result.errors.filter((e) => e.type !== "Delimiter");
    applyParsed(result.data as string[][], result.meta.delimiter, errs.length ? errs[0].message : null);
  }

  useEffect(() => {
    if (content === null) return;
    parseAndApply(content);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, hasHeader, delimiter]);

  // Reload discards in-memory edits and re-fetches from disk. Calls
  // parseAndApply directly rather than relying on the effect above:
  // setContent(text) is a no-op re-render when the file on disk is
  // unchanged (same string value, so the effect's dependency array sees no
  // change via Object.is) — but the user's edits still need clearing.
  const [reloading, setReloading] = useState(false);
  async function reloadFromDisk() {
    setReloading(true);
    setLoadError(null);
    try {
      const text = await fetchFileText(filePath);
      setContent(text);
      parseAndApply(text);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setReloading(false);
    }
  }
  async function handleReload() {
    if (dirty && !window.confirm("Discard unsaved changes and reload from disk?")) return;
    await reloadFromDisk();
  }

  // The host bumps reloadKey when an explicit open/preview action lands on
  // this already-open tab — pick up on-disk changes, but never silently
  // clobber unsaved grid edits: while dirty, surface a banner offering the
  // reload instead (a blocking confirm here would ambush an action that
  // didn't mention reload; the banner keeps it opt-in).
  const [showReloadPrompt, setShowReloadPrompt] = useState(false);
  const prevReloadKeyRef = useRef(reloadKey);
  useEffect(() => {
    if (reloadKey === prevReloadKeyRef.current) return;
    prevReloadKeyRef.current = reloadKey;
    if (dirty) {
      setShowReloadPrompt(true);
    } else {
      setShowReloadPrompt(false);
      void reloadFromDisk();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  // Going clean (saved, or undone back to the loaded state) makes the
  // banner's "you have unsaved changes" claim false — drop it.
  useEffect(() => {
    if (!dirty) setShowReloadPrompt(false);
  }, [dirty]);

  // ── Save ───────────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // Original row order — sort (below) is a view-only transform via
      // sortedWithIdx, `rows` itself is never reordered by it, so this
      // never silently rewrites the file just because a sort is active.
      const activeDelimiter = delimiter === "auto" ? detectedDelimiterRef.current : delimiter;
      const csvText = Papa.unparse(hasHeader ? [headers, ...rows] : rows, { delimiter: activeDelimiter });
      await saveFileText(filePath, csvText);
      setDirtyState(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [filePath, hasHeader, headers, rows, delimiter]);

  // ── Sort (view-only) ───────────────────────────────────────────────────

  const sortedWithIdx = useMemo(() => {
    const indexed = rows.map((row, idx) => ({ row, originalIdx: idx }));
    if (sortCol === null || sortDir === null) return indexed;
    return [...indexed].sort((a, b) => {
      const av = a.row[sortCol] ?? "", bv = b.row[sortCol] ?? "";
      const an = parseFloat(av), bn = parseFloat(bv);
      const cmp = !isNaN(an) && !isNaN(bn) ? an - bn : av.localeCompare(bv);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [rows, sortCol, sortDir]);

  const totalRows = sortedWithIdx.length;
  const maxRow = totalRows - 1;
  const maxCol = headers.length - 1;
  const hasData = rows.length > 0 || headers.length > 0;

  function handleSort(col: number) {
    if (sortCol !== col) { setSortCol(col); setSortDir("asc"); return; }
    if (sortDir === "asc") { setSortDir("desc"); return; }
    setSortCol(null); setSortDir(null);
  }

  const selBounds = useMemo(() => (selection ? getBounds(selection, maxRow, maxCol) : null), [selection, maxRow, maxCol]);
  const isMultiSel = selBounds ? selBounds.minRow !== selBounds.maxRow || selBounds.minCol !== selBounds.maxCol : false;

  // ── Find ───────────────────────────────────────────────────────────────

  const regexError = useMemo(() => {
    if (!useRegexFind || !findQuery.trim()) return null;
    try { new RegExp(findQuery); return null; } catch (e) { return (e as Error).message; }
  }, [useRegexFind, findQuery]);

  const findMatches = useMemo<CellPos[]>(() => {
    const q = findQuery.trim();
    if (!q || regexError) return [];
    let test: (val: string) => boolean;
    if (useRegexFind) {
      const re = new RegExp(q, "i");
      test = (val) => re.test(val);
    } else {
      const lq = q.toLowerCase();
      test = (val) => val.toLowerCase().includes(lq);
    }
    const out: CellPos[] = [];
    sortedWithIdx.forEach(({ row }, ri) => row.forEach((val, ci) => { if (test(val)) out.push({ row: ri, col: ci }); }));
    return out;
  }, [findQuery, useRegexFind, regexError, sortedWithIdx]);

  const findMatchSet = useMemo(() => new Set(findMatches.map((m) => `${m.row},${m.col}`)), [findMatches]);
  const safeIdx = findMatches.length ? Math.min(findIdx, findMatches.length - 1) : 0;

  function openFind() { setShowFind(true); setShowReplace(false); setTimeout(() => findInputRef.current?.focus(), 0); }
  function openFindReplace() { setShowFind(true); setShowReplace(true); setTimeout(() => findInputRef.current?.focus(), 0); }
  function closeFind() { setShowFind(false); setShowReplace(false); setFindQuery(""); setFindIdx(0); scrollRef.current?.focus(); }

  function replaceCurrent() {
    if (!findMatches.length || regexError) return;
    const m = findMatches[safeIdx];
    const oi = sortedWithIdx[m.row]?.originalIdx;
    if (oi === undefined) return;
    const cell = sortedWithIdx[m.row]?.row[m.col] ?? "";
    const re = useRegexFind ? new RegExp(findQuery, "gi") : new RegExp(escapeRegex(findQuery), "gi");
    const newVal = cell.replace(re, replaceQuery);
    pushHistory();
    setRows((prev) => prev.map((r, i) => { if (i !== oi) return r; const c = [...r]; c[m.col] = newVal; return c; }));
    setFindIdx((idx) => Math.min(idx, Math.max(0, findMatches.length - 2)));
  }
  function replaceAll() {
    if (!findMatches.length || regexError) return;
    const re = useRegexFind ? new RegExp(findQuery, "gi") : new RegExp(escapeRegex(findQuery), "gi");
    pushHistory();
    setRows((prev) => {
      const next = prev.map((r) => [...r]);
      findMatches.forEach(({ row, col }) => {
        const oi = sortedWithIdx[row]?.originalIdx;
        if (oi === undefined) return;
        next[oi][col] = next[oi][col].replace(re, replaceQuery);
      });
      return next;
    });
    setFindIdx(0);
  }
  function jumpToMatch(idx: number) {
    if (!findMatches.length) return;
    const i = ((idx % findMatches.length) + findMatches.length) % findMatches.length;
    setFindIdx(i);
    const m = findMatches[i];
    setSelection({ anchor: m, focus: m });
    scrollToCell(m.row, m.col);
  }

  // ── Scroll ─────────────────────────────────────────────────────────────

  const scrollToCell = useCallback((row: number, col: number) => {
    const el = scrollRef.current;
    if (!el) return;
    if (wordWrap) {
      // Rows have variable height while wrapped (and virtualization is off,
      // see visStart/visEnd below), so every row is already in the DOM —
      // measure its actual position instead of assuming ROW_HEIGHT.
      const rowEl = el.querySelector<HTMLElement>(`tr[data-row-idx="${row}"]`);
      if (rowEl) {
        const cr = el.getBoundingClientRect(), rr = rowEl.getBoundingClientRect();
        if (rr.top < cr.top) el.scrollTop += rr.top - cr.top;
        else if (rr.bottom > cr.bottom) el.scrollTop += rr.bottom - cr.bottom;
      }
    } else {
      const rowTop = row * ROW_HEIGHT;
      const rowBot = rowTop + ROW_HEIGHT;
      const usableH = el.clientHeight - ROW_HEIGHT;
      if (rowTop < el.scrollTop) el.scrollTop = rowTop;
      else if (rowBot > el.scrollTop + usableH) el.scrollTop = rowBot - usableH;
    }
    const th = el.querySelector<HTMLElement>(`th[data-col-idx="${col}"]`);
    if (th) {
      const cr = el.getBoundingClientRect(), tr = th.getBoundingClientRect();
      if (tr.left - cr.left < rowNumColWRef.current) el.scrollLeft += tr.left - cr.left - rowNumColWRef.current;
      else if (tr.right - cr.left > el.clientWidth) el.scrollLeft += tr.right - cr.left - el.clientWidth;
    }
  }, [wordWrap]);

  const handleScroll = useCallback(() => { if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop); }, []);

  // Virtualization assumes a fixed ROW_HEIGHT, which wrapped rows don't
  // have — render every row (no windowing) while word wrap is on.
  const visStart = wordWrap ? 0 : Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - VIRT_BUFFER);
  const visEnd = wordWrap ? maxRow : Math.min(maxRow, Math.ceil((scrollTop + viewportH) / ROW_HEIGHT) + VIRT_BUFFER);
  const topSpace = wordWrap ? 0 : visStart * ROW_HEIGHT;
  const botSpace = wordWrap ? 0 : Math.max(0, (totalRows - visEnd - 1) * ROW_HEIGHT);

  // ── Selection ──────────────────────────────────────────────────────────

  function setAnchorFocus(anchor: CellPos, focus: CellPos, scroll = true) {
    setSelection({ anchor, focus });
    setEditingCell(null);
    if (scroll) scrollToCell(focus.row, focus.col);
    scrollRef.current?.focus();
  }
  function selectCell(row: number, col: number) { setAnchorFocus({ row, col }, { row, col }); }
  function extendFocus(row: number, col: number) {
    if (!selection) { selectCell(row, col); return; }
    const nr = Math.max(0, Math.min(row, maxRow));
    const nc = Math.max(0, Math.min(col, maxCol));
    setSelection({ anchor: selection.anchor, focus: { row: nr, col: nc } });
    scrollToCell(nr, nc);
  }
  function selectRow(ri: number, shift: boolean) {
    if (shift && selection) setSelection({ anchor: { row: selection.anchor.row, col: 0 }, focus: { row: ri, col: maxCol } });
    else setAnchorFocus({ row: ri, col: 0 }, { row: ri, col: maxCol }, false);
    scrollRef.current?.focus();
  }
  function selectColumn(ci: number, shift: boolean, ctrl = false) {
    if (ctrl) {
      setCtrlSelectedCols((prev) => {
        let next: Set<number>;
        if (prev === null) {
          next = new Set<number>();
          if (selBounds && selBounds.minRow === 0 && selBounds.maxRow === maxRow) {
            for (let c = selBounds.minCol; c <= selBounds.maxCol; c++) next.add(c);
          }
        } else {
          next = new Set(prev);
        }
        next.has(ci) ? next.delete(ci) : next.add(ci);
        return next.size === 0 ? null : next;
      });
      scrollRef.current?.focus();
      return;
    }
    setCtrlSelectedCols(null);
    if (shift && selection) setSelection({ anchor: { row: 0, col: selection.anchor.col }, focus: { row: maxRow, col: ci } });
    else setAnchorFocus({ row: 0, col: ci }, { row: maxRow, col: ci }, false);
    scrollRef.current?.focus();
  }

  function handleCellMouseDown(row: number, col: number, e: ReactMouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    setCtrlSelectedCols(null);
    if (editingCell) commitRange(editDraft);
    if (e.shiftKey && selection) extendFocus(row, col);
    else setAnchorFocus({ row, col }, { row, col });
    isDraggingSelectRef.current = true;
  }
  function handleCellMouseEnter(row: number, col: number) {
    if (isDraggingSelectRef.current && selection) setSelection({ anchor: selection.anchor, focus: { row, col } });
  }

  // ── Editing ────────────────────────────────────────────────────────────

  function startEdit(row: number, col: number, initial?: string) {
    setSelection({ anchor: { row, col }, focus: { row, col } });
    setEditingCell({ row, col });
    setEditDraft(initial !== undefined ? initial : (sortedWithIdx[row]?.row[col] ?? ""));
  }
  function commitRange(val: string) {
    if (!selBounds) return;
    pushHistory();
    setRows((prev) => {
      const next = prev.map((r) => [...r]);
      for (let ri = selBounds.minRow; ri <= selBounds.maxRow; ri++) {
        const oi = sortedWithIdx[ri]?.originalIdx;
        if (oi === undefined) continue;
        for (let ci = selBounds.minCol; ci <= selBounds.maxCol; ci++) next[oi][ci] = val;
      }
      return next;
    });
  }
  function commitAndMove(row: number, col: number, val: string, dir: "down" | "right" | "left" | "none") {
    if (isMultiSel && selBounds) {
      commitRange(val);
    } else {
      const oi = sortedWithIdx[row]?.originalIdx;
      if (oi !== undefined) {
        pushHistory();
        setRows((prev) => prev.map((r, i) => (i === oi ? (() => { const c = [...r]; c[col] = val; return c; })() : r)));
      }
    }
    setEditingCell(null);
    let nr = row, nc = col;
    if (dir === "down") nr = Math.min(row + 1, maxRow);
    else if (dir === "right") { nc = col < maxCol ? col + 1 : nc; if (col === maxCol && row < maxRow) { nr = row + 1; nc = 0; } }
    else if (dir === "left") { nc = col > 0 ? col - 1 : nc; if (col === 0 && row > 0) { nr = row - 1; nc = maxCol; } }
    setSelection({ anchor: { row: nr, col: nc }, focus: { row: nr, col: nc } });
    setTimeout(() => { scrollToCell(nr, nc); scrollRef.current?.focus(); }, 0);
  }
  function cancelEdit() { setEditingCell(null); scrollRef.current?.focus(); }

  function commitFormulaBar() {
    if (!anchorPos || !formulaBarFocused) { setFormulaBarFocused(false); return; }
    const oi = sortedWithIdx[anchorPos.row]?.originalIdx;
    if (oi !== undefined && formulaBarDraft !== anchorValue) {
      pushHistory();
      setRows((prev) => prev.map((r, i) => (i === oi ? (() => { const c = [...r]; c[anchorPos.col] = formulaBarDraft; return c; })() : r)));
    }
    setFormulaBarFocused(false);
    scrollRef.current?.focus();
  }

  // ── Copy / cut / paste ─────────────────────────────────────────────────

  function copyCells(cut = false) {
    if (!selBounds) return;
    const lines: string[] = [];
    for (let ri = selBounds.minRow; ri <= selBounds.maxRow; ri++) {
      const cells: string[] = [];
      for (let ci = selBounds.minCol; ci <= selBounds.maxCol; ci++) cells.push(sortedWithIdx[ri]?.row[ci] ?? "");
      lines.push(cells.join("\t"));
    }
    copyText(lines.join("\n")).catch(() => {});
    if (cut) commitRange("");
  }
  async function pasteCells() {
    if (!selection) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) return;
      const parsed = Papa.parse<string[]>(text, { delimiter: "\t" });
      const pastedRows = parsed.data as string[][];
      if (!pastedRows.length) return;
      pushHistory();
      const startRow = selection.anchor.row, startCol = selection.anchor.col;
      setRows((prev) => {
        const next = prev.map((r) => [...r]);
        pastedRows.forEach((pr, ri) => {
          const tdr = startRow + ri;
          if (tdr > maxRow) return;
          const oi = sortedWithIdx[tdr]?.originalIdx;
          if (oi === undefined) return;
          pr.forEach((val, ci) => { const tc = startCol + ci; if (tc < next[oi].length) next[oi][tc] = val; });
        });
        return next;
      });
    } catch { /* clipboard denied */ }
  }

  // ── Fill handle ────────────────────────────────────────────────────────

  function handleFillHandleMouseDown(e: ReactMouseEvent) {
    e.preventDefault(); e.stopPropagation();
    if (!selBounds) return;
    isDraggingFillRef.current = true;
    fillBoundsRef.current = selBounds;
    fillPreviewRowRef.current = selBounds.maxRow;
    setFillPreviewRow(selBounds.maxRow);
  }
  function getRowFromMouseY(clientY: number, clientX: number): number | null {
    const el = scrollRef.current;
    if (!el) return null;
    if (wordWrap) {
      // Rows aren't a fixed height while wrapped — every row is in the DOM
      // (virtualization is off), so find the one actually under the cursor.
      const rowEl = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("tr[data-row-idx]");
      const idx = rowEl ? Number(rowEl.dataset.rowIdx) : NaN;
      return Number.isNaN(idx) ? null : Math.max(0, Math.min(idx, maxRow));
    }
    const y = clientY - el.getBoundingClientRect().top + el.scrollTop - ROW_HEIGHT;
    return Math.max(0, Math.min(Math.floor(y / ROW_HEIGHT), maxRow));
  }
  function applyFillDown(bounds: Bounds, targetRow: number) {
    const { minRow, maxRow: srcMax, minCol, maxCol: srcMaxCol } = bounds;
    const pattern = sortedWithIdx.slice(minRow, srcMax + 1).map((x) => x.row.slice(minCol, srcMaxCol + 1));
    const patLen = pattern.length;
    pushHistory();
    setRows((prev) => {
      const next = prev.map((r) => [...r]);
      for (let di = srcMax + 1; di <= targetRow; di++) {
        const oi = sortedWithIdx[di]?.originalIdx;
        if (oi === undefined) continue;
        const pr = pattern[(di - srcMax - 1) % patLen];
        for (let ci = minCol; ci <= srcMaxCol; ci++) next[oi][ci] = pr[ci - minCol] ?? "";
      }
      return next;
    });
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!isDraggingFillRef.current) return;
      const ri = getRowFromMouseY(e.clientY, e.clientX);
      if (ri !== null && fillBoundsRef.current && ri > fillBoundsRef.current.maxRow) {
        fillPreviewRowRef.current = ri;
        setFillPreviewRow(ri);
      }
    }
    function onUp() {
      isDraggingSelectRef.current = false;
      if (isDraggingFillRef.current) {
        isDraggingFillRef.current = false;
        const bounds = fillBoundsRef.current;
        const targetRow = fillPreviewRowRef.current;
        if (bounds && targetRow !== null && targetRow > bounds.maxRow) {
          applyFillDown(bounds, targetRow);
          setSelection((sel) => (sel ? { anchor: sel.anchor, focus: { row: targetRow, col: bounds.maxCol } } : sel));
        }
        setFillPreviewRow(null);
        fillPreviewRowRef.current = null;
        fillBoundsRef.current = null;
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedWithIdx, rows, wordWrap]);

  // ── Row / column mutations ─────────────────────────────────────────────

  function renameHeader(col: number, val: string) { pushHistory(); setHeaders((h) => h.map((v, i) => (i === col ? val : v))); }
  function addRow() { pushHistory(); setRows((r) => [...r, Array(headers.length || (r[0]?.length ?? 1)).fill("")]); }
  function deleteRow(displayIdx: number) {
    const oi = sortedWithIdx[displayIdx]?.originalIdx;
    if (oi === undefined) return;
    pushHistory();
    setRows((r) => r.filter((_, i) => i !== oi));
    setSelection(null);
  }
  function addColumn() {
    pushHistory();
    setHeaders((h) => [...h, `col${h.length + 1}`]);
    setRows((r) => r.map((row) => [...row, ""]));
  }
  function deleteColumn(colIdx: number) {
    pushHistory();
    setHeaders((h) => h.filter((_, i) => i !== colIdx));
    setRows((r) => r.map((row) => row.filter((_, i) => i !== colIdx)));
    if (sortCol === colIdx) { setSortCol(null); setSortDir(null); }
    const shiftDown = (prev: Set<number>) => {
      const next = new Set<number>();
      prev.forEach((ci) => { if (ci < colIdx) next.add(ci); else if (ci > colIdx) next.add(ci - 1); });
      return next;
    };
    setColWidths((w) => {
      const next: Record<number, number> = {};
      Object.entries(w).forEach(([k, v]) => { const ki = parseInt(k); if (ki < colIdx) next[ki] = v; else if (ki > colIdx) next[ki - 1] = v; });
      return next;
    });
    setPinnedCols(shiftDown);
    setHiddenCols(shiftDown);
    setSelection(null);
  }
  function batchDeleteColumns(colIdxs: number[]) {
    if (!colIdxs.length) return;
    const toDelete = new Set(colIdxs);
    const newIdx = (old: number) => old - [...toDelete].filter((d) => d < old).length;
    pushHistory();
    setHeaders((h) => h.filter((_, i) => !toDelete.has(i)));
    setRows((r) => r.map((row) => row.filter((_, i) => !toDelete.has(i))));
    if (sortCol !== null) {
      if (toDelete.has(sortCol)) { setSortCol(null); setSortDir(null); } else setSortCol(newIdx(sortCol));
    }
    setColWidths((w) => {
      const next: Record<number, number> = {};
      Object.entries(w).forEach(([k, v]) => { const ki = parseInt(k); if (!toDelete.has(ki)) next[newIdx(ki)] = v; });
      return next;
    });
    const adjustSet = (prev: Set<number>) => {
      const next = new Set<number>();
      prev.forEach((ci) => { if (!toDelete.has(ci)) next.add(newIdx(ci)); });
      return next;
    };
    setPinnedCols(adjustSet);
    setHiddenCols(adjustSet);
    setSelection(null);
  }
  function insertColumnAt(colIdx: number) {
    pushHistory();
    const newName = `col${headers.length + 1}`;
    setHeaders((h) => [...h.slice(0, colIdx), newName, ...h.slice(colIdx)]);
    setRows((r) => r.map((row) => [...row.slice(0, colIdx), "", ...row.slice(colIdx)]));
    const shiftUp = (prev: Set<number>) => { const next = new Set<number>(); prev.forEach((ci) => next.add(ci < colIdx ? ci : ci + 1)); return next; };
    setColWidths((w) => {
      const next: Record<number, number> = {};
      Object.entries(w).forEach(([k, v]) => { const ki = parseInt(k); if (ki < colIdx) next[ki] = v; else next[ki + 1] = v; });
      next[colIdx] = DEFAULT_COL_W;
      return next;
    });
    setPinnedCols(shiftUp);
    setHiddenCols(shiftUp);
    setSelection(null);
  }
  function insertRowAt(displayIdx: number) {
    const oi = sortedWithIdx[displayIdx]?.originalIdx ?? 0;
    pushHistory();
    setRows((r) => [...r.slice(0, oi), Array(headers.length).fill(""), ...r.slice(oi)]);
    setSelection(null);
  }
  function insertRowAfterIdx(displayIdx: number) {
    const oi = sortedWithIdx[displayIdx]?.originalIdx ?? rows.length - 1;
    pushHistory();
    setRows((r) => [...r.slice(0, oi + 1), Array(headers.length).fill(""), ...r.slice(oi + 1)]);
    setSelection(null);
  }
  function deleteSelectedRows() {
    if (!selBounds) return;
    const oiSet = new Set<number>();
    for (let ri = selBounds.minRow; ri <= selBounds.maxRow; ri++) {
      const oi = sortedWithIdx[ri]?.originalIdx;
      if (oi !== undefined) oiSet.add(oi);
    }
    pushHistory();
    setRows((r) => r.filter((_, i) => !oiSet.has(i)));
    setSelection(null);
  }
  function resizeColToFit(ci: number) {
    const w = calcColWidths([headers[ci] ?? ""], rows.map((r) => [r[ci] ?? ""]));
    setColWidths((prev) => ({ ...prev, [ci]: w[0] }));
  }

  // ── Copy whole CSV ─────────────────────────────────────────────────────

  function exportToCSV() {
    const activeDelimiter = delimiter === "auto" ? detectedDelimiterRef.current : delimiter;
    return Papa.unparse(hasHeader ? [headers, ...sortedWithIdx.map((x) => x.row)] : sortedWithIdx.map((x) => x.row), { delimiter: activeDelimiter });
  }
  function handleCopyAll() {
    copyText(exportToCSV()).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // ── Column drag resize ─────────────────────────────────────────────────

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (resizingColRef.current === null) return;
      const delta = e.clientX - resizeStartXRef.current;
      const newW = Math.max(50, resizeStartWRef.current + delta);
      setColWidths((w) => ({ ...w, [resizingColRef.current!]: newW }));
    }
    function onUp() { resizingColRef.current = null; }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  // ── Derived ────────────────────────────────────────────────────────────

  const rowNumColW = Math.max(ROW_NUM_MIN_W, String(Math.max(totalRows, 1)).length * 8 + 16);
  rowNumColWRef.current = rowNumColW;
  const getColWidth = (ci: number) => colWidths[ci] ?? DEFAULT_COL_W;
  const getPinnedLeft = (ci: number): number => {
    let left = rowNumColW;
    for (let i = 0; i < ci; i++) if (pinnedCols.has(i) && !hiddenCols.has(i)) left += getColWidth(i);
    return left;
  };
  const nextVisCol = (from: number, dir: 1 | -1): number => {
    let c = from + dir;
    while (c >= 0 && c <= maxCol && hiddenCols.has(c)) c += dir;
    return Math.max(0, Math.min(maxCol, c));
  };

  const anchorPos = selection?.anchor ?? null;
  const anchorValue = anchorPos !== null ? (sortedWithIdx[anchorPos.row]?.row[anchorPos.col] ?? "") : "";
  const displayValue = formulaBarFocused ? formulaBarDraft : anchorValue;

  const isColFullySelected = (ci: number) =>
    ctrlSelectedCols?.has(ci) || (!!selBounds && selBounds.minRow === 0 && selBounds.maxRow === maxRow && ci >= selBounds.minCol && ci <= selBounds.maxCol);
  const isRowFullySelected = (ri: number) =>
    !!selBounds && selBounds.minCol === 0 && selBounds.maxCol === maxCol && ri >= selBounds.minRow && ri <= selBounds.maxRow;

  const statusText = (() => {
    if (!selection || !selBounds) return hasData ? `${rows.length.toLocaleString()} rows × ${headers.length} cols` : "No data";
    const rCount = selBounds.maxRow - selBounds.minRow + 1;
    const cCount = selBounds.maxCol - selBounds.minCol + 1;
    if (rCount === 1 && cCount === 1) return `${headers[selBounds.minCol] || `col${selBounds.minCol + 1}`}, row ${selBounds.minRow + 1}`;
    return `${rCount} × ${cCount} selected`;
  })();

  useEffect(() => {
    if (!showHiddenPanel) return;
    function onDown(e: MouseEvent) { if (!hiddenPanelRef.current?.contains(e.target as Node)) setShowHiddenPanel(false); }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [showHiddenPanel]);

  useLayoutEffect(() => {
    const el = formulaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const h = Math.min(el.scrollHeight, 160);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > 160 ? "auto" : "hidden";
    // Growing/shrinking the formula bar changes .csv-scroll's clientHeight
    // after scrollToCell already ran against the old height, so the active
    // row can end up clipped — re-run the scroll correction synchronously
    // (before paint) against the now-settled layout.
    if (selection) scrollToCell(selection.focus.row, selection.focus.col);
  }, [displayValue, selection, scrollToCell]);

  // ── Keyboard ───────────────────────────────────────────────────────────

  function handleTableKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const mod = e.ctrlKey || e.metaKey;

    if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); handleSave(); return; }
    if (mod && (e.key === "z" || e.key === "Z")) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && (e.key === "y" || e.key === "Y")) { e.preventDefault(); redo(); return; }

    if (editingCell) return;

    if (mod && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      if (totalRows > 0 && headers.length > 0) setAnchorFocus({ row: 0, col: 0 }, { row: maxRow, col: maxCol }, false);
      return;
    }
    if (mod && (e.key === "c" || e.key === "C")) { e.preventDefault(); copyCells(false); return; }
    if (mod && (e.key === "x" || e.key === "X")) { e.preventDefault(); copyCells(true); return; }
    if (mod && (e.key === "v" || e.key === "V")) { e.preventDefault(); pasteCells(); return; }
    if (mod && (e.key === "f" || e.key === "F")) { e.preventDefault(); openFind(); return; }
    if (mod && (e.key === "h" || e.key === "H")) { e.preventDefault(); openFindReplace(); return; }

    const anchor = selection?.anchor ?? null;
    if (!anchor) {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Tab"].includes(e.key)) {
        e.preventDefault();
        if (totalRows > 0 && headers.length > 0) selectCell(0, 0);
      }
      return;
    }
    const { row, col } = anchor;
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        if (e.shiftKey) extendFocus((selBounds?.minRow ?? row) - 1, selection?.focus.col ?? col);
        else selectCell(Math.max(0, row - 1), col);
        break;
      case "ArrowDown":
        e.preventDefault();
        if (e.shiftKey) extendFocus((selBounds?.maxRow ?? row) + 1, selection?.focus.col ?? col);
        else selectCell(Math.min(maxRow, row + 1), col);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (e.shiftKey) extendFocus(selection?.focus.row ?? row, (selBounds?.minCol ?? col) - 1);
        else selectCell(row, nextVisCol(col, -1));
        break;
      case "ArrowRight":
        e.preventDefault();
        if (e.shiftKey) extendFocus(selection?.focus.row ?? row, (selBounds?.maxCol ?? col) + 1);
        else selectCell(row, nextVisCol(col, 1));
        break;
      case "Tab": {
        e.preventDefault();
        const tabLeft = nextVisCol(col, -1), tabRight = nextVisCol(col, 1);
        if (e.shiftKey) { tabLeft !== col ? selectCell(row, tabLeft) : row > 0 && selectCell(row - 1, nextVisCol(maxCol + 1, -1)); }
        else { tabRight !== col ? selectCell(row, tabRight) : row < maxRow && selectCell(row + 1, nextVisCol(-1, 1)); }
        break;
      }
      case "Enter": case "F2": e.preventDefault(); startEdit(row, col); break;
      case "Delete": case "Backspace":
        e.preventDefault();
        if (isMultiSel && selBounds) commitRange("");
        else {
          const oi = sortedWithIdx[row]?.originalIdx;
          if (oi !== undefined) {
            pushHistory();
            setRows((prev) => prev.map((r, i) => (i === oi ? (() => { const c = [...r]; c[col] = ""; return c; })() : r)));
          }
        }
        break;
      case "Escape": e.preventDefault(); setSelection(null); setCtrlSelectedCols(null); break;
      default:
        if (e.key.length === 1 && !mod) startEdit(row, col);
    }
  }

  // ── Context menu ───────────────────────────────────────────────────────

  function showHeaderMenu(e: ReactMouseEvent, ci: number) {
    e.preventDefault();
    const useCtrl = !!(ctrlSelectedCols && ctrlSelectedCols.size > 0 && ctrlSelectedCols.has(ci));
    const isMulti = useCtrl
      ? ctrlSelectedCols!.size > 1
      : !!(selBounds && selBounds.minRow === 0 && selBounds.maxRow === maxRow && ci >= selBounds.minCol && ci <= selBounds.maxCol && selBounds.minCol !== selBounds.maxCol);
    const colRange = useCtrl
      ? [...ctrlSelectedCols!].sort((a, b) => a - b)
      : isMulti
        ? Array.from({ length: selBounds!.maxCol - selBounds!.minCol + 1 }, (_, i) => selBounds!.minCol + i)
        : [ci];
    const n = colRange.length;
    const allPinned = colRange.every((c) => pinnedCols.has(c));
    const label = (s: string) => (n > 1 ? `${s} (${n} cols)` : s);
    const items: MenuItem[] = [];
    if (!isMulti) {
      items.push({ label: "Sort A → Z", onClick: () => { setSortCol(ci); setSortDir("asc"); } });
      items.push({ label: "Sort Z → A", onClick: () => { setSortCol(ci); setSortDir("desc"); } });
    }
    // Sort is table-wide (one column at a time), so this is offered
    // regardless of which header was right-clicked, not just the currently
    // sorted one — otherwise clearing a sort you no longer remember the
    // column for means hunting for the active chevron first.
    if (sortCol !== null) {
      items.push({ label: "Clear sort", onClick: () => { setSortCol(null); setSortDir(null); } });
    }
    items.push({ label: label("Resize to fit"), onClick: () => colRange.forEach((c) => resizeColToFit(c)) });
    items.push({
      label: label(allPinned ? "Unpin" : "Pin"),
      onClick: () => setPinnedCols((prev) => {
        const next = new Set(prev);
        allPinned ? colRange.forEach((c) => next.delete(c)) : colRange.forEach((c) => next.add(c));
        return next;
      }),
    });
    items.push({
      label: label("Hide"),
      onClick: () => {
        setHiddenCols((prev) => new Set([...prev, ...colRange]));
        setPinnedCols((prev) => { const next = new Set(prev); colRange.forEach((c) => next.delete(c)); return next; });
      },
    });
    if (!isMulti) {
      items.push({ label: "Insert column left", onClick: () => insertColumnAt(ci) });
      items.push({ label: "Insert column right", onClick: () => insertColumnAt(ci + 1) });
    }
    items.push({ label: label("Delete column"), danger: true, onClick: () => (n > 1 ? batchDeleteColumns(colRange) : deleteColumn(ci)) });
    showMenu?.(e.clientX, e.clientY, items);
  }

  function showCellMenu(e: ReactMouseEvent, ri: number, ci: number) {
    e.preventDefault();
    if (editingCell) return;
    if (!selBounds || !inBounds(ri, ci, selBounds)) selectCell(ri, ci);
    const isSingle = !selBounds || (selBounds.minRow === selBounds.maxRow && selBounds.minCol === selBounds.maxCol);
    const rowCount = selBounds ? selBounds.maxRow - selBounds.minRow + 1 : 1;
    const items: MenuItem[] = [];
    if (isSingle) items.push({ label: "Edit cell (Enter)", onClick: () => startEdit(ri, ci) });
    items.push({ label: "Copy (Ctrl+C)", onClick: () => copyCells(false) });
    items.push({ label: "Cut (Ctrl+X)", onClick: () => copyCells(true) });
    items.push({ label: "Paste (Ctrl+V)", onClick: () => pasteCells() });
    items.push({ label: isSingle ? "Clear cell" : "Clear selection", onClick: () => commitRange("") });
    items.push({ label: "Insert row above", onClick: () => insertRowAt(ri) });
    items.push({ label: "Insert row below", onClick: () => insertRowAfterIdx(ri) });
    items.push({ label: `Delete row${rowCount > 1 ? `s (${rowCount})` : ""}`, danger: true, onClick: () => deleteSelectedRows() });
    showMenu?.(e.clientX, e.clientY, items);
  }

  // ── Toolbar (portaled) ─────────────────────────────────────────────────

  const controls = (
    <>
      {dirty && <span className="csv-dirty-dot" title="Unsaved changes" />}
      <button className="icon-button" title={saveError ? `Save failed: ${saveError}` : "Save (Ctrl+S)"} disabled={saving} onClick={handleSave}>
        <Icon name="save" />
      </button>
      <button className="icon-button" title="Reload from disk" disabled={reloading} onClick={handleReload}>
        <Icon name="refresh" />
      </button>
      <button className="icon-button" title="Open in Editor" onClick={() => openInEditor?.(filePath)}>
        <Icon name="file-code" />
      </button>
    </>
  );

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className={`csv-host${active ? "" : " hidden"}`}>
      {loadError && <div className="csv-status csv-status-error">Couldn't load {basename}</div>}
      {!loadError && content === null && <div className="csv-status">Loading…</div>}
      {!loadError && content !== null && (
        <div className="csv-body">
          <CsvToolbar
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
            statusText={statusText}
            hiddenCols={hiddenCols}
            headers={headers}
            showHiddenPanel={showHiddenPanel}
            setShowHiddenPanel={setShowHiddenPanel}
            hiddenPanelRef={hiddenPanelRef}
            setHiddenCols={setHiddenCols}
            showFind={showFind}
            onOpenFind={openFind}
            hasData={hasData}
            onAddRow={addRow}
            onAddColumn={addColumn}
            hasHeader={hasHeader}
            setHasHeader={setHasHeader}
            delimiter={delimiter}
            setDelimiter={setDelimiter}
            wordWrap={wordWrap}
            setWordWrap={setWordWrap}
            copied={copied}
            onCopyAll={handleCopyAll}
          />

          {showFind && (
            <CsvFindBar
              findInputRef={findInputRef}
              findQuery={findQuery}
              setFindQuery={setFindQuery}
              setFindIdx={setFindIdx}
              safeIdx={safeIdx}
              findMatchesLength={findMatches.length}
              onJumpToMatch={jumpToMatch}
              onCloseFind={closeFind}
              showReplace={showReplace}
              setShowReplace={setShowReplace}
              replaceInputRef={replaceInputRef}
              regexError={regexError}
              useRegexFind={useRegexFind}
              setUseRegexFind={setUseRegexFind}
              replaceQuery={replaceQuery}
              setReplaceQuery={setReplaceQuery}
              onReplaceCurrent={replaceCurrent}
              onReplaceAll={replaceAll}
            />
          )}

          {parseWarning && <div className="csv-warning">{parseWarning}</div>}

          {showReloadPrompt && (
            <div className="csv-reload-banner">
              <span className="csv-reload-banner-text">
                Reload requested, but you have unsaved changes.
              </span>
              <button
                className="csv-text-button"
                onClick={() => {
                  setShowReloadPrompt(false);
                  void reloadFromDisk();
                }}
              >
                Reload (discard changes)
              </button>
              <button
                className="icon-button"
                title="Keep my changes"
                onClick={() => setShowReloadPrompt(false)}
              >
                <Icon name="close" />
              </button>
            </div>
          )}

          {hasData && (
            <div className="csv-formula-bar">
              <span className="csv-formula-label">{anchorPos ? (headers[anchorPos.col] ?? `C${anchorPos.col + 1}`) : "value"}</span>
              <textarea
                ref={formulaRef}
                rows={1}
                value={displayValue}
                readOnly={!anchorPos}
                onFocus={() => { if (anchorPos !== null) { setFormulaBarFocused(true); setFormulaBarDraft(anchorValue); } }}
                onChange={(e) => setFormulaBarDraft(e.target.value)}
                onBlur={commitFormulaBar}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") { e.preventDefault(); setFormulaBarFocused(false); scrollRef.current?.focus(); }
                  else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitFormulaBar(); }
                }}
                placeholder={anchorPos ? "" : "Select a cell…"}
                className="csv-formula-input"
              />
            </div>
          )}

          {!hasData ? (
            <div className="csv-empty">Empty file</div>
          ) : (
            <div ref={scrollRef} tabIndex={0} onKeyDown={handleTableKeyDown} onScroll={handleScroll} className={`csv-scroll${wordWrap ? " csv-wrap" : ""}`}>
              <table
                className="csv-table"
                style={{ width: rowNumColW + headers.reduce((s, _, ci) => (hiddenCols.has(ci) ? s : s + getColWidth(ci)), 0) + 32 }}
              >
                <colgroup>
                  <col style={{ width: rowNumColW }} />
                  {headers.map((_, ci) => (hiddenCols.has(ci) ? null : <col key={ci} style={{ width: getColWidth(ci) }} />))}
                  <col style={{ width: 32 }} />
                </colgroup>
                <thead className="csv-thead">
                  <tr>
                    <th className="csv-th csv-th-rownum" style={{ height: ROW_HEIGHT }}>
                      <button onClick={() => setAnchorFocus({ row: 0, col: 0 }, { row: maxRow, col: maxCol }, false)} title="Select all (Ctrl+A)" className="csv-th-rownum-button">
                        #
                      </button>
                    </th>
                    {headers.map((h, ci) => {
                      if (hiddenCols.has(ci)) return null;
                      const isPinned = pinnedCols.has(ci);
                      return (
                        <th
                          key={ci}
                          data-col-idx={ci}
                          className={`csv-th${isPinned ? " csv-th-pinned" : ""}${isColFullySelected(ci) ? " csv-th-selected" : ""}`}
                          style={{ height: ROW_HEIGHT, ...(isPinned ? { left: getPinnedLeft(ci) } : {}) }}
                          onContextMenu={(e) => showHeaderMenu(e, ci)}
                        >
                          <EditableHeaderCell
                            value={h}
                            colIdx={ci}
                            sortDir={sortCol === ci ? sortDir : null}
                            isSelected={isColFullySelected(ci)}
                            onSelectColumn={selectColumn}
                            onSort={handleSort}
                            onRename={renameHeader}
                            onDelete={deleteColumn}
                          />
                          <div
                            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); resizingColRef.current = ci; resizeStartXRef.current = e.clientX; resizeStartWRef.current = getColWidth(ci); }}
                            className="csv-col-resize-handle"
                          />
                        </th>
                      );
                    })}
                    <th className="csv-th csv-th-add" style={{ height: ROW_HEIGHT }}>
                      <button onClick={addColumn} title="Add column" className="icon-button">
                        <Icon name="add" />
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {topSpace > 0 && <tr><td colSpan={headers.length + 2} style={{ height: topSpace, padding: 0 }} /></tr>}
                  {sortedWithIdx.slice(visStart, visEnd + 1).map(({ row, originalIdx }, i) => {
                    const ri = visStart + i;
                    const rowFullySel = isRowFullySelected(ri);
                    return (
                      <tr key={originalIdx} data-row-idx={ri} className="csv-row" style={{ height: wordWrap ? undefined : ROW_HEIGHT }}>
                        <td className={`csv-td csv-td-rownum${rowFullySel ? " csv-td-rownum-selected" : ""}`} style={{ height: wordWrap ? undefined : ROW_HEIGHT }}>
                          <div className="csv-rownum-cell">
                            <button onClick={(e) => selectRow(ri, e.shiftKey)} title="Click to select row · Shift+click to extend" className={`csv-rownum-button${rowFullySel ? " csv-rownum-button-selected" : ""}`}>
                              {ri + 1}
                            </button>
                            <button onClick={() => deleteRow(ri)} title="Delete row" className="csv-rownum-delete">
                              <Icon name="trash" />
                            </button>
                          </div>
                        </td>
                        {headers.map((_, ci) => {
                          if (hiddenCols.has(ci)) return null;
                          const key = `${ri},${ci}`;
                          const isPinned = pinnedCols.has(ci);
                          const isAnchor = selection?.anchor.row === ri && selection?.anchor.col === ci && !editingCell;
                          const isInSel = selBounds ? inBounds(ri, ci, selBounds) : false;
                          const isFill = fillPreviewRow !== null && selBounds ? ri > selBounds.maxRow && ri <= fillPreviewRow && ci >= selBounds.minCol && ci <= selBounds.maxCol : false;
                          const selStyle: "anchor" | "range" | "fill" | null = isFill ? "fill" : isAnchor ? "anchor" : isInSel ? "range" : null;
                          const isCurrentMatch = findMatches[safeIdx]?.row === ri && findMatches[safeIdx]?.col === ci;
                          const findHighlight: "current" | "match" | null = isCurrentMatch ? "current" : findMatchSet.has(key) ? "match" : null;
                          const showFillHandle = !!selBounds && ri === selBounds.maxRow && ci === selBounds.maxCol && !editingCell;
                          return (
                            <td
                              key={ci}
                              className={`csv-td${isPinned ? " csv-td-pinned" : ""}`}
                              style={{ height: wordWrap ? undefined : ROW_HEIGHT, ...(isPinned ? { left: getPinnedLeft(ci) } : {}) }}
                              onContextMenu={(e) => showCellMenu(e, ri, ci)}
                            >
                              <EditableCell
                                value={row[ci] ?? ""}
                                rowIdx={ri}
                                colIdx={ci}
                                selStyle={selStyle}
                                findHighlight={findHighlight}
                                isEditing={editingCell?.row === ri && editingCell?.col === ci}
                                draft={editDraft}
                                showFillHandle={showFillHandle}
                                onMouseDown={handleCellMouseDown}
                                onDoubleClick={(r, c) => startEdit(r, c)}
                                onMouseEnter={handleCellMouseEnter}
                                onDraftChange={setEditDraft}
                                onCommitAndMove={commitAndMove}
                                onCancel={cancelEdit}
                                onFillHandleMouseDown={handleFillHandleMouseDown}
                              />
                            </td>
                          );
                        })}
                        <td />
                      </tr>
                    );
                  })}
                  {botSpace > 0 && <tr><td colSpan={headers.length + 2} style={{ height: botSpace, padding: 0 }} /></tr>}
                </tbody>
              </table>
              <div className="csv-add-row-bar">
                <button onClick={addRow} className="csv-text-button">
                  <Icon name="add" /> Add row
                </button>
              </div>
            </div>
          )}

          {hasData && !editingCell && (
            <div className="csv-hint-bar">
              Arrows · Shift+Arrows select range · Ctrl+A all · Enter/F2 edit · Ctrl+C/X/V copy/cut/paste · Ctrl+Z/Y undo/redo · Ctrl+F find · Ctrl+S save · Right-click for more
            </div>
          )}
        </div>
      )}
      {active && toolbarTarget && createPortal(controls, toolbarTarget)}
    </div>
  );
}

let removeStylesheet: (() => void) | null = null;

export function activate(ctx: {
  registerFileViewer: (v: {
    id: string;
    extensions: string[];
    mode: "default" | "preview" | (() => "default" | "preview");
    component: typeof CsvView;
  }) => void;
  assetUrl: (relPath: string) => string;
  settings: SettingsApi;
}) {
  extSettings = ctx.settings;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerFileViewer({
    id: "csvViewer",
    extensions: ["csv", "tsv"],
    // A thunk, so flipping csv.clickAction applies live: "preview" makes a
    // FILES-tree click open this grid directly ("default" mode), "edit"
    // keeps the click on nvim with the grid behind the Preview affordances
    // — same mechanism as markdown-preview's markdown.clickAction.
    mode: () => (readClickAction() === "preview" ? "default" : "preview"),
    component: CsvView,
  });
}

export function deactivate() {
  removeStylesheet?.();
  removeStylesheet = null;
  extSettings = null;
}

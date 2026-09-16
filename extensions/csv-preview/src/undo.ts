// Extracted verbatim from the original client/src/components/CsvView.tsx's
// "History" section — same closure-over-fresh-rows/headers behavior as
// before (no useCallback there either), just relocated into a hook so
// client.tsx doesn't own the stack refs directly.
import { useRef, useState } from "react";
import type { Snapshot } from "./types";

const MAX_HISTORY = 100;

export function useUndoHistory(
  rows: string[][],
  headers: string[],
  setRows: (updater: string[][] | ((prev: string[][]) => string[][])) => void,
  setHeaders: (updater: string[] | ((prev: string[]) => string[])) => void,
) {
  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [dirty, setDirty] = useState(false);

  function pushHistory() {
    undoStack.current.push({ rows: rows.map((r) => [...r]), headers: [...headers] });
    if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
    redoStack.current = [];
    setCanUndo(true);
    setCanRedo(false);
    setDirty(true);
  }
  function clearHistory() {
    undoStack.current = [];
    redoStack.current = [];
    setCanUndo(false);
    setCanRedo(false);
  }
  function undo() {
    const snap = undoStack.current.pop();
    if (!snap) return;
    redoStack.current.push({ rows: rows.map((r) => [...r]), headers: [...headers] });
    setRows(snap.rows);
    setHeaders(snap.headers);
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(true);
    setDirty(true);
  }
  function redo() {
    const snap = redoStack.current.pop();
    if (!snap) return;
    undoStack.current.push({ rows: rows.map((r) => [...r]), headers: [...headers] });
    setRows(snap.rows);
    setHeaders(snap.headers);
    setCanUndo(true);
    setCanRedo(redoStack.current.length > 0);
    setDirty(true);
  }

  return { pushHistory, clearHistory, undo, redo, canUndo, canRedo, dirty, setDirty };
}

// Copied from client/src/hooks/useListNavigation.ts — see extensions/
// _shared's module comment on why this is a copy, not a shared runtime
// import.
import { useCallback, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export interface UseListNavigationOptions {
  // Ordered ids of every currently-visible/focusable row — recomputed by the
  // caller on every render (flattened tree, filtered list, whatever). The
  // hook never mutates or caches this beyond the current render.
  rowIds: string[];
  // Enter/Space on a row that isn't expand/collapse-able (or IS, and the
  // caller wants a single "activate" meaning regardless — e.g. FileTree's
  // "Enter on a dir toggles, on a file opens" is expressed by branching
  // inside this one callback).
  onActivate: (id: string) => void;
  // ArrowRight on a collapsed/collapsible row.
  onExpand?: (id: string) => void;
  // ArrowLeft on an expanded/collapsible row.
  onCollapse?: (id: string) => void;
  // Delete key on the focused row — optional, callers without a delete
  // action simply omit it and the key falls through unhandled.
  onDelete?: (id: string) => void;
  // "ContextMenu" key or Shift+F10 on the focused row — receives the row's
  // bounding rect so the caller can anchor a menu under it, mirroring how a
  // real right-click passes clientX/clientY.
  onContextMenuKey?: (id: string, rect: DOMRect) => void;
  // Fires on every plain arrow/Home/End move (not on activate/expand/
  // collapse) — selection-owning callers (GitPanel) use this to single-
  // select on a plain move and range-extend on a Shift move; callers with no
  // selection concept (SessionList, PortsPanel, ExtensionsPanel) can omit it
  // and just read focusedId.
  onFocusChange?: (id: string, opts: { shiftKey: boolean }) => void;
}

export interface RowProps {
  tabIndex: number;
  ref: (el: HTMLElement | null) => void;
  onFocus: () => void;
}

export interface UseListNavigationResult {
  focusedId: string | null;
  // Imperative move + DOM focus, for callers that need to focus a row from
  // outside a keydown (e.g. after a right-click, or a "reveal and focus"
  // command bridge).
  focusRow: (id: string) => void;
  getRowProps: (id: string) => RowProps;
  onKeyDown: (e: ReactKeyboardEvent) => void;
}

// Roving-tabindex keyboard navigation shared by every non-FILES-tree list
// widget in the app (SessionList, PortsPanel, ExtensionsPanel; via this
// extensions/_shared copy, SearchPanel and GitPanel). FileTree.tsx predates
// this hook and keeps its own hand-rolled equivalent — migrating it is out
// of scope, see plans/keyboard-nav-context-menus-sessions-search-git.md.
//
// Handles exactly the "list-widget" keys (arrows, Home/End, Enter/Space,
// Delete, ContextMenu/Shift+F10) — never a rebindable operation. Callers
// that also want rebindable commands (e.g. SessionList's sessions.kill)
// dispatch those themselves BEFORE calling this hook's onKeyDown, using
// their own resolvedBindings check, exactly like FileTree.tsx does.
//
// Ownership split: this hook owns focus (which row has the roving tabindex)
// and raw key interpretation; it owns NO selection state — callers that
// need multi-select (GitPanel) layer it on top via onFocusChange.
export function useListNavigation({
  rowIds,
  onActivate,
  onExpand,
  onCollapse,
  onDelete,
  onContextMenuKey,
  onFocusChange,
}: UseListNavigationOptions): UseListNavigationResult {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  // Tracks the focused row's most recent list index so that when it
  // disappears (a poll pruning it out from under the user — sessions
  // re-poll every ~3s, ports refresh on their own key), the next focus
  // target is the row that took its place in the list, not always row 0.
  const lastIndexRef = useRef(0);

  const indexOf = useCallback((id: string | null) => (id ? rowIds.indexOf(id) : -1), [rowIds]);

  // Recomputed on every render (cheap: rowIds is already held by the
  // caller) rather than in an effect, so a render that both removes the
  // focused row AND needs a decision this same pass (e.g. onKeyDown firing
  // synchronously after a delete) sees the resolved value immediately.
  const effectiveFocusedId = useMemo(() => {
    if (focusedId && rowIds.includes(focusedId)) {
      lastIndexRef.current = rowIds.indexOf(focusedId);
      return focusedId;
    }
    if (rowIds.length === 0) return null;
    const clamped = Math.min(lastIndexRef.current, rowIds.length - 1);
    return rowIds[Math.max(0, clamped)];
  }, [focusedId, rowIds]);

  const focusRow = useCallback((id: string) => {
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  }, []);

  const getRowProps = useCallback(
    (id: string): RowProps => ({
      tabIndex: id === effectiveFocusedId ? 0 : -1,
      ref: (el) => {
        if (el) rowRefs.current.set(id, el);
        else rowRefs.current.delete(id);
      },
      onFocus: () => setFocusedId(id),
    }),
    [effectiveFocusedId],
  );

  const moveFocus = useCallback(
    (newIdx: number, shiftKey: boolean) => {
      if (rowIds.length === 0) return;
      const clamped = Math.max(0, Math.min(rowIds.length - 1, newIdx));
      const target = rowIds[clamped];
      focusRow(target);
      onFocusChange?.(target, { shiftKey });
    },
    [rowIds, focusRow, onFocusChange],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (rowIds.length === 0) return;
      const idx = indexOf(effectiveFocusedId);
      const current = effectiveFocusedId;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          moveFocus(idx === -1 ? 0 : idx + 1, e.shiftKey);
          return;
        case "ArrowUp":
          e.preventDefault();
          moveFocus(idx === -1 ? 0 : idx - 1, e.shiftKey);
          return;
        case "Home":
          e.preventDefault();
          moveFocus(0, e.shiftKey);
          return;
        case "End":
          e.preventDefault();
          moveFocus(rowIds.length - 1, e.shiftKey);
          return;
        case "ArrowRight":
          if (!current || !onExpand) return;
          e.preventDefault();
          onExpand(current);
          return;
        case "ArrowLeft":
          if (!current || !onCollapse) return;
          e.preventDefault();
          onCollapse(current);
          return;
        case "Enter":
        case " ":
          if (!current) return;
          e.preventDefault();
          onActivate(current);
          return;
        case "Delete":
          if (!current || !onDelete) return;
          e.preventDefault();
          onDelete(current);
          return;
        case "ContextMenu":
        case "F10": {
          if (!current || !onContextMenuKey) return;
          if (e.key === "F10" && !e.shiftKey) return;
          e.preventDefault();
          const rect = rowRefs.current.get(current)?.getBoundingClientRect();
          if (rect) onContextMenuKey(current, rect);
          return;
        }
        default:
          return;
      }
    },
    [rowIds, indexOf, effectiveFocusedId, moveFocus, onExpand, onCollapse, onActivate, onDelete, onContextMenuKey],
  );

  return { focusedId: effectiveFocusedId, focusRow, getRowProps, onKeyDown };
}

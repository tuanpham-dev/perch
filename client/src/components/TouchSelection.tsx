import { useState, type RefObject } from "react";

interface CellRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Props {
  // Pixel rect (relative to containerRef) of the selection's first/last
  // cell — TerminalView derives these each render from the engine's live
  // cell metrics. Handles anchor to these; the toolbar anchors to `rect`.
  rect: CellRect;
  startRect: CellRect;
  endRect: CellRect;
  // TerminalView's .terminal-body — clamps horizontal toolbar position,
  // same containerRef pattern as FloatingTouchKeys.
  containerRef: RefObject<HTMLElement | null>;
  // "Open" when the selection is a resolved URL/file path, null otherwise
  // (Copy always shows).
  openLabel: string | null;
  onCopy: () => void;
  onPaste: () => void;
  onOpen: () => void;
  // Drag-handle gestures — TerminalView owns the actual engine.selectCells
  // call and selection-range math; this component only forwards raw pointer
  // coordinates and its own local "which handle is being dragged" state
  // (used only to hide the toolbar during a drag — never unmounts the
  // handles themselves, since they own the pointer capture mid-gesture).
  onHandleDragStart: (which: "start" | "end") => void;
  onHandleDragMove: (clientX: number, clientY: number) => void;
}

const TOOLBAR_GAP = 8;
// Layout hasn't happened yet when position is computed, so width/height are
// estimated for the flip/clamp decision — close enough for a two-button bar;
// the browser reflows the real size on top of it.
const ESTIMATED_HEIGHT = 40;

// Toolbar + drag handles for a touch long-press selection
// (plans/mobile-touch-select-copy-open.md). Touch-only: desktop keeps its
// existing keybinding/ctrl-click flows untouched.
export default function TouchSelection({
  rect,
  startRect,
  endRect,
  containerRef,
  openLabel,
  onCopy,
  onPaste,
  onOpen,
  onHandleDragStart,
  onHandleDragMove,
}: Props) {
  const [draggingHandle, setDraggingHandle] = useState<"start" | "end" | null>(null);

  const container = containerRef.current?.getBoundingClientRect();
  const containerWidth = container?.width ?? 0;
  const containerHeight = container?.height ?? 0;
  const estimatedWidth = openLabel ? 188 : 132;

  const openAbove = rect.top - ESTIMATED_HEIGHT - TOOLBAR_GAP >= 0;
  const top = openAbove
    ? rect.top - ESTIMATED_HEIGHT - TOOLBAR_GAP
    : rect.top + rect.height + TOOLBAR_GAP;
  const clampedTop = Math.max(0, Math.min(top, Math.max(containerHeight - ESTIMATED_HEIGHT, 0)));

  const centerX = rect.left + rect.width / 2;
  const halfWidth = estimatedWidth / 2;
  const clampedCenterX = containerWidth
    ? Math.min(Math.max(centerX, halfWidth + 4), Math.max(containerWidth - halfWidth - 4, halfWidth + 4))
    : centerX;

  const handlePointerDown = (which: "start" | "end") => (e: React.PointerEvent) => {
    e.preventDefault();
    // Best-effort: setPointerCapture throws NotFoundError if the browser
    // doesn't consider this pointer id "active" (seen from synthetic
    // PointerEvents in testing; real touch input shouldn't hit this, but an
    // uncaught throw here would otherwise abort the whole gesture before the
    // state below ever gets set).
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      // fall through — drag still works without capture as long as the
      // pointer stays over this element, same as it did before capture was
      // added
    }
    setDraggingHandle(which);
    onHandleDragStart(which);
  };
  const handlePointerMove = (which: "start" | "end") => (e: React.PointerEvent) => {
    if (draggingHandle !== which) return;
    onHandleDragMove(e.clientX, e.clientY);
  };
  const endDrag = () => setDraggingHandle(null);

  return (
    <>
      {!draggingHandle && (
        <div
          className="touch-select-toolbar"
          style={{ left: `${clampedCenterX}px`, top: `${clampedTop}px`, transform: "translateX(-50%)" }}
        >
          <button type="button" onClick={onCopy}>
            Copy
          </button>
          <button type="button" onClick={onPaste}>
            Paste
          </button>
          {openLabel && (
            <button type="button" onClick={onOpen}>
              {openLabel}
            </button>
          )}
        </div>
      )}
      <div
        className="touch-select-handle touch-select-handle-start"
        style={{ left: `${startRect.left}px`, top: `${startRect.top + startRect.height}px` }}
        onPointerDown={handlePointerDown("start")}
        onPointerMove={handlePointerMove("start")}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      <div
        className="touch-select-handle touch-select-handle-end"
        style={{ left: `${endRect.left + endRect.width}px`, top: `${endRect.top + endRect.height}px` }}
        onPointerDown={handlePointerDown("end")}
        onPointerMove={handlePointerMove("end")}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </>
  );
}

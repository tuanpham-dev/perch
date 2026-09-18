// A draggable divider between two columns, with its width remembered.
// Shared with the git-history extension in the perch-extensions registry,
// which keeps its own copy - extension code can't be imported across repos.
//
// Pointer events rather than mouse events, so a pen or a touch drag works
// too; setPointerCapture keeps the drag alive when the pointer leaves the
// 6px handle, which is most of the drag.
import { useCallback, useEffect, useRef, useState } from "react";

const MIN_PX = 200;
// Always leave room for the right column, however wide the tab is.
const MIN_REMAINDER_PX = 240;

function read(key: string, fallback: number): number {
  try {
    const raw = Number(localStorage.getItem(key));
    return Number.isFinite(raw) && raw >= MIN_PX ? raw : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: number) {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // A private window or a storage quota: the split still works, it just
    // won't be remembered.
  }
}

export interface Split {
  /** Width of the left column, in px. */
  width: number;
  /** Ref for the element the width is measured inside. */
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  /** Spread onto the divider element. */
  handleProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    role: string;
    tabIndex: number;
    "aria-orientation": "vertical";
    "aria-valuenow": number;
  };
  dragging: boolean;
}

export function useSplit(storageKey: string, initial = 380): Split {
  // The width the user ASKED for, which is what gets stored. What is
  // actually applied is this clamped to what currently fits - kept apart so
  // a narrow moment (a container measured at zero before layout, a
  // temporarily small tab) can't permanently shrink the column: once the
  // room comes back, so does the width.
  const [desired, setDesired] = useState(() => read(storageKey, initial));
  const [available, setAvailable] = useState(0);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const clampTo = useCallback((next: number, total: number) => {
    // Before the first measurement there is nothing to clamp against, so
    // the asked-for width stands.
    if (total <= 0) return Math.max(next, MIN_PX);
    const max = Math.max(MIN_PX, total - MIN_REMAINDER_PX);
    return Math.min(Math.max(next, MIN_PX), max);
  }, []);

  const clamp = useCallback(
    (next: number) => clampTo(next, containerRef.current?.getBoundingClientRect().width ?? 0),
    [clampTo],
  );

  const width = clampTo(desired, available);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const handle = e.currentTarget as HTMLElement;
      handle.setPointerCapture(e.pointerId);
      const left = containerRef.current?.getBoundingClientRect().left ?? 0;
      setDragging(true);

      const move = (ev: PointerEvent) => setDesired(clamp(ev.clientX - left));
      const up = (ev: PointerEvent) => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        setDragging(false);
        setDesired((w) => {
          write(storageKey, w);
          return w;
        });
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    },
    [clamp, storageKey],
  );

  // A divider nobody can reach with a keyboard is a divider some people
  // can't move at all.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 50 : 10;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setDesired((w) => {
        const next = clamp(w + (e.key === "ArrowRight" ? step : -step));
        write(storageKey, next);
        return next;
      });
    },
    [clamp, storageKey],
  );

  // The tab can be resized while the split is open (a sidebar toggling, the
  // window changing). Only the available width is recorded here; the applied
  // width is derived from it, so growing the tab restores the column rather
  // than leaving it at whatever the narrowest moment allowed.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setAvailable(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setAvailable(el.getBoundingClientRect().width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return {
    width,
    containerRef,
    dragging,
    handleProps: {
      onPointerDown,
      onKeyDown,
      role: "separator",
      tabIndex: 0,
      "aria-orientation": "vertical",
      "aria-valuenow": Math.round(width),
    },
  };
}

import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

// Match the app's existing long-press idiom (TabBar/SidebarTabStrip drag): a
// 300ms hold, cancelled once the finger moves past 8px so a list can still
// scroll under it.
const LONG_PRESS_MS = 300;
const MOVE_SLOP_PX = 8;

interface PressState {
  pointerId: number;
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout>;
}

// Turns a touch/pen long-press on an element into the same context-menu open
// its right-click already fires. Mouse is ignored (it uses the real
// contextmenu event); movement past MOVE_SLOP_PX or an early release cancels.
// When the press fires it opens the menu at the press point and swallows the
// trailing `click` once, so the row underneath isn't also activated/selected
// (the release synthesizes a click the row's own onClick would otherwise see).
//
// Call once per component; use the returned `bind(open)` per row to attach
// handlers — the hook itself runs once, so rules-of-hooks are respected even
// with a distinct `open` callback per row.
export function useLongPressMenu() {
  const state = useRef<PressState | null>(null);

  const cancel = () => {
    if (state.current) {
      clearTimeout(state.current.timer);
      state.current = null;
    }
  };

  const suppressNextClick = () => {
    const onClick = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      window.removeEventListener("click", onClick, true);
      clearTimeout(safety);
    };
    // Backstop: a press that ends in pointercancel never synthesizes a click,
    // so drop the listener after a beat rather than letting it eat an
    // unrelated later click.
    const safety = setTimeout(() => window.removeEventListener("click", onClick, true), 400);
    window.addEventListener("click", onClick, true);
  };

  return function bind(open: (x: number, y: number) => void) {
    return {
      onPointerDown(e: ReactPointerEvent) {
        if (e.pointerType === "mouse") return;
        cancel();
        const x = e.clientX;
        const y = e.clientY;
        const timer = setTimeout(() => {
          state.current = null;
          suppressNextClick();
          navigator.vibrate?.(10);
          open(x, y);
        }, LONG_PRESS_MS);
        state.current = { pointerId: e.pointerId, x, y, timer };
      },
      onPointerMove(e: ReactPointerEvent) {
        const s = state.current;
        if (!s || e.pointerId !== s.pointerId) return;
        if (Math.hypot(e.clientX - s.x, e.clientY - s.y) >= MOVE_SLOP_PX) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
    };
  };
}

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useDismissOnOutsidePress } from "../hooks/useDismissOnOutsidePress";

// A floating panel anchored to a status-bar button. The bar sits 22px from
// the bottom of the window, so unlike ContextMenu (which drops down from a
// click point) this always opens UPWARD and right-aligns to its trigger.
//
// Surface and dismissal deliberately match ContextMenu — same z-index rung,
// the same shared outside-press hook (which swallows the dismissing press
// so it can't also act on what it landed on), same Escape and window-blur
// handling, and the same `[data-menu-trigger]` exemption so a trigger button
// can toggle its own popover shut instead of closing and reopening it.

interface Props {
  // The trigger's own getBoundingClientRect().
  anchor: DOMRect;
  onClose: () => void;
  children: ReactNode;
}

// Breathing room from the trigger and from the viewport edges.
const GAP = 4;
const EDGE = 4;

export default function StatusBarPopover({ anchor, onClose, children }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number; maxHeight: number }>({
    // Off-screen for the first paint, before the measure below runs — the
    // panel's own width decides its left edge.
    left: -9999,
    bottom: window.innerHeight - anchor.top + GAP,
    maxHeight: anchor.top - GAP - EDGE,
  });

  // Measured rather than computed from CSS: the content (a terminals list, a
  // ports list) sizes the panel, and only then is it known whether the
  // right-aligned left edge clears the left edge of the screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.max(EDGE, anchor.right - rect.width),
      bottom: window.innerHeight - anchor.top + GAP,
      maxHeight: Math.max(0, anchor.top - GAP - EDGE),
    });
  }, [anchor, children]);

  // The trigger is exempt because it toggles: closed here, its own click
  // would reopen this immediately and the button would look dead.
  useDismissOnOutsidePress({
    ref,
    onDismiss: onClose,
    ignoreSelector: "[data-menu-trigger]",
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="status-bar-popover"
      style={{ left: pos.left, bottom: pos.bottom, maxHeight: pos.maxHeight }}
    >
      {children}
    </div>
  );
}

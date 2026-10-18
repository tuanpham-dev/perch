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
  // Right-aligned to the trigger through CSS `right`, so content that grows
  // after opening (a reading arriving, a list filling in) extends leftward on
  // its own. Pinned to the left edge instead only when the panel is wider
  // than the room left of its trigger.
  const [pinLeft, setPinLeft] = useState(false);
  const bottom = window.innerHeight - anchor.top + GAP;
  const maxHeight = Math.max(0, anchor.top - GAP - EDGE);

  // Measured rather than computed from CSS: the content sizes the panel, and
  // only then is it known whether right-aligning it clears the left edge of
  // the screen. Re-checked on every resize — content can change size long
  // after mount without this component re-rendering (system-stats' popover
  // opens on "Reading…" and widens when the reading lands), and a placement
  // measured from the first paint's width is what put that one off-screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      // A panel wider than the room left of the trigger gets squeezed to
      // exactly that room, which reads as not fitting here too.
      setPinLeft(anchor.right - el.offsetWidth < EDGE);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor]);

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
      style={{
        left: pinLeft ? EDGE : undefined,
        right: pinLeft ? undefined : window.innerWidth - anchor.right,
        bottom,
        maxHeight,
      }}
    >
      {children}
    </div>
  );
}

import { useEffect, type RefObject } from "react";

// The press that dismisses an overlay belongs to the overlay, not to whatever
// it lands on. Without that, a tap outside does two things at once: it closes
// the menu AND acts on what was underneath — on a phone, tapping the terminal
// to get rid of a menu focuses the terminal and throws the soft keyboard up
// over the screen the user was trying to see.
//
// So the first press outside is swallowed: default prevented, propagation
// stopped, and (for a mouse, where preventDefault on mousedown doesn't stop
// the click that follows) the next click swallowed too. A second press, with
// the overlay gone, behaves normally.
//
// Capture phase on both pointer kinds, because TerminalView cancels these
// events at capture on its own screen element: a bubble-phase listener would
// never see a press that lands there. Window is the first node the capture
// phase visits, so this always runs first.
//
// touchstart is registered non-passive on purpose. Chrome makes touch
// listeners on window passive BY DEFAULT, which would silently drop the
// preventDefault below and let the tap through — the whole point of this.

interface Options {
  // Presses inside this element are the overlay's own business.
  ref: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  // Off while the overlay isn't showing.
  enabled?: boolean;
  // A press on an element matching this selector is left alone, so a
  // toggle-style trigger can close its own overlay in its click handler
  // rather than having it closed here and immediately reopened.
  ignoreSelector?: string;
}

export function useDismissOnOutsidePress({ ref, onDismiss, enabled = true, ignoreSelector }: Options) {
  useEffect(() => {
    if (!enabled) return;
    let swallowClick = false;

    const onPress = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (ref.current?.contains(target as Node)) return;
      if (ignoreSelector && target?.closest?.(ignoreSelector)) return;
      e.preventDefault();
      e.stopPropagation();
      // A prevented mousedown still produces a click on mouseup; a prevented
      // touchstart suppresses the whole synthetic mouse sequence, so this
      // only ever fires for a real mouse.
      swallowClick = e.type === "mousedown";
      onDismiss();
    };

    const onClick = (e: Event) => {
      if (!swallowClick) return;
      swallowClick = false;
      if (ref.current?.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
    };

    const opts = { capture: true, passive: false } as const;
    window.addEventListener("mousedown", onPress, opts);
    window.addEventListener("touchstart", onPress, opts);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("mousedown", onPress, opts);
      window.removeEventListener("touchstart", onPress, opts);
      window.removeEventListener("click", onClick, true);
    };
  }, [ref, onDismiss, enabled, ignoreSelector]);
}

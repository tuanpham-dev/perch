import { useEffect, useState } from "react";
import { desktop, type ButtonLayout } from "../desktop";

// Window Controls Overlay: an installed desktop PWA whose user hid the
// browser's title bar (manifest display_override, see vite.config.ts). The
// browser still draws minimize/maximize/close, on whichever side the OS puts
// them, and reports the strip left over for the page as a rect. The title bar
// (components/TitleBar.tsx) lays itself out from that rect rather than from
// CSS env(titlebar-area-*), so the emulation below can drive the exact same
// code path — nothing can fake env(). See plans/pwa-custom-title-bar.md.
//
// Emulation, for QA in a browser that can't install the app: ?wco=right
// (Windows-like controls) or ?wco=left (macOS-like), same URL-flag convention
// as inputDebug.ts's ?inputdebug.
//
// The desktop app (desktop.ts) takes the same shapes for real: its
// frameless window keeps macOS's traffic lights at the left, and on Windows
// and Linux the title bar draws its own buttons (windowButtons) - at the
// right on Windows, wherever the desktop's setting puts them on Linux. See
// plans/desktop-app.md T7.

export interface TitlebarAreaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowControlsOverlayState {
  visible: boolean;
  rect: TitlebarAreaRect;
  emulated: "left" | "right" | null;
  // Whether the window has focus - a native title bar dims when it doesn't.
  focused: boolean;
  // The desktop app on Windows/Linux: the buttons the title bar draws
  // itself, in the strips left and right of `rect`. Null everywhere else.
  windowButtons: ButtonLayout | null;
}

// One drawn window button's width.
export const WINDOW_BUTTON_WIDTH = 46;

// Not in every TS DOM lib yet.
interface WindowControlsOverlay extends EventTarget {
  visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

const EMULATED: "left" | "right" | null = (() => {
  if (typeof location === "undefined") return null;
  const value = new URLSearchParams(location.search).get("wco");
  return value === "left" || value === "right" ? value : null;
})();

function overlay(): WindowControlsOverlay | null {
  return (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay ?? null;
}

// The two shapes: controls at the right (Windows-like, 138px for three
// buttons) or traffic lights at the left (macOS).
function rightControlsRect(): TitlebarAreaRect {
  return { x: 0, y: 0, width: window.innerWidth - 138, height: 33 };
}

function leftControlsRect(): TitlebarAreaRect {
  return { x: 78, y: 0, width: window.innerWidth - 78, height: 28 };
}

function read(): WindowControlsOverlayState {
  const focused = document.hasFocus();
  if (desktop) {
    if (desktop.info.platform === "macos") {
      return { visible: true, rect: leftControlsRect(), emulated: null, focused, windowButtons: null };
    }
    const buttons = desktop.info.buttonLayout;
    const start = buttons.left.length * WINDOW_BUTTON_WIDTH;
    const end = buttons.right.length * WINDOW_BUTTON_WIDTH;
    const rect = { x: start, y: 0, width: window.innerWidth - start - end, height: 33 };
    return { visible: true, rect, emulated: null, focused, windowButtons: buttons };
  }
  if (EMULATED === "right") {
    return { visible: true, rect: rightControlsRect(), emulated: EMULATED, focused, windowButtons: null };
  }
  if (EMULATED === "left") {
    return { visible: true, rect: leftControlsRect(), emulated: EMULATED, focused, windowButtons: null };
  }
  const wco = overlay();
  if (!wco?.visible) {
    return { visible: false, rect: { x: 0, y: 0, width: 0, height: 0 }, emulated: null, focused, windowButtons: null };
  }
  const r = wco.getTitlebarAreaRect();
  return { visible: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, emulated: null, focused, windowButtons: null };
}

function same(a: WindowControlsOverlayState, b: WindowControlsOverlayState): boolean {
  return (
    a.visible === b.visible &&
    a.emulated === b.emulated &&
    a.focused === b.focused &&
    a.windowButtons?.left.join() === b.windowButtons?.left.join() &&
    a.windowButtons?.right.join() === b.windowButtons?.right.join() &&
    a.rect.x === b.rect.x &&
    a.rect.y === b.rect.y &&
    a.rect.width === b.rect.width &&
    a.rect.height === b.rect.height
  );
}

export function useWindowControlsOverlay(): WindowControlsOverlayState {
  const [state, setState] = useState(read);
  useEffect(() => {
    // Keep the previous object when nothing changed, so a resize tick that
    // leaves the overlay alone doesn't re-render App.
    const update = () => setState((prev) => {
      const next = read();
      return same(prev, next) ? prev : next;
    });
    const wco = overlay();
    wco?.addEventListener("geometrychange", update);
    // Emulated rects are derived from the window width; the real rect
    // arrives through geometrychange, but a resize is cheap to re-read too.
    window.addEventListener("resize", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    // The desktop app on Linux: the user moved the window buttons in their
    // desktop's settings.
    const offLayout = desktop?.onButtonLayoutChange(update);
    update();
    return () => {
      offLayout?.();
      wco?.removeEventListener("geometrychange", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return state;
}

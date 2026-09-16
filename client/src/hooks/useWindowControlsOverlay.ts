import { useEffect, useState } from "react";

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
}

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

function read(): WindowControlsOverlayState {
  const focused = document.hasFocus();
  if (EMULATED === "right") {
    return { visible: true, rect: { x: 0, y: 0, width: window.innerWidth - 138, height: 33 }, emulated: EMULATED, focused };
  }
  if (EMULATED === "left") {
    return { visible: true, rect: { x: 78, y: 0, width: window.innerWidth - 78, height: 28 }, emulated: EMULATED, focused };
  }
  const wco = overlay();
  if (!wco?.visible) {
    return { visible: false, rect: { x: 0, y: 0, width: 0, height: 0 }, emulated: null, focused };
  }
  const r = wco.getTitlebarAreaRect();
  return { visible: true, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, emulated: null, focused };
}

function same(a: WindowControlsOverlayState, b: WindowControlsOverlayState): boolean {
  return (
    a.visible === b.visible &&
    a.emulated === b.emulated &&
    a.focused === b.focused &&
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
    update();
    return () => {
      wco?.removeEventListener("geometrychange", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  return state;
}

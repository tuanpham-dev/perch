import { useCallback, useEffect, useRef, useState } from "react";
import type { Tab } from "../types";

// The floating terminal: one terminal parked over the whole app, either as a
// window (expanded) or a draggable bubble (collapsed). Floating a tab moves it
// here - the tab leaves its editor group with its attach kept alive, the same
// hand-off "Move into New Window" uses - and docking hands it back as a tab.
//
// What floats and whether it is expanded persist per browser, like tabs do
// (the attach name reattaches after a reload). Where the window and bubble
// sit is the component's business (FloatingTerminal.tsx).

const STORAGE_KEY = "perch.floatingTerminal";

// A tab that shows a terminal (a window or a whole session), the only kind
// that can float: not Settings, a viewer, a grid or a legacy preview.
export function isFloatableTab(tab: Tab): boolean {
  return (
    tab.sessionName !== "" &&
    !tab.settingsView &&
    !tab.keyboardView &&
    tab.extViewerId === undefined &&
    tab.extensionPageId === undefined &&
    tab.gridId === undefined &&
    tab.imagePath === undefined &&
    tab.previewPath === undefined
  );
}

export interface FloatingState {
  // The parked tab, minus its editor group.
  tab: Tab;
  expanded: boolean;
}

function load(): FloatingState | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    const tab = parsed?.tab;
    if (tab && typeof tab.id === "string" && typeof tab.sessionName === "string" && typeof tab.attachName === "string") {
      return { tab, expanded: parsed.expanded !== false };
    }
  } catch {
    // unreadable: nothing floats
  }
  return null;
}

function save(state: FloatingState | null): void {
  try {
    if (state) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage blocked: the float lasts for this page only
  }
}

export function useFloatingTerminal() {
  const [floating, setFloatingState] = useState<FloatingState | null>(load);
  // Whether the floating terminal holds keyboard focus. Like the bottom
  // panel's panelFocused, App ANDs !floatFocused into every other terminal's
  // own focused prop, so exactly one terminal claims the keyboard.
  const [floatFocused, setFloatFocused] = useState(false);
  const floatingRef = useRef(floating);
  floatingRef.current = floating;

  const setFloating = useCallback((next: FloatingState | null) => {
    floatingRef.current = next;
    setFloatingState(next);
    save(next);
  }, []);

  const setExpanded = useCallback(
    (expanded: boolean) => {
      const current = floatingRef.current;
      if (!current || current.expanded === expanded) return;
      setFloating({ ...current, expanded });
      setFloatFocused(expanded);
    },
    [setFloating],
  );

  // Any press outside the floating window hands the keyboard back to
  // whatever surface was pressed. Menus and dialogs opened from the window
  // live outside it, so a press there leaves the focus alone.
  useEffect(() => {
    if (!floatFocused) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest) return;
      if (target.closest(".floating-terminal, .context-menu, .dialog-overlay, .quick-switcher-overlay")) return;
      setFloatFocused(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [floatFocused]);

  return {
    floating,
    floatingRef,
    setFloating,
    setExpanded,
    floatFocused: floatFocused && floating?.expanded === true,
    setFloatFocused,
  };
}

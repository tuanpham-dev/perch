import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Tab } from "../types";

// Back/forward over the tabs you've been in, VS Code's Go Back/Go Forward:
// every landing is recorded, going back replays them in reverse, and landing
// somewhere new after a Back truncates whatever was ahead. The sidebar
// footer's two arrows are the whole UI.
//
// An entry is just a tab id. Which editor group it belongs to is NOT stored:
// setActiveTabId already resolves a tab's group from the tab itself, so a
// tab dragged into another split still navigates to where it actually is
// now rather than where it was when you left it.
//
// Everything here is refs plus a version counter, not state: the history
// changes on every activation, and only the two arrows' disabled state has
// to re-render when it does.

const MAX_ENTRIES = 50;

export interface NavigationHistory {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
}

export function useNavigationHistory(
  activeTabId: string | null,
  setActiveTabId: (id: string) => void,
  tabsRef: MutableRefObject<Tab[]>,
): NavigationHistory {
  const entries = useRef<string[]>([]);
  const index = useRef(-1);
  // Set while a Back/Forward is what moved the active tab, so the effect
  // below records the landing as navigation rather than as a new visit
  // (which would truncate the forward half the moment you used it).
  const navigating = useRef(false);
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((v) => v + 1), []);

  useEffect(() => {
    if (!activeTabId) return;
    if (navigating.current) {
      navigating.current = false;
      return;
    }
    if (entries.current[index.current] === activeTabId) return;
    // A new visit ends the forward half — the same rule a browser's address
    // bar follows.
    const next = entries.current.slice(0, index.current + 1);
    next.push(activeTabId);
    // Oldest first out of the window; index follows the trim.
    entries.current = next.slice(-MAX_ENTRIES);
    index.current = entries.current.length - 1;
    rerender();
  }, [activeTabId, rerender]);

  // The nearest entry in `dir` whose tab still exists. Closed tabs stay in
  // the list rather than being pruned on close: pruning would have to run on
  // every tab change, and a closed tab can come back (reopenClosedTab keeps
  // its id), in which case its place in the history is still the right one.
  const findLive = useCallback(
    (dir: -1 | 1): number => {
      const live = (id: string) => tabsRef.current.some((t) => t.id === id);
      for (let i = index.current + dir; i >= 0 && i < entries.current.length; i += dir) {
        if (live(entries.current[i]) && entries.current[i] !== activeTabId) return i;
      }
      return -1;
    },
    [activeTabId, tabsRef],
  );

  const go = useCallback(
    (dir: -1 | 1) => {
      const target = findLive(dir);
      if (target === -1) return;
      index.current = target;
      navigating.current = true;
      setActiveTabId(entries.current[target]);
      rerender();
    },
    [findLive, rerender, setActiveTabId],
  );

  return {
    canGoBack: findLive(-1) !== -1,
    canGoForward: findLive(1) !== -1,
    goBack: useCallback(() => go(-1), [go]),
    goForward: useCallback(() => go(1), [go]),
  };
}

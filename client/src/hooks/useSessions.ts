import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { TerminalSession } from "../types";

// Sessions state + the 3s poll. `onAfterRefresh` is called at the end of
// every refresh (success or failure) — App wires it to bump filesRefreshKey
// so FILES-panel git badges piggyback on this same poll instead of a second
// timer (see useFileActions).
export function useSessions(showError: (err: unknown) => void, onAfterRefresh: () => void) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  // Guards the window-tab cleanup effect (useTabs) against the very first
  // render, where `sessions` is still its initial [] — without this, every
  // restored window-tab would look "gone" and get closed before the first
  // fetch even completes.
  const sessionsLoadedRef = useRef(false);
  // An idle poll (no session/window/activity change) fetches the identical
  // payload most of the time — comparing it here skips setSessions (and the
  // whole app-tree re-render it triggers) rather than paying that cost on
  // every 3s tick regardless. onAfterRefresh still fires unconditionally
  // below: the FILES-panel poll and clipboard mirror it drives don't depend
  // on the session list actually having changed.
  const lastJsonRef = useRef("");

  const refresh = useCallback(async () => {
    try {
      const next = await api.fetchSessions();
      const json = JSON.stringify(next);
      if (json !== lastJsonRef.current) {
        lastJsonRef.current = json;
        setSessions(next);
      }
      sessionsLoadedRef.current = true;
    } catch (err) {
      showError(err);
    }
    onAfterRefresh();
  }, [showError, onAfterRefresh]);

  useEffect(() => {
    refresh();
    // Skip ticks while the tab is hidden (background tab, minimized window)
    // — no point polling the backend twice a second for nothing on screen; an
    // immediate refresh on regaining visibility keeps state from going stale
    // for the 3s until the next tick would've fired anyway.
    const t = setInterval(() => {
      if (!document.hidden) refresh();
    }, 3000);
    const onVisibility = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  return { sessions, refresh, sessionsLoadedRef };
}

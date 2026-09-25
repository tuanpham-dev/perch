import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import {
  applyWindowTabs,
  DETACHED_WINDOW_ID,
  detachedWindowFeatures,
  detachedWindowGeometry,
  detachedWindowUrl,
  type WindowGeometry,
  findMainWindow,
  holderOf as registryHolderOf,
  IS_DETACHED,
  openChannel,
  removeWindow,
  type DetachedMessage,
  type DetachedRegistry,
} from "../lib/detachedWindows";
import type { Tab } from "../types";

// Both roles of the detached-window protocol (plans/detach-tab-to-new-window.md).
//
// Main window: opens detached windows (detachTab), keeps a registry of what
// each one holds from their broadcasts, focuses one instead of opening a
// duplicate (holderOf/focusDetachedTab, consulted by useTabs' open paths),
// and adopts a window's tabs back when it closes. A close is detected two
// ways: the window handle's `closed` flag, polled every second (exact; the
// handle comes from window.open, and a detached window hands it back through
// the opener chain after the main window reloads - see findMainWindow), and,
// only for a window with no handle (opened by hand, or its opener chain
// broken), the window's own `window-closing` broadcast from pagehide, acted
// on after a grace period unless a fresh `window-tabs` from the same id
// shows it was only a reload.
//
// Detached window: broadcasts its tabs on load and on every change, answers
// `hello` (a main window that just reloaded rebuilding its registry),
// activates and raises itself on `focus-tab`, and announces pagehide.

export interface DetachedApi {
  holderOf(match: (tab: Tab) => boolean): { windowId: string; tabId: string } | null;
  focusDetachedTab(windowId: string, tabId: string): Promise<boolean>;
}

// How long a closing window with no handle gets to come back (a reload)
// before its tabs are adopted. Generous: a cold reload with every extension
// bundle can take seconds, and adopting a tab that is still open elsewhere
// is the worse mistake.
const CLOSING_GRACE_MS = 10000;
const HANDLE_POLL_MS = 1000;
// A detached window that doesn't answer a focus request in this time is
// treated as gone.
const FOCUS_TIMEOUT_MS = 500;

export function useDetachedWindows(
  tabs: Tab[],
  activeTabId: string | null,
  tabsRef: MutableRefObject<Tab[]>,
  setActiveTabId: (id: string) => void,
  adoptTabs: (incoming: Tab[], activeId: string | null) => void,
  showError: (err: unknown) => void,
): DetachedApi & {
  detachTab(tab: Tab, rect: DOMRect | null): boolean;
  detachTabs(tabs: Tab[], geometry: WindowGeometry): boolean;
} {
  const channelRef = useRef<BroadcastChannel | null>(null);
  const registryRef = useRef<DetachedRegistry>({});
  const handlesRef = useRef<Record<string, Window | null>>({});
  const closingTimersRef = useRef<Record<string, number>>({});
  const pendingFocusRef = useRef<Record<string, (ok: boolean) => void>>({});
  // Ref-bridged so the mount effect's listener always calls the current
  // adoptTabs without re-subscribing.
  const adoptTabsRef = useRef(adoptTabs);
  adoptTabsRef.current = adoptTabs;
  const setActiveTabIdRef = useRef(setActiveTabId);
  setActiveTabIdRef.current = setActiveTabId;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const post = useCallback((msg: DetachedMessage) => {
    channelRef.current?.postMessage(msg);
  }, []);

  const forget = useCallback((windowId: string) => {
    registryRef.current = removeWindow(registryRef.current, windowId);
    delete handlesRef.current[windowId];
    const timer = closingTimersRef.current[windowId];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      delete closingTimersRef.current[windowId];
    }
  }, []);

  const adopt = useCallback(
    (windowId: string) => {
      const entry = registryRef.current[windowId];
      forget(windowId);
      if (entry && entry.tabs.length > 0) adoptTabsRef.current(entry.tabs, entry.activeTabId);
    },
    [forget],
  );

  // ---- Main role ------------------------------------------------------------
  useEffect(() => {
    if (IS_DETACHED) return;
    const channel = openChannel();
    channelRef.current = channel;
    if (!channel) return;
    channel.onmessage = (e: MessageEvent<DetachedMessage>) => {
      const msg = e.data;
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "window-tabs": {
          registryRef.current = applyWindowTabs(registryRef.current, msg);
          const timer = closingTimersRef.current[msg.windowId];
          if (timer !== undefined) {
            window.clearTimeout(timer);
            delete closingTimersRef.current[msg.windowId];
          }
          break;
        }
        case "window-closing": {
          if (!(msg.windowId in registryRef.current)) break;
          // With a handle, the poll below sees the real close; a reload
          // never flips `closed`, so there is nothing to guess.
          if (handlesRef.current[msg.windowId]) break;
          window.clearTimeout(closingTimersRef.current[msg.windowId]);
          closingTimersRef.current[msg.windowId] = window.setTimeout(() => adopt(msg.windowId), CLOSING_GRACE_MS);
          break;
        }
        case "focus-result": {
          const key = `${msg.windowId}:${msg.tabId}`;
          pendingFocusRef.current[key]?.(msg.ok);
          delete pendingFocusRef.current[key];
          break;
        }
        default:
          break;
      }
    };
    window.__perchDetached = {
      register: (windowId, handle) => {
        handlesRef.current[windowId] = handle;
      },
    };
    channel.postMessage({ type: "hello" } satisfies DetachedMessage);
    const poll = window.setInterval(() => {
      for (const [windowId, handle] of Object.entries(handlesRef.current)) {
        if (handle?.closed) adopt(windowId);
      }
    }, HANDLE_POLL_MS);
    return () => {
      window.clearInterval(poll);
      for (const timer of Object.values(closingTimersRef.current)) window.clearTimeout(timer);
      closingTimersRef.current = {};
      delete window.__perchDetached;
      channel.close();
      channelRef.current = null;
    };
  }, [adopt]);

  // ---- Detached role --------------------------------------------------------
  useEffect(() => {
    if (!IS_DETACHED) return;
    const channel = openChannel();
    channelRef.current = channel;
    if (!channel) return;
    const announce = () => {
      try {
        findMainWindow(window)?.__perchDetached?.register(DETACHED_WINDOW_ID!, window);
      } catch {
        // no reachable main window; the broadcast below still carries the tabs
      }
      channel.postMessage({
        type: "window-tabs",
        windowId: DETACHED_WINDOW_ID!,
        tabs: tabsRef.current,
        activeTabId: activeTabIdRef.current,
      } satisfies DetachedMessage);
    };
    channel.onmessage = (e: MessageEvent<DetachedMessage>) => {
      const msg = e.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "hello") {
        announce();
      } else if (msg.type === "focus-tab" && msg.windowId === DETACHED_WINDOW_ID) {
        const ok = tabsRef.current.some((t) => t.id === msg.tabId);
        if (ok) setActiveTabIdRef.current(msg.tabId);
        try {
          window.focus();
        } catch {
          // A browser may refuse to raise a window without user activation;
          // the main window still won't open a duplicate.
        }
        channel.postMessage({ type: "focus-result", windowId: msg.windowId, tabId: msg.tabId, ok } satisfies DetachedMessage);
      }
    };
    const onPageHide = () => {
      channel.postMessage({ type: "window-closing", windowId: DETACHED_WINDOW_ID! } satisfies DetachedMessage);
    };
    window.addEventListener("pagehide", onPageHide);
    announce();
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      channel.close();
      channelRef.current = null;
    };
  }, [tabsRef]);

  // The detached window's live state, for the main window's registry.
  useEffect(() => {
    if (!IS_DETACHED) return;
    post({ type: "window-tabs", windowId: DETACHED_WINDOW_ID!, tabs, activeTabId });
  }, [tabs, activeTabId, post]);

  // ---- Shared surface ---------------------------------------------------------
  // Opens a detached window holding `tabs` (a tear-off may carry several -
  // plans/cross-window-tab-drag.md), placed and sized by `geometry`.
  const detachTabs = useCallback(
    (tabs: Tab[], geometry: WindowGeometry): boolean => {
      if (tabs.length === 0) return false;
      const windowId = crypto.randomUUID();
      const url = detachedWindowUrl(windowId, { tabs, activeTabId: tabs[0].id });
      const handle = window.open(url, `perch-detached-${windowId}`, detachedWindowFeatures(geometry));
      if (!handle) {
        showError(new Error("The browser blocked the new window. Allow popups for this site and try again."));
        return false;
      }
      // A detached window that spawns another never adopts (its parent's
      // main window does, once the child announces itself), so only the
      // main role tracks the handle.
      if (!IS_DETACHED) {
        registryRef.current = applyWindowTabs(registryRef.current, { windowId, tabs, activeTabId: tabs[0].id });
        handlesRef.current[windowId] = handle;
      }
      return true;
    },
    [showError],
  );
  const detachTab = useCallback(
    (tab: Tab, rect: DOMRect | null): boolean =>
      detachTabs([tab], detachedWindowGeometry(rect, { x: window.screenX, y: window.screenY })),
    [detachTabs],
  );

  const holderOf = useCallback(
    (match: (tab: Tab) => boolean) => (IS_DETACHED ? null : registryHolderOf(registryRef.current, match)),
    [],
  );

  const focusDetachedTab = useCallback(
    (windowId: string, tabId: string): Promise<boolean> => {
      if (IS_DETACHED || !channelRef.current) return Promise.resolve(false);
      try {
        handlesRef.current[windowId]?.focus();
      } catch {
        // cross-window focus is best effort
      }
      return new Promise<boolean>((resolve) => {
        const key = `${windowId}:${tabId}`;
        const timer = window.setTimeout(() => {
          delete pendingFocusRef.current[key];
          forget(windowId);
          resolve(false);
        }, FOCUS_TIMEOUT_MS);
        pendingFocusRef.current[key] = (ok) => {
          window.clearTimeout(timer);
          resolve(ok);
        };
        post({ type: "focus-tab", windowId, tabId });
      });
    },
    [forget, post],
  );

  return { detachTab, detachTabs, holderOf, focusDetachedTab };
}

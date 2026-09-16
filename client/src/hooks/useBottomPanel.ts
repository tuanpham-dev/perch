import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import * as api from "../api";
import type { TerminalSession } from "../types";

// The bottom terminal panel (plans/bottom-terminal-panel.md). Deliberately
// its *own* small state model rather than a second SplitNode tree over the
// editor's tabs: the panel only ever holds terminals, only ever splits
// side-by-side, and never nests — expressing those constraints as guards
// threaded through lib/splits.ts + useTabs would cost far more than the model
// below. TerminalView is still reused as-is for each pane.
//
// Each pane is backed by a real terminal window (created by this hook) attached
// through the same synthetic grouped-session plumbing editor window-tabs use:
// api.createWindow mints the window, api.openWindowTab mints a grouped session
// pinned to it (see server/src/terminals.ts's createWindowTab), and the pane
// attaches to *that*. Closing a pane only closes the synthetic attach — the
// window itself stays alive in its session (detach, not kill), exactly
// like an editor window-tab's own close.

export interface PanelPane {
  id: string;
  // The real session that owns this pane's window.
  sessionName: string;
  windowIndex: number;
  // The synthetic grouped session actually attached (api.openWindowTab).
  attachName: string;
  // Stable window ids, resolved from the session poll — lets a pane survive an
  // out-of-band rename/renumber, mirroring Tab's own sessionId/windowId.
  sessionId?: string;
  windowId?: string;
}

export interface PanelTab {
  id: string;
  // Left-to-right; always at least one (a tab with no panes is removed).
  panes: PanelPane[];
  // Flex weights, one per pane — only the ratio matters (lib/splits.ts's
  // BranchNode.sizes convention).
  sizes: number[];
  activePaneId: string;
}

export interface PanelState {
  visible: boolean;
  height: number;
  tabs: PanelTab[];
  // Keyed by project (useTabs' projectKeyForSession) rather than a single
  // id: each project remembers its own last-active tab, since panes of every
  // project stay mounted together (see BottomPanel's module comment) and
  // only one project's tabs are ever shown in the strip at a time.
  activeTabByProject: Record<string, string>;
}

const PANEL_KEY = "bottomPanel";
const DEFAULT_HEIGHT = 260;
export const PANEL_MIN_HEIGHT = 100;

// Cap at 70% of the viewport so the panel can never squeeze the editor area
// to nothing — re-clamped on load (the window may be smaller than it was when
// the height was stored) and on every drag.
export function clampPanelHeight(height: number): number {
  const max = Math.max(PANEL_MIN_HEIGHT, window.innerHeight * 0.7);
  return Math.min(max, Math.max(PANEL_MIN_HEIGHT, height));
}

const EMPTY_STATE: PanelState = {
  visible: false,
  height: DEFAULT_HEIGHT,
  tabs: [],
  activeTabByProject: {},
};

function isPane(value: unknown): value is PanelPane {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.sessionName === "string" &&
    typeof p.attachName === "string" &&
    typeof p.windowIndex === "number" &&
    Number.isInteger(p.windowIndex)
  );
}

// Defensive, like lib/splits.ts's parseStoredTree: anything malformed falls
// back to a fresh panel rather than throwing. A tab whose panes didn't survive
// validation is dropped entirely (a paneless tab has nothing to render).
//
// legacyActiveTabId is returned separately, not folded into activeTabByProject
// here: this function runs before sessions are fetched, and resolving a tab's
// project (projectKeyForSession) needs the loaded session list to mean
// anything more than a bare session-name fallback — migrating here would key
// the entry by a name that never matches the real, path-based key used once
// sessions load. The caller finishes the migration once sessions are ready
// (see useBottomPanel's legacy-migration effect).
function loadPanelState(): { state: PanelState; legacyActiveTabId: string | null } {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(localStorage.getItem(PANEL_KEY) ?? "null");
  } catch {
    return { state: { ...EMPTY_STATE }, legacyActiveTabId: null };
  }
  if (!parsed || typeof parsed !== "object") return { state: { ...EMPTY_STATE }, legacyActiveTabId: null };
  const raw = parsed as Record<string, unknown>;
  const rawTabs = Array.isArray(raw.tabs) ? raw.tabs : [];
  const tabs: PanelTab[] = [];
  for (const entry of rawTabs) {
    if (typeof entry !== "object" || entry === null) continue;
    const t = entry as Record<string, unknown>;
    if (typeof t.id !== "string") continue;
    const panes = (Array.isArray(t.panes) ? t.panes : []).filter(isPane);
    if (panes.length === 0) continue;
    const sizes =
      Array.isArray(t.sizes) &&
      t.sizes.length === panes.length &&
      t.sizes.every((s) => typeof s === "number" && Number.isFinite(s) && s > 0)
        ? (t.sizes as number[])
        : panes.map(() => 1);
    const activePaneId =
      typeof t.activePaneId === "string" && panes.some((p) => p.id === t.activePaneId)
        ? t.activePaneId
        : panes[0].id;
    tabs.push({ id: t.id, panes, sizes, activePaneId });
  }
  const legacyActiveTabId =
    typeof raw.activeTabId === "string" && tabs.some((t) => t.id === raw.activeTabId)
      ? raw.activeTabId
      : null;
  return {
    state: {
      visible: raw.visible === true && tabs.length > 0,
      height: clampPanelHeight(typeof raw.height === "number" ? raw.height : DEFAULT_HEIGHT),
      tabs,
      activeTabByProject: {},
    },
    legacyActiveTabId,
  };
}

export function useBottomPanel(
  sessions: TerminalSession[],
  sessionsLoadedRef: MutableRefObject<boolean>,
  showError: (err: unknown) => void,
  activeProjectKey: string | null,
  projectKeyForSession: (name: string) => string,
) {
  // Lazy-initialized exactly once (React guarantees this for a useState
  // initializer function) — mutating legacyActiveTabIdRef here, during that
  // same first render, is the standard "seed a ref from the lazy initializer"
  // idiom, not a render-time side effect on state anything else reads yet.
  const legacyActiveTabIdRef = useRef<string | null>(null);
  const [panel, setPanel] = useState<PanelState>(() => {
    const { state, legacyActiveTabId } = loadPanelState();
    legacyActiveTabIdRef.current = legacyActiveTabId;
    return state;
  });
  // Which of the app's two terminal surfaces owns keyboard focus. The panel
  // and the editor groups both render terminal instances that grab focus when
  // `focused` is true, so exactly one side may claim it at a time — App ANDs
  // !panelFocused into every editor terminal's own focused prop.
  const [panelFocused, setPanelFocused] = useState(false);

  // Snapshot for the async/imperative paths below (splitActivePane must read
  // the current tabs across an await; removePane/closeTab need the panes they
  // are about to drop *before* the state updater, so their detach calls stay
  // out of it — an updater can run twice under StrictMode). Same rationale as
  // useTabs' tabsRef.
  const panelRef = useRef(panel);
  panelRef.current = panel;

  // Same rationale as useTabs' own ref-for-a-frequently-changing-callback
  // idiom — projectKeyForSession's identity changes whenever sessions does
  // (it closes over them), which would otherwise thrash every callback below
  // that needs it.
  const projectKeyForSessionRef = useRef(projectKeyForSession);
  projectKeyForSessionRef.current = projectKeyForSession;
  const projectKeyOf = useCallback(
    (tab: PanelTab): string => projectKeyForSessionRef.current(tab.panes[0].sessionName),
    [],
  );
  // Same rationale — splitActivePane below reads this across an awaited
  // createPane call and must see whichever project was active when the user
  // triggered the split, not one that changed meanwhile.
  const activeProjectKeyRef = useRef(activeProjectKey);
  activeProjectKeyRef.current = activeProjectKey;

  useEffect(() => {
    localStorage.setItem(PANEL_KEY, JSON.stringify(panel));
  }, [panel]);

  // Reveals *and* focuses, hides *and* unfocuses — VS Code's own Ctrl+`
  // behavior. Reads the current visibility rather than toggling panelFocused
  // independently: the panel can be visible without being focused (a click in
  // an editor terminal), and toggling from there must hide it, not re-focus it.
  const togglePanel = useCallback(() => {
    const nextVisible = !panelRef.current.visible;
    setPanel((prev) => ({ ...prev, visible: nextVisible }));
    setPanelFocused(nextVisible);
  }, []);

  const showPanel = useCallback(() => {
    setPanel((prev) => (prev.visible ? prev : { ...prev, visible: true }));
    setPanelFocused(true);
  }, []);

  const hidePanel = useCallback(() => {
    setPanel((prev) => (prev.visible ? { ...prev, visible: false } : prev));
    setPanelFocused(false);
  }, []);

  const setHeight = useCallback((height: number) => {
    setPanel((prev) => ({ ...prev, height: clampPanelHeight(height) }));
  }, []);

  const selectTab = useCallback(
    (tabId: string) => {
      setPanel((prev) => {
        const tab = prev.tabs.find((t) => t.id === tabId);
        if (!tab) return prev;
        const key = projectKeyOf(tab);
        if (prev.activeTabByProject[key] === tabId) return prev;
        return { ...prev, activeTabByProject: { ...prev.activeTabByProject, [key]: tabId } };
      });
      setPanelFocused(true);
    },
    [projectKeyOf],
  );

  const selectPane = useCallback(
    (tabId: string, paneId: string) => {
      setPanel((prev) => {
        const tab = prev.tabs.find((t) => t.id === tabId);
        if (!tab) return prev;
        const key = projectKeyOf(tab);
        return {
          ...prev,
          activeTabByProject: { ...prev.activeTabByProject, [key]: tabId },
          tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t)),
        };
      });
      setPanelFocused(true);
    },
    [projectKeyOf],
  );

  const resizePanes = useCallback((tabId: string, sizes: number[]) => {
    setPanel((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) =>
        t.id === tabId && sizes.length === t.panes.length ? { ...t, sizes } : t,
      ),
    }));
  }, []);

  // Mints a window in `session` and attaches it — the shared half of
  // newTerminal/splitActivePane below. Returns null (after surfacing the
  // error) if either step fails.
  const createPane = useCallback(
    async (session: string, windowIndex?: number): Promise<PanelPane | null> => {
      try {
        const index = windowIndex ?? (await api.createWindow(session)).index;
        const { attachName } = await api.openWindowTab(session, index);
        return { id: crypto.randomUUID(), sessionName: session, windowIndex: index, attachName };
      } catch (err) {
        showError(err);
        return null;
      }
    },
    [showError],
  );

  const addTabWithPane = useCallback(
    (pane: PanelPane) => {
      const tab: PanelTab = {
        id: crypto.randomUUID(),
        panes: [pane],
        sizes: [1],
        activePaneId: pane.id,
      };
      const key = projectKeyOf(tab);
      setPanel((prev) => ({
        ...prev,
        visible: true,
        tabs: [...prev.tabs, tab],
        activeTabByProject: { ...prev.activeTabByProject, [key]: tab.id },
      }));
      setPanelFocused(true);
    },
    [projectKeyOf],
  );

  // Opens a new panel terminal in `session` — a brand-new window there,
  // as its own panel tab. The caller resolves which session (App's
  // requestPanelTerminal: the active session, or a picker when there is none).
  const newTerminal = useCallback(
    async (session: string) => {
      const pane = await createPane(session);
      if (pane) addTabWithPane(pane);
    },
    [createPane, addTabWithPane],
  );

  // Attaches an *existing* window as its own panel tab — the counterpart
  // of newTerminal for a window that's already alive (picked from App's
  // attach-window menu). Same detach-only close semantics as every pane.
  const attachWindow = useCallback(
    async (session: string, windowIndex: number) => {
      const pane = await createPane(session, windowIndex);
      if (pane) addTabWithPane(pane);
    },
    [createPane, addTabWithPane],
  );

  // Splits the active tab's active pane: a new pane, backed by its own fresh
  // window in that pane's session, lands immediately to its right and takes
  // half its flex weight (lib/splits.ts's splitLeaf convention). Side-by-side
  // only — the panel has no vertical split by design.
  const splitActivePane = useCallback(async () => {
    const current = panelRef.current;
    const key = activeProjectKeyRef.current;
    const activeTabId = key !== null ? (current.activeTabByProject[key] ?? null) : null;
    const tab = current.tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    const source = tab.panes.find((p) => p.id === tab.activePaneId) ?? tab.panes[0];
    if (!source) return;
    const pane = await createPane(source.sessionName);
    if (!pane) return;
    setPanel((prev) => ({
      ...prev,
      visible: true,
      tabs: prev.tabs.map((t) => {
        if (t.id !== tab.id) return t;
        const idx = t.panes.findIndex((p) => p.id === source.id);
        if (idx === -1) return t;
        const half = t.sizes[idx] / 2;
        const panes = [...t.panes];
        const sizes = [...t.sizes];
        panes.splice(idx + 1, 0, pane);
        sizes.splice(idx + 1, 0, half);
        sizes[idx] = half;
        return { ...t, panes, sizes, activePaneId: pane.id };
      }),
    }));
    setPanelFocused(true);
  }, [createPane]);

  // Detach-only, matching an editor window-tab's own close (useTabs' closeTab):
  // the synthetic attach session goes away, the real window it was pinned
  // to stays alive in its session. `detach: false` is the path for a pane whose
  // attach is *already* gone (the terminal exited, or the window vanished
  // out-of-band) — there's nothing left to close server-side.
  const removePane = useCallback(
    (tabId: string, paneId: string, detach = true) => {
      if (detach) {
        // Outside the updater below: a state updater must stay pure (React may
        // invoke it twice under StrictMode, which would fire the request twice).
        const pane = panelRef.current.tabs
          .find((t) => t.id === tabId)
          ?.panes.find((p) => p.id === paneId);
        if (pane) api.closeWindowTab(pane.attachName).catch(() => {});
      }
      setPanel((prev) => {
        const tab = prev.tabs.find((t) => t.id === tabId);
        if (!tab) return prev;
        const idx = tab.panes.findIndex((p) => p.id === paneId);
        if (idx === -1) return prev;

        if (tab.panes.length === 1) {
          const tabs = prev.tabs.filter((t) => t.id !== tabId);
          // Falls to the neighbor at the closed tab's own position within its
          // own project (its successor, or the new last tab of that project
          // if it was last) — the panel has no MRU history of its own to
          // fall back on. Scoped to the closing tab's project so a pane
          // closing in one project never hands focus to another project's
          // tab (that tab simply isn't visible right now).
          const key = projectKeyOf(tab);
          const projectTabs = prev.tabs.filter((t) => projectKeyOf(t) === key);
          const closedIdx = projectTabs.findIndex((t) => t.id === tabId);
          const remaining = projectTabs.filter((t) => t.id !== tabId);
          const activeTabByProject = { ...prev.activeTabByProject };
          if (remaining.length > 0) {
            activeTabByProject[key] = remaining[Math.min(closedIdx, remaining.length - 1)].id;
          } else {
            delete activeTabByProject[key];
          }
          return { ...prev, tabs, activeTabByProject };
        }

        const panes = tab.panes.filter((p) => p.id !== paneId);
        const sizes = tab.sizes.filter((_, i) => i !== idx);
        // Hand the freed weight to the following sibling, or the preceding one
        // if the removed pane was last (lib/splits.ts's removeLeaf convention).
        const giveIdx = idx < sizes.length ? idx : idx - 1;
        sizes[giveIdx] += tab.sizes[idx];
        const activePaneId =
          tab.activePaneId === paneId
            ? panes[Math.min(idx, panes.length - 1)].id
            : tab.activePaneId;
        return {
          ...prev,
          tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, panes, sizes, activePaneId } : t)),
        };
      });
    },
    [projectKeyOf],
  );

  const closePane = useCallback(
    (tabId: string, paneId: string) => removePane(tabId, paneId, true),
    [removePane],
  );

  const closeTab = useCallback((tabId: string) => {
    // Detach every pane's attach up front, outside the updater — see removePane.
    const closing = panelRef.current.tabs.find((t) => t.id === tabId);
    if (!closing) return;
    for (const pane of closing.panes) api.closeWindowTab(pane.attachName).catch(() => {});
    setPanel((prev) => {
      const tab = prev.tabs.find((t) => t.id === tabId);
      if (!tab) return prev;
      const tabs = prev.tabs.filter((t) => t.id !== tabId);
      // Same project-scoped neighbor-fallback rule as removePane's
      // whole-tab-closed branch.
      const key = projectKeyOf(tab);
      const projectTabs = prev.tabs.filter((t) => projectKeyOf(t) === key);
      const closedIdx = projectTabs.findIndex((t) => t.id === tabId);
      const remaining = projectTabs.filter((t) => t.id !== tabId);
      const activeTabByProject = { ...prev.activeTabByProject };
      if (remaining.length > 0) {
        activeTabByProject[key] = remaining[Math.min(closedIdx, remaining.length - 1)].id;
      } else {
        delete activeTabByProject[key];
      }
      return { ...prev, tabs, activeTabByProject };
    });
  }, [projectKeyOf]);

  // Poll-driven reconcile: resolves each pane's stable window ids on first sight,
  // then follows any out-of-band rename/renumber of the session or window it's
  // pinned to — the panel's equivalent of lib/tabs.ts's reconcileTabs.
  useEffect(() => {
    if (!sessionsLoadedRef.current) return;
    setPanel((prev) => {
      let changed = false;
      const tabs = prev.tabs.map((tab) => {
        let tabChanged = false;
        const panes = tab.panes.map((pane) => {
          const session = pane.sessionId
            ? sessions.find((s) => s.id === pane.sessionId)
            : sessions.find((s) => s.name === pane.sessionName);
          if (!session) return pane;
          const window = pane.windowId
            ? session.windows.find((w) => w.id === pane.windowId)
            : session.windows.find((w) => w.index === pane.windowIndex);
          if (!window) return pane;
          if (
            pane.sessionId === session.id &&
            pane.windowId === window.id &&
            pane.sessionName === session.name &&
            pane.windowIndex === window.index
          ) {
            return pane;
          }
          tabChanged = true;
          return {
            ...pane,
            sessionId: session.id,
            windowId: window.id,
            sessionName: session.name,
            windowIndex: window.index,
          };
        });
        if (!tabChanged) return tab;
        changed = true;
        return { ...tab, panes };
      });
      return changed ? { ...prev, tabs } : prev;
    });
  }, [sessions, sessionsLoadedRef]);

  // One-time best-effort migration of a legacy single activeTabId (see
  // loadPanelState's comment on why this can't happen there): seeds the
  // migrated tab's own project with it, so that project keeps its prior
  // selection instead of every project silently starting on its first tab.
  // Gated on sessionsLoadedRef the same as the reconcile effect above, since
  // projectKeyOf needs real session paths to produce the same key this
  // project's tabs will be looked up under later.
  const legacyMigratedRef = useRef(false);
  useEffect(() => {
    if (!sessionsLoadedRef.current) return;
    if (legacyMigratedRef.current) return;
    legacyMigratedRef.current = true;
    const legacyId = legacyActiveTabIdRef.current;
    if (legacyId === null) return;
    setPanel((prev) => {
      const tab = prev.tabs.find((t) => t.id === legacyId);
      if (!tab) return prev;
      const key = projectKeyOf(tab);
      if (prev.activeTabByProject[key]) return prev;
      return { ...prev, activeTabByProject: { ...prev.activeTabByProject, [key]: legacyId } };
    });
  }, [sessions, sessionsLoadedRef, projectKeyOf]);

  // Vanish sweep: a pane whose window is gone (killed from the sidebar, a
  // real terminal, or by its own process exiting) loses its pane. No detach
  // call — the window, and with it the synthetic attach, is already gone. Runs
  // only once ids are resolved, so a pane created between two polls isn't read
  // as vanished before its window shows up in `sessions`. TerminalView's own
  // onExit usually gets there first; this is the safety net, same split of
  // duties as useTabs' vanished-window effect.
  useEffect(() => {
    if (!sessionsLoadedRef.current) return;
    for (const tab of panelRef.current.tabs) {
      for (const pane of tab.panes) {
        if (!pane.windowId) continue;
        const session = sessions.find((s) => s.id === pane.sessionId);
        const stillExists = session?.windows.some((w) => w.id === pane.windowId) ?? false;
        if (!stillExists) removePane(tab.id, pane.id, false);
      }
    }
  }, [sessions, sessionsLoadedRef, removePane]);

  // Only the current project's tabs — the strip and the "no terminals"
  // placeholder are scoped to this; the body render loop still maps over the
  // full panel.tabs so every project's panes stay mounted (see BottomPanel's
  // module comment), and naturally hides all but activeTab since activeTabId
  // can only ever equal one tab across every project at a time.
  const visibleTabs = activeProjectKey === null ? [] : panel.tabs.filter((t) => projectKeyOf(t) === activeProjectKey);
  const activeTabId = activeProjectKey !== null ? (panel.activeTabByProject[activeProjectKey] ?? null) : null;
  const activeTab = (activeTabId && visibleTabs.find((t) => t.id === activeTabId)) || visibleTabs[0] || null;

  return {
    panel,
    visibleTabs,
    activeTab,
    activeTabId: activeTab?.id ?? null,
    panelFocused,
    setPanelFocused,
    togglePanel,
    showPanel,
    hidePanel,
    setHeight,
    selectTab,
    selectPane,
    resizePanes,
    newTerminal,
    attachWindow,
    splitActivePane,
    closeTab,
    closePane,
    removePane,
  };
}

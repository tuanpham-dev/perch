import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  flushPendingTabReveals,
  setSidebarLayoutBridge,
  type RegisteredSidebarPanel,
  type RegisteredSidebarTab,
} from "../extensions";
import {
  BUILTIN_PANEL_IDS,
  DEFAULT_LAYOUT,
  EXPLORER_TAB_ID,
  addTabToSide,
  isTabVisible,
  removeTabFromLayout,
  tabOfPanel,
  moveTabToSide,
  movePanelToTab,
  resolveActive,
  sanitizeLayout,
  selectTab as selectTabIn,
  togglePanelHidden,
  sideOfTab,
  visibleTabsForSide,
  type PanelLike,
  type SidebarLayout,
  type SidebarSide,
  type TabEnv,
} from "../lib/sidebarLayout";

// Owns both halves of the sidebars' persisted state and every mutation of
// it, for BOTH sides at once — a single owner because two Sidebar instances
// reading and writing the same localStorage keys would diverge the moment
// one of them re-rendered. Sidebar.tsx is now purely a renderer of one
// side's slice.
//
// The panel-state half (order/collapse/size of accordion sections, plus its
// legacy-id rewrites and one-shot migrations) moved here verbatim from
// Sidebar.tsx; the layout half (which tabs are on which side, and which tab
// each section calls home) is new — see lib/sidebarLayout.ts for the model.

// Built-in ids are the literal union below; an extension panel's id is
// whatever registerSidebarPanel namespaced it to (ext.<extensionId>.<id>),
// so the type widens to string — PANEL_IDS stays the source of truth for
// "is this one of the built-ins".
export type PanelId = string;

export interface PanelState {
  order: PanelId[];
  collapsed: Record<PanelId, boolean>;
  // Relative flex-grow weights for expanded panels. Values are seeded from
  // measured pixel heights on resize, but any positive number works — flex
  // only cares about the ratio between siblings, not the absolute value.
  sizes: Record<PanelId, number>;
}

const PANEL_IDS: PanelId[] = ["projects", "files"];
export const MIN_PANEL_HEIGHT = 60;
const PANELS_KEY = "sidebarPanels";

// The PORTS accordion section's id before it was extracted into the
// bundled ports extension — loadPanelState rewrites it in stored state so
// each user's accustomed order/collapse/size carries over to the
// extension's namespaced panel id.
const LEGACY_PORTS_PANEL_ID = "ports";
// The PROJECTS section's id before the SESSIONS pane was sunset in its
// favor (plans/projects-not-sessions.md) — loadPanelState rewrites it the
// same way as the ports id below, keeping order/collapse/size.
const LEGACY_SESSIONS_PANEL_ID = "sessions";
const PORTS_EXT_PANEL_ID = "ext.perch.ports.ports";
const TASKS_EXT_PANEL_ID = "ext.perch.tasks.tasks";

// One-shot stored-state migrations that must NOT re-run (unlike the
// idempotent legacy-ports id rewrite below): re-applying an ordering
// migration would fight a user who deliberately dragged the sections back.
// Kept as a separate key so the ordinary panelState save can't drop the
// applied-set.
const PANEL_MIGRATIONS_KEY = "sidebarPanelMigrations";

function appliedPanelMigrations(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PANEL_MIGRATIONS_KEY) ?? "null");
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

// loadPanelState runs as a useState initializer, which StrictMode's dev
// double-invoke calls twice: without this memo the first call consumes the
// migration flag and the second (whose result React keeps) sees "already
// applied" and skips the move. True only while the current page load has
// itself applied the migration, so re-running it stays idempotent; a real
// reload re-evaluates the module and the persisted flag alone decides.
let tasksOrderMigratedThisLoad = false;

const DEFAULT_PANEL_STATE: PanelState = {
  order: ["projects", "files"],
  collapsed: { projects: false, files: false },
  sizes: { projects: 1, files: 1 },
};

function loadPanelState(): PanelState {
  try {
    const parsed = JSON.parse(localStorage.getItem(PANELS_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_PANEL_STATE };
    // Any string id is accepted here so an id from before extension panels
    // moved out of the accordion into their own tab survives a reload — it's
    // simply excluded at render time (see visibleOrder) since its extension
    // isn't registered as an explorer section.
    const order: PanelId[] =
      Array.isArray(parsed.order) && parsed.order.every((id: unknown) => typeof id === "string")
        ? [...(parsed.order as PanelId[])]
        : [...DEFAULT_PANEL_STATE.order];
    // The sunset SESSIONS pane's id rewrites to "projects" BEFORE the
    // missing-id backfill below — otherwise the backfill would append a
    // second "projects" at the end and the stored slot would be lost.
    const legacySessionsIdx = order.indexOf(LEGACY_SESSIONS_PANEL_ID);
    if (legacySessionsIdx !== -1 && !order.includes("projects")) {
      order[legacySessionsIdx] = "projects";
    }
    for (const id of PANEL_IDS) if (!order.includes(id)) order.push(id);
    const collapsed = { ...DEFAULT_PANEL_STATE.collapsed, ...parsed.collapsed };
    const sizes = { ...DEFAULT_PANEL_STATE.sizes, ...parsed.sizes };
    // One-time migration: the pre-extraction PORTS id maps to the ports
    // extension's namespaced panel id, keeping its slot/collapse/size. The
    // rewritten state persists via the ordinary save effect.
    const legacyIdx = order.indexOf(LEGACY_PORTS_PANEL_ID);
    if (legacyIdx !== -1 && !order.includes(PORTS_EXT_PANEL_ID)) {
      order[legacyIdx] = PORTS_EXT_PANEL_ID;
    }
    if (LEGACY_PORTS_PANEL_ID in collapsed && !(PORTS_EXT_PANEL_ID in collapsed)) {
      collapsed[PORTS_EXT_PANEL_ID] = collapsed[LEGACY_PORTS_PANEL_ID];
    }
    if (LEGACY_PORTS_PANEL_ID in sizes && !(PORTS_EXT_PANEL_ID in sizes)) {
      sizes[PORTS_EXT_PANEL_ID] = sizes[LEGACY_PORTS_PANEL_ID];
    }
    delete collapsed[LEGACY_PORTS_PANEL_ID];
    delete sizes[LEGACY_PORTS_PANEL_ID];
    // Collapse/size carry-over for the sunset SESSIONS pane → PROJECTS (the
    // order rewrite already happened above, ahead of the id backfill).
    // Checked against the *stored* object, not the default-merged one —
    // DEFAULT_PANEL_STATE always carries a "projects" key, so the merged
    // maps can never lack it.
    const storedCollapsed: Record<string, unknown> = parsed.collapsed ?? {};
    const storedSizes: Record<string, unknown> = parsed.sizes ?? {};
    if (LEGACY_SESSIONS_PANEL_ID in storedCollapsed && !("projects" in storedCollapsed)) {
      collapsed.projects = collapsed[LEGACY_SESSIONS_PANEL_ID];
    }
    if (LEGACY_SESSIONS_PANEL_ID in storedSizes && !("projects" in storedSizes)) {
      sizes.projects = sizes[LEGACY_SESSIONS_PANEL_ID];
    }
    delete collapsed[LEGACY_SESSIONS_PANEL_ID];
    delete sizes[LEGACY_SESSIONS_PANEL_ID];
    // One-time reorder: builds that predate declared panel order (see
    // RegisteredSidebarPanel.order) appended TASKS after PORTS in plain
    // registration order. Guarded by PANEL_MIGRATIONS_KEY — rerunning would
    // fight a user who has since dragged PORTS back above TASKS. Marked
    // applied even when there's nothing to move: for state without both ids
    // the ordered insertion in the reconciliation effect places TASKS
    // correctly on its own.
    const migrations = appliedPanelMigrations();
    if (!migrations.includes("tasks-above-ports") || tasksOrderMigratedThisLoad) {
      const tasksIdx = order.indexOf(TASKS_EXT_PANEL_ID);
      const portsIdx = order.indexOf(PORTS_EXT_PANEL_ID);
      if (portsIdx !== -1 && tasksIdx > portsIdx) {
        order.splice(tasksIdx, 1);
        order.splice(portsIdx, 0, TASKS_EXT_PANEL_ID);
      }
      if (!migrations.includes("tasks-above-ports")) {
        localStorage.setItem(
          PANEL_MIGRATIONS_KEY,
          JSON.stringify([...migrations, "tasks-above-ports"]),
        );
      }
      tasksOrderMigratedThisLoad = true;
    }
    return { order: order.filter((id) => id !== LEGACY_PORTS_PANEL_ID && id !== LEGACY_SESSIONS_PANEL_ID), collapsed, sizes };
  } catch {
    return { ...DEFAULT_PANEL_STATE };
  }
}

// Cross-device slice of the layout: what the user has deliberately
// arranged. Active tabs stay local (which view you were last looking at is
// per-device), same split the older sidebarTabsOrder key used.
export interface SyncedSidebarLayout {
  left: string[];
  right: string[];
  panelHome: Record<string, string>;
  // Which panes the user hid — an arrangement decision like the others, so
  // it travels with them.
  hiddenPanels?: string[];
}

const LAYOUT_KEY = "sidebarLayout";
// Replaced by LAYOUT_KEY. Read once for the migration below so an existing
// install keeps its dragged tab order and active tab.
const LEGACY_TABS_KEY = "sidebarTabs";

function loadLayout(): SidebarLayout {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
    if (parsed && typeof parsed === "object") {
      return sanitizeLayout({
        left: Array.isArray(parsed.left) ? parsed.left : [],
        right: Array.isArray(parsed.right) ? parsed.right : [],
        active: {
          left: typeof parsed.active?.left === "string" ? parsed.active.left : "",
          right: typeof parsed.active?.right === "string" ? parsed.active.right : "",
        },
        panelHome:
          parsed.panelHome && typeof parsed.panelHome === "object" ? parsed.panelHome : {},
        hiddenPanels: Array.isArray(parsed.hiddenPanels) ? parsed.hiddenPanels : [],
      });
    }
    // Pre-right-sidebar state: one order and one active tab, all left.
    const legacy = JSON.parse(localStorage.getItem(LEGACY_TABS_KEY) ?? "null");
    if (legacy && typeof legacy === "object" && Array.isArray(legacy.order)) {
      return sanitizeLayout({
        left: legacy.order,
        right: [],
        active: { left: typeof legacy.active === "string" ? legacy.active : EXPLORER_TAB_ID, right: "" },
        panelHome: {},
        hiddenPanels: [],
      });
    }
  } catch {
    // Fall through to the default below.
  }
  return sanitizeLayout({ ...DEFAULT_LAYOUT });
}

// A drag in progress, shared by both tab strips so each can draw the drop
// indicator that belongs to it (the strip under the pointer may not be the
// strip the drag started in).
export interface TabDragState {
  draggedId: string;
  // "left"/"right" mark an insertion point beside a tab, "end" the tail of a
  // strip, and "body" the panel area of a sidebar — dropping there turns the
  // dragged tab into a SECTION of that sidebar's active tab rather than
  // moving the tab itself.
  indicator: { side: SidebarSide; tabId: string | null; edge: "left" | "right" | "end" | "body" } | null;
}

export function useSidebarLayout(
  extensionPanels: RegisteredSidebarPanel[],
  sidebarTabs: RegisteredSidebarTab[],
  extensionsSettled: boolean,
  syncedLayout: SyncedSidebarLayout | null,
  onLayoutChange: (layout: SyncedSidebarLayout) => void,
  sidebarVisible: Record<SidebarSide, boolean>,
  setSidebarVisible: (side: SidebarSide, visible: boolean) => void,
) {
  const [layout, setLayout] = useState<SidebarLayout>(loadLayout);
  const [panelState, setPanelState] = useState<PanelState>(loadPanelState);
  const [tabDrag, setTabDrag] = useState<TabDragState | null>(null);

  // Every section that can appear in a tab: the two built-in Explorer
  // sections plus every registered extension panel, whatever its location —
  // a "tab" panel is a section too once it's been moved into an accordion.
  const panelsById = useMemo(() => {
    const map = new Map<string, PanelLike>();
    for (const id of BUILTIN_PANEL_IDS) map.set(id, { id, location: "explorer" });
    for (const p of extensionPanels) {
      map.set(p.id, { id: p.id, location: p.location, hidden: p.hidden, defaultTab: p.defaultTab });
    }
    return map;
  }, [extensionPanels]);

  // What the layout's remembered ids can resolve against right now — see
  // TabEnv. Container tabs are the extension tabs with no panel of their own.
  const env = useMemo<TabEnv>(
    () => ({
      panels: panelsById,
      containers: new Set(sidebarTabs.map((t) => t.id)),
      settled: extensionsSettled,
    }),
    [panelsById, sidebarTabs, extensionsSettled],
  );

  // A container tab joins its requested side the first time it registers;
  // after that its stored place wins. Like the reconciliation below, never
  // pushed to the synced layout by itself.
  useEffect(() => {
    setLayout((prev) => sidebarTabs.reduce((acc, tab) => addTabToSide(acc, tab.id, tab.side), prev));
  }, [sidebarTabs]);

  // Append-only reconciliation, for both halves. Never prunes: an id whose
  // extension is still activating would otherwise be dropped and lose its
  // stored place (the race documented in Sidebar.tsx before this moved).
  // Stale ids are filtered at render instead.
  useEffect(() => {
    setLayout((prev) => {
      const known = new Set([...prev.left, ...prev.right]);
      // A defaultTab pane is excluded: it belongs to another panel's tab and
      // has no tab of its own, so it must never take a slot in the strip.
      const added = extensionPanels.filter(
        (p) => p.location === "tab" && !p.defaultTab && !known.has(p.id),
      );
      if (added.length === 0) return prev;
      return { ...prev, left: [...prev.left, ...added.map((p) => p.id)] };
    });
    setPanelState((prev) => {
      const order = [...prev.order];
      // Tab panels join the order too, now that any of them can be moved
      // into an accordion — sectionsForTab filters by home, so an id sitting
      // in the order costs nothing until it's actually moved.
      const candidates = extensionPanels;
      const byId = new Map(candidates.map((p) => [p.id, p]));
      for (const panel of candidates) {
        if (order.includes(panel.id)) continue;
        let at = order.length;
        if (panel.order !== undefined) {
          const idx = order.findIndex((id) => {
            const other = byId.get(id);
            return (
              other !== undefined &&
              other.location === panel.location &&
              (other.order === undefined || other.order > panel.order!)
            );
          });
          if (idx !== -1) at = idx;
        }
        order.splice(at, 0, panel.id);
      }
      return order.length === prev.order.length ? prev : { ...prev, order };
    });
  }, [extensionPanels]);

  // Cross-device layout, applied once per mount the first time it arrives
  // non-empty — never re-applied, so it can't fight a later local drag.
  const appliedSyncedRef = useRef(false);
  useEffect(() => {
    if (appliedSyncedRef.current || !syncedLayout) return;
    if (syncedLayout.left.length === 0 && syncedLayout.right.length === 0) return;
    appliedSyncedRef.current = true;
    setLayout((prev) =>
      sanitizeLayout({
        left: syncedLayout.left,
        right: syncedLayout.right,
        active: prev.active,
        panelHome: syncedLayout.panelHome ?? {},
        hiddenPanels: syncedLayout.hiddenPanels ?? prev.hiddenPanels,
      }),
    );
  }, [syncedLayout]);

  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    // stateRef (read by the bridge) is current by now, so a reveal waiting
    // on a just-placed tab can find its side.
    flushPendingTabReveals();
  }, [layout]);

  useEffect(() => {
    localStorage.setItem(PANELS_KEY, JSON.stringify(panelState));
  }, [panelState]);

  // Only a deliberate arrangement is pushed to the settings doc — never the
  // reconciliation above, whose appends happen on every load.
  const pushSynced = useCallback(
    (next: SidebarLayout) => {
      onLayoutChange({
        left: next.left,
        right: next.right,
        panelHome: next.panelHome,
        hiddenPanels: next.hiddenPanels,
      });
    },
    [onLayoutChange],
  );

  const selectTab = useCallback((tabId: string) => {
    setLayout((prev) => selectTabIn(prev, tabId));
  }, []);

  const moveTab = useCallback(
    (tabId: string, side: SidebarSide, index: number) => {
      setLayout((prev) => {
        const next = moveTabToSide(prev, tabId, side, index);
        if (next === prev) return prev;
        pushSynced(next);
        return next;
      });
      // A tab dragged onto a hidden side is a request to see that side.
      setSidebarVisible(side, true);
    },
    [pushSynced, setSidebarVisible],
  );

  // Show/hide a pane from the gear menu's Panes list.
  const togglePanel = useCallback(
    (panelId: string) => {
      setLayout((prev) => {
        const next = togglePanelHidden(prev, panelId);
        pushSynced(next);
        return next;
      });
    },
    [pushSynced],
  );

  const movePanel = useCallback(
    (panelId: string, tabId: string) => {
      setLayout((prev) => {
        const panel = panelsById.get(panelId);
        if (!panel) return prev;
        const next = movePanelToTab(prev, panel, tabId);
        if (next.panelHome[panelId] === prev.panelHome[panelId]) return prev;
        // Show what just moved, on whichever side its new tab lives.
        const withActive = sideOfTab(next, tabId) ? selectTabIn(next, tabId) : next;
        pushSynced(withActive);
        return withActive;
      });
      const side = sideOfTab(layout, tabId);
      if (side) setSidebarVisible(side, true);
    },
    [panelsById, pushSynced, layout, setSidebarVisible],
  );

  // Reorder within one side, expressed over that side's VISIBLE tabs (what
  // the user actually dragged among); ids hidden right now ride along at
  // their stored index so a reorder can neither prune nor relocate them.
  const reorderTab = useCallback(
    (tabId: string, side: SidebarSide, visibleIndex: number) => {
      setLayout((prev) => {
        const visible = visibleTabsForSide(prev, side, panelState.order, env).filter(
          (id) => id !== tabId,
        );
        const anchor = visible[visibleIndex];
        const full = prev[side].filter((id) => id !== tabId);
        const at = anchor === undefined ? full.length : full.indexOf(anchor);
        const next = moveTabToSide(prev, tabId, side, at === -1 ? full.length : at);
        if (next === prev) return prev;
        pushSynced(next);
        return next;
      });
    },
    [panelState.order, env, pushSynced],
  );

  // What each side actually renders this frame.
  const view = useMemo(() => {
    const forSide = (side: SidebarSide) => {
      const tabs = visibleTabsForSide(layout, side, panelState.order, env);
      return { tabs, activeTabId: resolveActive(layout, side, tabs) };
    };
    return { left: forSide("left"), right: forSide("right") };
  }, [layout, panelState.order, env]);

  // One bridge for both sides — extensions.ts resolves a tab or panel id to
  // its side at call time, so "reveal Source Control" works wherever the
  // user has put it. Registered once with refs kept fresh, matching the
  // handler-registration pattern App.tsx uses elsewhere.
  const stateRef = useRef({ layout, panelsById, env, panelOrder: panelState.order, sidebarVisible });
  stateRef.current = { layout, panelsById, env, panelOrder: panelState.order, sidebarVisible };
  const selectTabRef = useRef(selectTab);
  selectTabRef.current = selectTab;
  const setVisibleRef = useRef(setSidebarVisible);
  setVisibleRef.current = setSidebarVisible;
  // A deliberate deletion, so it is pushed to the synced layout.
  const removeTab = useCallback(
    (tabId: string) => {
      setLayout((prev) => {
        const next = removeTabFromLayout(prev, tabId);
        pushSynced(next);
        return next;
      });
    },
    [pushSynced],
  );
  const removeTabRef = useRef(removeTab);
  removeTabRef.current = removeTab;
  useEffect(() => {
    setSidebarLayoutBridge({
      sideOfTab: (tabId: string) => sideOfTab(stateRef.current.layout, tabId),
      tabOfPanel: (panelId: string) => {
        const { layout: l, panelsById: panels, env: e } = stateRef.current;
        const panel = panels.get(panelId);
        return panel ? tabOfPanel(l, panel, e) : null;
      },
      isTabVisible: (tabId: string) => {
        const { layout: l, env: e, panelOrder } = stateRef.current;
        return isTabVisible(tabId, panelOrder, e, l);
      },
      getActive: (side: SidebarSide) => {
        const { layout: l, env: e, panelOrder } = stateRef.current;
        return resolveActive(l, side, visibleTabsForSide(l, side, panelOrder, e));
      },
      selectTab: (tabId: string) => selectTabRef.current(tabId),
      isVisible: (side: SidebarSide) => stateRef.current.sidebarVisible[side],
      setVisible: (side: SidebarSide, visible: boolean) => setVisibleRef.current(side, visible),
      removeTab: (tabId: string) => removeTabRef.current(tabId),
    });
    return () => setSidebarLayoutBridge(null);
  }, []);

  return {
    layout,
    view,
    panelState,
    setPanelState,
    panelsById,
    env,
    selectTab,
    moveTab,
    reorderTab,
    movePanel,
    togglePanel,
    tabDrag,
    setTabDrag,
  };
}


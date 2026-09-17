// Pure model for the sidebars' tabs and where each panel lives. No React,
// no DOM — useSidebarLayout turns this into state, and Sidebar renders one
// side of it.
//
// Two things generalize what Sidebar.tsx used to hold privately:
//   - a tab list PER SIDE, so a tab can be dragged to a second (right)
//     sidebar;
//   - panelHome, which overrides a panel's registered `location`, so any
//     section can be moved into any tab.
// Everything a tab shows is then one question — "which sections call this
// tab home?" — asked identically for the Explorer/Run/Commands accordions
// and for an extension's own tab (Source Control, Search).

export type SidebarSide = "left" | "right";

export const SIDES: readonly SidebarSide[] = ["left", "right"];

// Kept here rather than in Sidebar.tsx so extensions.ts can import them
// without the circular dependency that made it keep private copies.
export const EXPLORER_TAB_ID = "explorer";
export const RUN_TAB_ID = "run-view";
export const COMMANDS_TAB_ID = "commands-view";
export const EXTENSIONS_TAB_ID = "extensions-view";
export const CORE_TAB_IDS: readonly string[] = [
  EXPLORER_TAB_ID,
  RUN_TAB_ID,
  COMMANDS_TAB_ID,
  EXTENSIONS_TAB_ID,
];

// The built-in Explorer sections. They aren't extension panels, but every
// question below is asked of them the same way, so they enter the model as
// ordinary PanelLikes homed to Explorer by default.
export const BUILTIN_PANEL_IDS: readonly string[] = ["projects", "files"];

export type PanelLocation = "tab" | "explorer" | "run" | "commands";

export interface PanelLike {
  id: string;
  location: PanelLocation;
  // An extension asked for this section to be absent for now
  // (ctx.app.setSidebarPanelVisible) — absent, not forgotten: it keeps its
  // stored order/home.
  hidden?: boolean;
  // This section lives inside ANOTHER panel's tab and has no tab of its own
  // — it is a pane of that panel, not a panel in its own right. Lets one
  // extension ship two stacked sections in one tab (git-scm's SOURCE
  // CONTROL + COMMITS), each independently collapsible, resizable and
  // movable, without the second one turning into a tab-strip entry nobody
  // asked for. It can still be dragged to any OTHER tab; what it can't do
  // is stand alone (see ownTabForPanel).
  defaultTab?: string;
}

export interface SidebarLayout {
  left: string[];
  right: string[];
  // "" means "this side has no active tab" (an empty right sidebar).
  active: Record<SidebarSide, string>;
  // panelId → tabId, only for panels the user actually moved. A panel with
  // no entry lives wherever its registration says.
  panelHome: Record<string, string>;
  // Panels the USER hid, from the gear menu's Panes list. Distinct from
  // PanelLike.hidden, which an extension sets for context ("nothing to show
  // right now"): the two are ORed, so an extension can never un-hide
  // something the user hid, or the reverse.
  hiddenPanels: string[];
}

// What exists right now, as opposed to what the stored layout remembers:
// the registered sections, the extension-owned tabs that hold no section of
// their own ("containers", see registerSidebarTab), and whether extension
// loading has settled. Runtime-only, never persisted or synced, which is
// why it travels beside SidebarLayout rather than inside it.
export interface TabEnv {
  panels: ReadonlyMap<string, PanelLike>;
  containers: ReadonlySet<string>;
  // False until the first extension load finishes (or gives up waiting):
  // until then an unknown tab may simply belong to an extension that
  // hasn't registered yet.
  settled: boolean;
}

export const DEFAULT_LAYOUT: SidebarLayout = {
  left: [...CORE_TAB_IDS],
  right: [],
  active: { left: EXPLORER_TAB_ID, right: "" },
  panelHome: {},
  hiddenPanels: [],
};

export function otherSide(side: SidebarSide): SidebarSide {
  return side === "left" ? "right" : "left";
}

// The tab a panel can always stand up for itself — its own id, since for
// the "tab" location the tab id and the panel id are the same string. That
// sameness is what lets "move Search into Explorer" and "move it back" be
// the same operation. Empty for a panel with no tab to own: an accordion
// section, or a defaultTab pane, which is a section of somebody else's tab
// wherever it goes.
export function ownTabForPanel(panel: PanelLike): string {
  return panel.location === "tab" && !panel.defaultTab ? panel.id : "";
}

// Where a panel lives when the user has never moved it.
export function defaultTabForPanel(panel: PanelLike): string {
  switch (panel.location) {
    case "explorer":
      return EXPLORER_TAB_ID;
    case "run":
      return RUN_TAB_ID;
    case "commands":
      return COMMANDS_TAB_ID;
    default:
      // Its own tab (see ownTabForPanel), unless the panel registered as a
      // pane of another one, whose tab is then its home.
      return panel.defaultTab ?? panel.id;
  }
}

// A tab something currently stands behind: a core tab, a registered
// container tab, or the own tab of a registered tab panel. Anything else is
// a remembered id whose owner is gone (disabled, uninstalled) or not loaded
// yet.
export function isKnownTab(tabId: string, env: TabEnv): boolean {
  if (CORE_TAB_IDS.includes(tabId) || env.containers.has(tabId)) return true;
  const panel = env.panels.get(tabId);
  return !!panel && ownTabForPanel(panel) === tabId;
}

// Where a panel shows. A stored home whose tab is unknown is kept, not
// forgotten: once extensions have settled the panel shows at its default
// home instead, and before that it stays in the (invisible) unknown tab so
// it doesn't flash somewhere else while its tab's owner is still loading.
// When the owner comes back the stored home is known again and wins.
export function tabOfPanel(layout: SidebarLayout, panel: PanelLike, env: TabEnv): string {
  const home = layout.panelHome[panel.id];
  if (home === undefined || isKnownTab(home, env)) return home ?? defaultTabForPanel(panel);
  return env.settled ? defaultTabForPanel(panel) : home;
}

export function sideOfTab(layout: SidebarLayout, tabId: string): SidebarSide | null {
  if (layout.left.includes(tabId)) return "left";
  if (layout.right.includes(tabId)) return "right";
  return null;
}

// Guarantees the invariants every consumer assumes: no id on both sides (or
// twice on one), and all four core tabs present. A missing core id lands on
// the LEFT in the documented order — each insertion goes right after
// Explorer, so applying them in reverse yields Explorer → Run → Commands →
// Extensions (the same trick Sidebar.tsx's sanitizeTabsOrder used).
export function sanitizeLayout(layout: SidebarLayout): SidebarLayout {
  const seen = new Set<string>();
  const dedupe = (ids: string[]) =>
    ids.filter((id) => {
      if (typeof id !== "string" || id === "" || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  const left = dedupe(layout.left ?? []);
  const right = dedupe(layout.right ?? []);

  if (!seen.has(EXPLORER_TAB_ID)) left.unshift(EXPLORER_TAB_ID);
  const afterExplorer = (id: string) => {
    if (seen.has(id)) return;
    const at = left.indexOf(EXPLORER_TAB_ID);
    left.splice(at === -1 ? left.length : at + 1, 0, id);
    seen.add(id);
  };
  seen.add(EXPLORER_TAB_ID);
  afterExplorer(EXTENSIONS_TAB_ID);
  afterExplorer(COMMANDS_TAB_ID);
  afterExplorer(RUN_TAB_ID);

  const active: Record<SidebarSide, string> = {
    left: left.includes(layout.active?.left) ? layout.active.left : (left[0] ?? ""),
    right: right.includes(layout.active?.right) ? layout.active.right : (right[0] ?? ""),
  };
  const panelHome: Record<string, string> = {};
  for (const [panelId, tabId] of Object.entries(layout.panelHome ?? {})) {
    if (typeof tabId === "string" && tabId !== "") panelHome[panelId] = tabId;
  }
  const hiddenPanels = (layout.hiddenPanels ?? []).filter(
    (id): id is string => typeof id === "string" && id !== "",
  );
  return { left, right, active, panelHome, hiddenPanels: [...new Set(hiddenPanels)] };
}

// The sections a tab shows, in the shared accordion order. `panels` carries
// every candidate section (built-ins included); an id with no entry is
// stale storage and drops out here rather than being pruned.
export function isPanelHidden(layout: SidebarLayout, panel: PanelLike): boolean {
  return !!panel.hidden || layout.hiddenPanels.includes(panel.id);
}

export function sectionsForTab(
  panelOrder: readonly string[],
  env: TabEnv,
  layout: SidebarLayout,
  tabId: string,
): string[] {
  return panelOrder.filter((id) => {
    const panel = env.panels.get(id);
    return !!panel && !isPanelHidden(layout, panel) && tabOfPanel(layout, panel, env) === tabId;
  });
}

// Flips a panel's user-hidden state. A hidden panel leaves its tab (and the
// tab retires with it when it was the last one) but keeps its stored home
// and order, so showing it again puts it back where it was.
export function togglePanelHidden(layout: SidebarLayout, panelId: string): SidebarLayout {
  const hidden = layout.hiddenPanels.includes(panelId)
    ? layout.hiddenPanels.filter((id) => id !== panelId)
    : [...layout.hiddenPanels, panelId];
  return { ...layout, hiddenPanels: hidden };
}

// Explorer and Extensions always show (Explorer is the fallback tab and can
// legitimately be empty; Extensions renders the extension manager, not
// sections), and so does a container tab, which exists to be dropped into.
// Every other tab — the Run/Commands accordions and each extension's own
// tab — shows only while something calls it home, so moving a tab's last
// section away retires the tab with it. An unknown tab never shows.
export function isTabVisible(
  tabId: string,
  panelOrder: readonly string[],
  env: TabEnv,
  layout: SidebarLayout,
): boolean {
  if (tabId === EXPLORER_TAB_ID || tabId === EXTENSIONS_TAB_ID || env.containers.has(tabId)) return true;
  if (!isKnownTab(tabId, env)) return false;
  return sectionsForTab(panelOrder, env, layout, tabId).length > 0;
}

export function visibleTabsForSide(
  layout: SidebarLayout,
  side: SidebarSide,
  panelOrder: readonly string[],
  env: TabEnv,
): string[] {
  return layout[side].filter((id) => isTabVisible(id, panelOrder, env, layout));
}

// The tab a side actually renders: its stored choice while that's still
// visible, else the first visible tab, else null (an empty side).
export function resolveActive(
  layout: SidebarLayout,
  side: SidebarSide,
  visibleTabs: readonly string[],
): string | null {
  const stored = layout.active[side];
  if (stored && visibleTabs.includes(stored)) return stored;
  return visibleTabs[0] ?? null;
}

export function selectTab(layout: SidebarLayout, tabId: string): SidebarLayout {
  const side = sideOfTab(layout, tabId);
  if (!side || layout.active[side] === tabId) return layout;
  return { ...layout, active: { ...layout.active, [side]: tabId } };
}

// Moves a tab within a side (reorder) or across sides. The destination side
// activates what just landed there — a tab you dragged is a tab you want to
// see — and a side left empty forgets its active tab.
export function moveTabToSide(
  layout: SidebarLayout,
  tabId: string,
  side: SidebarSide,
  index: number,
): SidebarLayout {
  const from = sideOfTab(layout, tabId);
  if (!from) return layout;
  const left = layout.left.filter((id) => id !== tabId);
  const right = layout.right.filter((id) => id !== tabId);
  const target = side === "left" ? left : right;
  const at = Math.max(0, Math.min(index, target.length));
  target.splice(at, 0, tabId);
  const active = { ...layout.active, [side]: tabId };
  if (from !== side) {
    const source = from === "left" ? left : right;
    if (layout.active[from] === tabId) active[from] = source[0] ?? "";
  }
  return { ...layout, left, right, active };
}

// Places a tab that isn't on either side yet at the end of `side`. A tab
// already placed stays where the user put it.
export function addTabToSide(layout: SidebarLayout, tabId: string, side: SidebarSide): SidebarLayout {
  if (sideOfTab(layout, tabId)) return layout;
  return { ...layout, [side]: [...layout[side], tabId] };
}

// Deletes a tab outright: gone from both sides, and every section that
// called it home goes back to its default home. Not what happens when a
// tab's owner is merely disabled — that keeps the homes (see tabOfPanel).
export function removeTabFromLayout(layout: SidebarLayout, tabId: string): SidebarLayout {
  const left = layout.left.filter((id) => id !== tabId);
  const right = layout.right.filter((id) => id !== tabId);
  const panelHome: Record<string, string> = {};
  for (const [panelId, home] of Object.entries(layout.panelHome)) {
    if (home !== tabId) panelHome[panelId] = home;
  }
  const active = {
    left: layout.active.left === tabId ? (left[0] ?? "") : layout.active.left,
    right: layout.active.right === tabId ? (right[0] ?? "") : layout.active.right,
  };
  return { ...layout, left, right, active, panelHome };
}

// Rehomes a section. Moving it back to where its registration puts it drops
// the override entirely, so the stored layout only ever records real
// deviations (and a panel whose extension later changes its own location
// follows that change).
export function movePanelToTab(
  layout: SidebarLayout,
  panel: PanelLike,
  tabId: string,
): SidebarLayout {
  const panelHome = { ...layout.panelHome };
  // "" means "reset", the same outcome as naming the panel's own default —
  // never a home in its own right, which would strand the section in a tab
  // that doesn't exist.
  if (tabId === "" || tabId === defaultTabForPanel(panel)) delete panelHome[panel.id];
  else panelHome[panel.id] = tabId;
  return { ...layout, panelHome };
}

// Every tab a section could be moved to, across both sides: the tabs
// actually on screen right now, plus the panel's own tab when it's an
// extension tab panel currently living elsewhere (nothing else would bring
// it back). Never the Extensions tab, whose body is the extension manager,
// and never the tab the panel is already in. Stale ids (an extension that
// isn't registered on this load) are excluded by the visibility test, so a
// move target always has a real name and a real destination.
export function moveTargetsForPanel(
  layout: SidebarLayout,
  panel: PanelLike,
  panelOrder: readonly string[],
  env: TabEnv,
): { tabId: string; side: SidebarSide }[] {
  const targets: { tabId: string; side: SidebarSide }[] = [];
  for (const side of SIDES) {
    for (const tabId of visibleTabsForSide(layout, side, panelOrder, env)) {
      if (tabId === EXTENSIONS_TAB_ID) continue;
      targets.push({ tabId, side });
    }
  }
  // Not defaultTabForPanel: an ordinary tab panel currently living in an
  // accordion has a tab of its own to go back to, and that tab is invisible
  // (nothing homes there) while it's away, so the loop above never finds
  // it. A defaultTab pane owns no tab and so adds nothing here.
  const own = ownTabForPanel(panel);
  if (own && !targets.some((t) => t.tabId === own)) {
    targets.push({ tabId: own, side: sideOfTab(layout, own) ?? "left" });
  }
  return targets.filter((t) => t.tabId !== tabOfPanel(layout, panel, env));
}

// ---- Stored shapes ----
//
// The parsers below read values that came back from localStorage or the
// settings document, so every one of them is defensive in the same way: a
// malformed value yields null and the caller falls back to its own defaults,
// rather than throwing and taking a whole sidebar down with it.
//
// They live here rather than beside their localStorage accessors in
// settings.ts because client/vitest.config.ts runs a node environment and
// covers pure logic only — a parser next to a `localStorage` call can't be
// tested. settings.ts re-exports them.

// The accordion's arrangement: which sections, in what order, which are
// collapsed, and how the expanded ones share the height.
export interface PanelState {
  order: string[];
  collapsed: Record<string, boolean>;
  // Relative flex-grow weights for expanded panels. Values are seeded from
  // measured pixel heights on resize, but any positive number works — flex
  // only cares about the ratio between siblings, not the absolute value,
  // which is also what lets this travel between differently sized screens.
  sizes: Record<string, number>;
}

// The cross-device slice of the tab layout: what the user deliberately
// arranged. Active tabs are deliberately NOT part of it — which view you
// were last looking at is per-device.
export interface StoredSidebarLayout {
  left: string[];
  right: string[];
  panelHome: Record<string, string>;
  // Which panes the user hid. An arrangement decision like the others, so it
  // travels with them.
  hiddenPanels: string[];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string" && s !== "") : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSidebarLayout(value: unknown): StoredSidebarLayout | null {
  if (!isPlainObject(value)) return null;
  const left = asStringArray(value.left);
  const right = asStringArray(value.right);
  if (left.length === 0 && right.length === 0) return null;
  const panelHome: Record<string, string> = {};
  if (isPlainObject(value.panelHome)) {
    for (const [k, tab] of Object.entries(value.panelHome)) {
      if (typeof tab === "string") panelHome[k] = tab;
    }
  }
  return { left, right, panelHome, hiddenPanels: asStringArray(value.hiddenPanels) };
}

// Null unless there is an `order` to speak of: without one there is no
// arrangement to restore, and the caller's DEFAULT_PANEL_STATE is a better
// answer than a half-empty object. Any string id is accepted — an id whose
// extension isn't registered right now keeps its slot and is filtered at
// render time, the never-prune rule the rest of this module follows.
export function parsePanelState(value: unknown): PanelState | null {
  if (!isPlainObject(value)) return null;
  const order = asStringArray(value.order);
  if (order.length === 0) return null;
  const collapsed: Record<string, boolean> = {};
  if (isPlainObject(value.collapsed)) {
    for (const [id, flag] of Object.entries(value.collapsed)) {
      if (typeof flag === "boolean") collapsed[id] = flag;
    }
  }
  // Only finite positive weights: a 0, a negative or a NaN would collapse a
  // pane to nothing with no way to drag it back.
  const sizes: Record<string, number> = {};
  if (isPlainObject(value.sizes)) {
    for (const [id, size] of Object.entries(value.sizes)) {
      if (typeof size === "number" && Number.isFinite(size) && size > 0) sizes[id] = size;
    }
  }
  return { order, collapsed, sizes };
}

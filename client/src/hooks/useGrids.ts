import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import * as api from "../api";
import type { RegisteredManagedGrid } from "../extensions";
import type { PickItem } from "../lib/pickFilter";
import {
  addCell,
  adoptCell,
  adjacentCellId,
  gridChipKey,
  hideCellWindow,
  reconcileManagedGrid,
  directionalCellId,
  type GridDirection,
  hasWindow,
  neighborAfterRemoval,
  nextGridName,
  removeCell,
  setTracks,
  swapCells,
  toggleZoom,
  type Grid,
  type GridCell,
} from "../lib/grids";
import { isRealTab } from "../lib/tabs";
import { randomUUID } from "../lib/uuid";
import type { MenuItem, Tab, TerminalSession } from "../types";

type SetActiveTabIdArg = string | null | ((current: string | null) => string | null);

export interface UseGridsDeps {
  tabsRef: MutableRefObject<Tab[]>;
  setTabs: Dispatch<SetStateAction<Tab[]>>;
  grids: Record<string, Grid>;
  gridsRef: MutableRefObject<Record<string, Grid>>;
  setGrids: Dispatch<SetStateAction<Record<string, Grid>>>;
  sessions: TerminalSession[];
  sessionsRef: MutableRefObject<TerminalSession[]>;
  splitLayoutRef: MutableRefObject<{ activeGroupId: string; groupActive: Record<string, string | null> }>;
  setActiveTabId: (arg: SetActiveTabIdArg, groupId?: string) => void;
  focusGroup: (groupId: string) => void;
  removeTabsForMove: (ids: string[]) => void;
  projectKeyForSession: (sessionName: string) => string;
  projectLabelForSession: (sessionName: string) => string;
  refresh: () => Promise<void>;
  promptDialog: (message: string, defaultValue?: string) => Promise<string | null>;
  pickDialog: (opts: { title: string; items: PickItem[]; current?: string; placeholder?: string }) => Promise<string | null>;
  // Extension-managed grids (ctx.registerManagedGrid) and whether the first
  // extension load has settled — a managed grid whose provider is missing
  // after that is dropped (spec R18).
  managedGrids: RegisteredManagedGrid[];
  extensionsSettled: boolean;
  showError: (err: unknown) => void;
}

function insertAfter(prev: Tab[], tab: Tab, anchorId: string | null | undefined): Tab[] {
  const i = anchorId ? prev.findIndex((t) => t.id === anchorId) : -1;
  if (i === -1) return [...prev, tab];
  return [...prev.slice(0, i + 1), tab, ...prev.slice(i + 1)];
}

function emptyGrid(projectKey: string, existingNames: string[]): Grid {
  return {
    id: randomUUID(),
    projectKey,
    name: nextGridName(existingNames),
    cells: [],
    colSizes: [],
    rowSizes: [],
    zoomedCellId: null,
  };
}

// Every user action on project grid tabs (plans/project-grid-tab.md, spec
// R14–R24) plus the menu items that reach them. State lives in useTabs
// (`tabs`, `grids`); this hook only mutates it. Anything that creates a grid
// sets the grid and its first tab in one synchronous step, so useTabs'
// prune effect never sees a grid without a tab. Async paths read refs after
// each await, never the render closure (same rule as useTabs' openers).
export function useGrids(deps: UseGridsDeps) {
  const {
    tabsRef,
    setTabs,
    grids,
    gridsRef,
    setGrids,
    sessions,
    sessionsRef,
    splitLayoutRef,
    setActiveTabId,
    focusGroup,
    removeTabsForMove,
    projectKeyForSession,
    projectLabelForSession,
    refresh,
    promptDialog,
    pickDialog,
    managedGrids,
    extensionsSettled,
    showError,
  } = deps;

  const chipKeyOf = useCallback((g: Grid) => gridChipKey(g, projectKeyForSession), [projectKeyForSession]);

  // The grid's tab label (same rule as useTabs' tabLabel): its name alone
  // outside chips, prefixed by its project inside one.
  const gridLabel = useCallback(
    (g: Grid): string => {
      const chip = chipKeyOf(g);
      if (chip === null) return g.name;
      const session = g.cells.find((c) => projectKeyForSession(c.sessionName) === chip)?.sessionName;
      return session ? `${projectLabelForSession(session)} · ${g.name}` : g.name;
    },
    [chipKeyOf, projectKeyForSession, projectLabelForSession],
  );

  const primarySessionForProject = useCallback(
    (projectKey: string): TerminalSession | undefined =>
      sessionsRef.current.find((s) => (s.path || s.name) === projectKey),
    [sessionsRef],
  );

  const gridsOfProject = useCallback(
    (projectKey: string): Grid[] => Object.values(gridsRef.current).filter((g) => g.projectKey === projectKey),
    [gridsRef],
  );

  // A cell for an existing window: attach names are "@<windowId>" and
  // stateless server-side, so this only resolves the name.
  const mintCell = useCallback(
    async (sessionName: string, windowIndex: number): Promise<GridCell | null> => {
      try {
        const { attachName } = await api.openWindowTab(sessionName, windowIndex);
        return { id: randomUUID(), sessionName, windowIndex, attachName };
      } catch (err) {
        showError(err);
        return null;
      }
    },
    [showError],
  );

  // A brand-new window in `sessionName`, as a cell. Refreshes the session
  // list first so the window exists in `sessions` before the cell does.
  const newWindowCell = useCallback(
    async (sessionName: string): Promise<GridCell | null> => {
      let index: number;
      try {
        index = (await api.createWindow(sessionName)).index;
        await refresh();
      } catch (err) {
        showError(err);
        return null;
      }
      return mintCell(sessionName, index);
    },
    [refresh, mintCell, showError],
  );

  const setGrid = useCallback(
    (gridId: string, update: (g: Grid) => Grid | null) => {
      setGrids((prev) => {
        const g = prev[gridId];
        if (!g) return prev;
        const next = update(g);
        if (next === g) return prev;
        const out = { ...prev };
        if (next === null || (next.cells.length === 0 && next.providerId === undefined)) delete out[gridId];
        else out[gridId] = next;
        return out;
      });
    },
    [setGrids],
  );

  const setTabFocus = useCallback(
    (tabId: string, cellId: string | undefined) => {
      setTabs((prev) =>
        prev.some((t) => t.id === tabId && t.gridFocusedCellId !== cellId)
          ? prev.map((t) => (t.id === tabId ? { ...t, gridFocusedCellId: cellId } : t))
          : prev,
      );
    },
    [setTabs],
  );

  const gridTabFor = useCallback(
    (grid: Grid, editorGroupId: string, focusCellId: string | undefined): Tab => ({
      id: randomUUID(),
      sessionName: "",
      attachName: "",
      groupId: editorGroupId,
      gridId: grid.id,
      gridFocusedCellId: focusCellId ?? grid.cells[0]?.id,
      originSessionName: grid.cells[0]?.sessionName,
      originSessionId: grid.cells[0]?.sessionId,
    }),
    [],
  );

  // Activates the grid's tab in `editorGroupId`, or opens one there after
  // that pane's active tab.
  const openGridTab = useCallback(
    (gridId: string, editorGroupId: string, focusCellId?: string) => {
      const grid = gridsRef.current[gridId];
      if (!grid) return;
      const existing = tabsRef.current.find((t) => t.gridId === gridId && t.groupId === editorGroupId);
      if (existing) {
        if (focusCellId) setTabFocus(existing.id, focusCellId);
        focusGroup(editorGroupId);
        setActiveTabId(existing.id, editorGroupId);
        return;
      }
      const tab = gridTabFor(grid, editorGroupId, focusCellId);
      const anchor = splitLayoutRef.current.groupActive[editorGroupId] ?? null;
      setTabs((prev) => insertAfter(prev, tab, anchor));
      focusGroup(editorGroupId);
      setActiveTabId(tab.id, editorGroupId);
    },
    [gridsRef, tabsRef, setTabs, setTabFocus, focusGroup, setActiveTabId, gridTabFor, splitLayoutRef],
  );

  // Chip menu / dropdown / palette "New Grid" (R17): a new window in the
  // project, as the only cell of a new grid, opened in `editorGroupId`.
  const newGrid = useCallback(
    async (editorGroupId: string, projectKey: string) => {
      const session = primarySessionForProject(projectKey);
      if (!session) return;
      const cell = await newWindowCell(session.name);
      if (!cell) return;
      const grid = addCell(
        emptyGrid(
          projectKey,
          gridsOfProject(projectKey).map((g) => g.name),
        ),
        cell,
      );
      const tab = gridTabFor(grid, editorGroupId, cell.id);
      const anchor = splitLayoutRef.current.groupActive[editorGroupId] ?? null;
      setGrids((prev) => ({ ...prev, [grid.id]: grid }));
      setTabs((prev) => insertAfter(prev, tab, anchor));
      focusGroup(editorGroupId);
      setActiveTabId(tab.id, editorGroupId);
    },
    [primarySessionForProject, newWindowCell, gridsOfProject, gridTabFor, splitLayoutRef, setGrids, setTabs, focusGroup, setActiveTabId],
  );

  // Move to Grid / drop on a grid tab / Tile All (R18–R20): the terminal
  // tabs leave the bar and become cells, in order. A whole-session tab joins
  // as its session's active window. `target.preferTabId` names the grid tab
  // the user dropped onto, which then activates whatever pane it is in.
  const moveTabsToGrid = useCallback(
    async (
      tabIds: string[],
      target: { gridId: string; preferTabId?: string } | { newInProject: string },
    ) => {
      const moving = tabIds
        .map((id) => tabsRef.current.find((t) => t.id === id))
        .filter((t): t is Tab => t !== undefined && isRealTab(t));
      if (moving.length === 0) return;
      const sourceGroupId = moving[0].groupId ?? splitLayoutRef.current.activeGroupId;

      const pairs: { tabId: string; cell: GridCell }[] = [];
      for (const tab of moving) {
        if (tab.windowIndex !== undefined) {
          pairs.push({
            tabId: tab.id,
            cell: {
              id: randomUUID(),
              sessionName: tab.sessionName,
              windowIndex: tab.windowIndex,
              attachName: tab.attachName,
              sessionId: tab.sessionId,
              windowId: tab.windowId,
            },
          });
          continue;
        }
        const index = sessionsRef.current
          .find((s) => s.name === tab.sessionName)
          ?.windows.find((w) => w.active)?.index;
        if (index === undefined) continue;
        const cell = await mintCell(tab.sessionName, index);
        if (cell) pairs.push({ tabId: tab.id, cell });
      }
      if (pairs.length === 0) return;

      // From here on, synchronous: grid and tabs change in one step.
      let grid: Grid;
      if ("gridId" in target) {
        const current = gridsRef.current[target.gridId];
        if (!current) return;
        grid = current;
      } else {
        grid = emptyGrid(
          target.newInProject,
          gridsOfProject(target.newInProject).map((g) => g.name),
        );
      }
      let focusCellId: string | undefined;
      for (const { cell } of pairs) {
        const existing = hasWindow(grid, cell.sessionName, cell.windowIndex);
        if (existing) {
          focusCellId = existing.id;
          grid = adoptCell(grid, existing.id);
        } else {
          grid = addCell(grid, cell);
          focusCellId = cell.id;
        }
      }
      const finalGrid = grid;
      setGrids((prev) => ({ ...prev, [finalGrid.id]: finalGrid }));
      const movedIds = new Set(pairs.map((p) => p.tabId));

      const preferred =
        "gridId" in target && target.preferTabId
          ? tabsRef.current.find((t) => t.id === target.preferTabId && t.gridId === finalGrid.id)
          : undefined;
      const gridTab =
        preferred ??
        tabsRef.current.find((t) => t.gridId === finalGrid.id && t.groupId === sourceGroupId) ??
        tabsRef.current.find((t) => t.gridId === finalGrid.id);

      if (gridTab && gridTab.groupId !== sourceGroupId) {
        // The grid shows in another pane: the moved tabs leave theirs the
        // ordinary way (an emptied pane collapses), the grid tab activates.
        removeTabsForMove([...movedIds]);
        setTabFocus(gridTab.id, focusCellId);
        setActiveTabId(gridTab.id);
        return;
      }
      // The grid tab is (or becomes) a tab of the source pane, so that pane
      // never empties: a new grid tab takes the first moved tab's place.
      const newTab = gridTab ? null : gridTabFor(finalGrid, sourceGroupId, focusCellId);
      const firstMovedId = pairs[0].tabId;
      setTabs((prev) => {
        const out: Tab[] = [];
        for (const t of prev) {
          if (t.id === firstMovedId && newTab) out.push(newTab);
          if (movedIds.has(t.id)) continue;
          if (gridTab && t.id === gridTab.id) out.push({ ...t, gridFocusedCellId: focusCellId });
          else out.push(t);
        }
        return out;
      });
      focusGroup(sourceGroupId);
      setActiveTabId((newTab ?? gridTab)!.id, sourceGroupId);
    },
    [tabsRef, gridsRef, sessionsRef, splitLayoutRef, mintCell, gridsOfProject, setGrids, removeTabsForMove, setTabFocus, setActiveTabId, gridTabFor, setTabs, focusGroup],
  );

  const projectTerminalTabIds = useCallback(
    (editorGroupId: string, projectKey: string): string[] =>
      tabsRef.current
        .filter(
          (t) => t.groupId === editorGroupId && isRealTab(t) && projectKeyForSession(t.sessionName) === projectKey,
        )
        .map((t) => t.id),
    [tabsRef, projectKeyForSession],
  );

  // Tile All Terminals (R18): the pane's terminal tabs of the project join
  // the pane's grid of that project, or a new one.
  const tileAll = useCallback(
    async (editorGroupId: string, projectKey: string) => {
      const ids = projectTerminalTabIds(editorGroupId, projectKey);
      if (ids.length === 0) return;
      const existing = tabsRef.current.find(
        (t) =>
          t.groupId === editorGroupId &&
          t.gridId !== undefined &&
          gridsRef.current[t.gridId] !== undefined &&
          chipKeyOf(gridsRef.current[t.gridId]) === projectKey,
      );
      await moveTabsToGrid(
        ids,
        existing?.gridId ? { gridId: existing.gridId, preferTabId: existing.id } : { newInProject: projectKey },
      );
    },
    [projectTerminalTabIds, tabsRef, gridsRef, chipKeyOf, moveTabsToGrid],
  );

  const appendNewWindow = useCallback(
    async (gridId: string, tabId: string, sessionName: string) => {
      const cell = await newWindowCell(sessionName);
      if (!cell) return;
      setGrid(gridId, (g) => addCell(g, cell));
      setTabFocus(tabId, cell.id);
    },
    [newWindowCell, setGrid, setTabFocus],
  );

  // The session of the tab's focused cell, else the grid's first cell.
  const focusedSessionOf = useCallback(
    (grid: Grid, tabId: string): string | undefined => {
      const focused = tabsRef.current.find((t) => t.id === tabId)?.gridFocusedCellId;
      return (grid.cells.find((c) => c.id === focused) ?? grid.cells[0])?.sessionName;
    },
    [tabsRef],
  );

  // Add Terminal from Project… (spec R7): pick any project with a live
  // session, the focused cell's first; a new window there joins the grid.
  const addTerminalFromProject = useCallback(
    async (gridId: string, tabId: string) => {
      const grid = gridsRef.current[gridId];
      if (!grid) return;
      const byProject = new Map<string, TerminalSession>();
      for (const s of sessionsRef.current) {
        const key = s.path || s.name;
        if (!byProject.has(key)) byProject.set(key, s);
      }
      if (byProject.size === 0) return;
      const focusedSession = focusedSessionOf(grid, tabId);
      const currentKey = focusedSession ? projectKeyForSession(focusedSession) : grid.projectKey;
      const entries = [...byProject.entries()];
      entries.sort(([a], [b]) => (a === currentKey ? -1 : b === currentKey ? 1 : 0));
      const picked = await pickDialog({
        title: "Add Terminal from Project",
        placeholder: "Pick a project",
        items: entries.map(([key, s]) => ({
          id: s.name,
          label: projectLabelForSession(s.name),
          detail: s.path || undefined,
          icon: "folder",
          keywords: [key],
        })),
        current: byProject.get(currentKey)?.name,
      });
      if (!picked || !gridsRef.current[gridId]) return;
      await appendNewWindow(gridId, tabId, picked);
    },
    [gridsRef, sessionsRef, focusedSessionOf, projectKeyForSession, projectLabelForSession, pickDialog, appendNewWindow],
  );

  // Add Terminal (R8, R22, R23): a new window in the focused cell's project,
  // appended and focused in `tabId`. A managed grid with no cells has no
  // project to follow, so it asks.
  const addTerminalToGrid = useCallback(
    async (gridId: string, tabId: string) => {
      const grid = gridsRef.current[gridId];
      if (!grid) return;
      const sessionName =
        focusedSessionOf(grid, tabId) ??
        (grid.providerId === undefined ? primarySessionForProject(grid.projectKey)?.name : undefined);
      if (!sessionName) {
        await addTerminalFromProject(gridId, tabId);
        return;
      }
      await appendNewWindow(gridId, tabId, sessionName);
    },
    [gridsRef, focusedSessionOf, primarySessionForProject, addTerminalFromProject, appendNewWindow],
  );

  // A window tab for `cell`, right after `anchorId` in `groupId` — or the
  // pane's existing tab for that window.
  const windowTabFor = (cell: GridCell, groupId: string | undefined): Tab => ({
    id: randomUUID(),
    sessionName: cell.sessionName,
    attachName: cell.attachName,
    windowIndex: cell.windowIndex,
    sessionId: cell.sessionId,
    windowId: cell.windowId,
    groupId,
  });

  // Pop out (R14): the cell leaves the grid and opens as a window tab right
  // after the grid tab, activated. The last cell's pop-out ends the grid.
  const popOutCell = useCallback(
    (gridId: string, cellId: string, fromTabId: string) => {
      const grid = gridsRef.current[gridId];
      const cell = grid?.cells.find((c) => c.id === cellId);
      const fromTab = tabsRef.current.find((t) => t.id === fromTabId);
      if (!grid || !cell || !fromTab) return;
      const existing = tabsRef.current.find(
        (t) =>
          t.groupId === fromTab.groupId && t.sessionName === cell.sessionName && t.windowIndex === cell.windowIndex,
      );
      const tab = existing ?? windowTabFor(cell, fromTab.groupId);
      if (!existing) setTabs((prev) => insertAfter(prev, tab, fromTabId));
      const neighbor = neighborAfterRemoval(grid, cellId);
      setGrid(gridId, (g) => removeCell(hideCellWindow(g, cellId), cellId));
      setTabs((prev) =>
        prev.map((t) => (t.gridId === gridId && t.gridFocusedCellId === cellId ? { ...t, gridFocusedCellId: neighbor } : t)),
      );
      if (fromTab.groupId) focusGroup(fromTab.groupId);
      setActiveTabId(tab.id, fromTab.groupId);
    },
    [gridsRef, tabsRef, setTabs, setGrid, focusGroup, setActiveTabId],
  );

  // Pop Out All (R22): one window tab per cell after the grid tab, then the
  // grid ends (useTabs' prune effect closes its tabs).
  const popOutAll = useCallback(
    (gridId: string, fromTabId: string) => {
      const grid = gridsRef.current[gridId];
      const fromTab = tabsRef.current.find((t) => t.id === fromTabId);
      if (!grid || !fromTab) return;
      const created = grid.cells.map((c) => windowTabFor(c, fromTab.groupId));
      const focusIdx = Math.max(
        0,
        grid.cells.findIndex((c) => c.id === fromTab.gridFocusedCellId),
      );
      setTabs((prev) => {
        let out = prev;
        let anchor = fromTabId;
        for (const t of created) {
          out = insertAfter(out, t, anchor);
          anchor = t.id;
        }
        return out;
      });
      // A managed grid stays, empty, with its provider's windows hidden
      // (spec R16); any other grid ends.
      setGrid(gridId, (g) =>
        g.providerId === undefined
          ? null
          : g.cells.reduce((acc, c) => removeCell(hideCellWindow(acc, c.id), c.id), g),
      );
      if (fromTab.groupId) focusGroup(fromTab.groupId);
      if (created.length > 0) setActiveTabId(created[focusIdx].id, fromTab.groupId);
    },
    [gridsRef, tabsRef, setTabs, setGrid, focusGroup, setActiveTabId],
  );

  // Close (R14): detach only — the window stays alive. Focus moves to the
  // next cell (previous when it was last); the last cell's close ends the grid.
  // `hide` (a user's close, not a window's exit) keeps a provider cell's
  // window out of a managed grid until the provider stops wanting it.
  const closeCell = useCallback(
    (gridId: string, cellId: string, hide = true) => {
      const grid = gridsRef.current[gridId];
      if (!grid) return;
      const neighbor = neighborAfterRemoval(grid, cellId);
      setGrid(gridId, (g) => removeCell(hide ? hideCellWindow(g, cellId) : g, cellId));
      setTabs((prev) =>
        prev.some((t) => t.gridId === gridId && t.gridFocusedCellId === cellId)
          ? prev.map((t) =>
              t.gridId === gridId && t.gridFocusedCellId === cellId ? { ...t, gridFocusedCellId: neighbor } : t,
            )
          : prev,
      );
    },
    [gridsRef, setGrid, setTabs],
  );

  const swapGridCells = useCallback(
    (gridId: string, a: string, b: string) => setGrid(gridId, (g) => swapCells(g, a, b)),
    [setGrid],
  );
  const setGridTracks = useCallback(
    (gridId: string, axis: "col" | "row", sizes: number[]) => setGrid(gridId, (g) => setTracks(g, axis, sizes)),
    [setGrid],
  );
  const toggleGridZoom = useCallback(
    (gridId: string, cellId: string) => setGrid(gridId, (g) => toggleZoom(g, cellId)),
    [setGrid],
  );

  const renameGrid = useCallback(
    async (gridId: string) => {
      const grid = gridsRef.current[gridId];
      if (!grid) return;
      const name = (await promptDialog("Grid name", grid.name))?.trim();
      if (!name) return;
      setGrid(gridId, (g) => (g.name === name ? g : { ...g, name }));
    },
    [gridsRef, promptDialog, setGrid],
  );

  const focusCell = setTabFocus;

  // Moves keyboard focus to another cell. While the grid is zoomed the zoom
  // follows, so focus never lands on a cell that is hidden.
  const moveFocus = useCallback(
    (tabId: string, pick: (grid: Grid, current: string | undefined) => string | undefined) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      const grid = tab?.gridId !== undefined ? gridsRef.current[tab.gridId] : undefined;
      if (!tab || !grid) return;
      const next = pick(grid, tab.gridFocusedCellId);
      if (!next || next === tab.gridFocusedCellId) return;
      setTabFocus(tabId, next);
      if (grid.zoomedCellId !== null) setGrid(grid.id, (g) => ({ ...g, zoomedCellId: next }));
    },
    [tabsRef, gridsRef, setTabFocus, setGrid],
  );

  const focusAdjacentCell = useCallback(
    (tabId: string, delta: 1 | -1) => moveFocus(tabId, (g, cur) => adjacentCellId(g, cur, delta)),
    [moveFocus],
  );

  // Grid: Focus Left/Right/Up/Down Cell — tmux's select-pane by direction.
  const focusCellInDirection = useCallback(
    (tabId: string, direction: GridDirection, stacked: boolean) =>
      moveFocus(tabId, (g, cur) => directionalCellId(g, cur, direction, stacked)),
    [moveFocus],
  );

  // ---- Managed grids (ctx.registerManagedGrid) -------------------------------

  const knownWindowIds = useCallback(
    () => new Set(sessionsRef.current.flatMap((s) => s.windows.map((w) => w.id))),
    [sessionsRef],
  );

  // A provider's grid tab (spec R12, R17): the grid's tab in the active pane,
  // else in any pane, else a new grid with a tab in the active pane.
  const openManagedGrid = useCallback(
    (providerId: string) => {
      const provider = managedGrids.find((m) => m.id === providerId);
      if (!provider) return;
      const activeGroupId = splitLayoutRef.current.activeGroupId;
      const grid = Object.values(gridsRef.current).find((g) => g.providerId === providerId);
      if (grid) {
        const tab =
          tabsRef.current.find((t) => t.gridId === grid.id && t.groupId === activeGroupId) ??
          tabsRef.current.find((t) => t.gridId === grid.id);
        if (tab?.groupId) {
          focusGroup(tab.groupId);
          setActiveTabId(tab.id, tab.groupId);
          return;
        }
        openGridTab(grid.id, activeGroupId);
        return;
      }
      const fresh = reconcileManagedGrid(
        { ...emptyGrid("", []), name: provider.title, providerId, hiddenWindowIds: [], colSizes: [1], rowSizes: [1] },
        provider.windows,
        knownWindowIds(),
        randomUUID,
      );
      const tab = gridTabFor(fresh, activeGroupId, fresh.cells[0]?.id);
      const anchor = splitLayoutRef.current.groupActive[activeGroupId] ?? null;
      setGrids((prev) => ({ ...prev, [fresh.id]: fresh }));
      setTabs((prev) => insertAfter(prev, tab, anchor));
      focusGroup(activeGroupId);
      setActiveTabId(tab.id, activeGroupId);
    },
    [managedGrids, splitLayoutRef, gridsRef, tabsRef, focusGroup, setActiveTabId, openGridTab, knownWindowIds, gridTabFor, setGrids, setTabs],
  );

  // Keeps every managed grid in step with its provider's wanted windows
  // (spec R13, R14), and drops one whose provider is gone once extensions
  // have settled (R18) — the prune effect then closes its tabs.
  useEffect(() => {
    const known = new Set(sessions.flatMap((s) => s.windows.map((w) => w.id)));
    setGrids((prev) => {
      let changed = false;
      const next: Record<string, Grid> = {};
      for (const [id, g] of Object.entries(prev)) {
        if (g.providerId === undefined) {
          next[id] = g;
          continue;
        }
        const provider = managedGrids.find((m) => m.id === g.providerId);
        if (!provider) {
          if (extensionsSettled) {
            changed = true;
            continue;
          }
          next[id] = g;
          continue;
        }
        const r = reconcileManagedGrid(g, provider.windows, known, randomUUID);
        if (r !== g) changed = true;
        next[id] = r;
      }
      return changed ? next : prev;
    });
  }, [managedGrids, extensionsSettled, sessions, setGrids]);

  // ---- Menu items -----------------------------------------------------------

  const gridTabMenuItems = useCallback(
    (tab: Tab): MenuItem[] => {
      const gridId = tab.gridId;
      if (gridId === undefined) return [];
      return [
        { label: "Rename Grid…", onClick: () => void renameGrid(gridId) },
        { label: "Add Terminal", onClick: () => void addTerminalToGrid(gridId, tab.id) },
        { label: "Add Terminal from Project…", onClick: () => void addTerminalFromProject(gridId, tab.id) },
        { label: "Pop Out All", onClick: () => popOutAll(gridId, tab.id) },
      ];
    },
    [renameGrid, addTerminalToGrid, addTerminalFromProject, popOutAll],
  );

  // A terminal tab's "Move to Grid" submenu (spec R4): the grids in its
  // project's chip, then every other grid under its tab label, then New Grid.
  const moveToGridMenuItem = useCallback(
    (tab: Tab): MenuItem | null => {
      if (!isRealTab(tab)) return null;
      const projectKey = projectKeyForSession(tab.sessionName);
      const all = Object.values(grids);
      const own = all.filter((g) => chipKeyOf(g) === projectKey);
      const others = all.filter((g) => chipKeyOf(g) !== projectKey);
      const item = (g: Grid, label: string): MenuItem => ({
        label,
        icon: "layout",
        onClick: () => void moveTabsToGrid([tab.id], { gridId: g.id }),
      });
      const submenu: MenuItem[] = own.map((g) => item(g, g.name));
      if (own.length > 0 && others.length > 0) submenu.push({ label: "", separator: true, onClick: () => {} });
      submenu.push(...others.map((g) => item(g, gridLabel(g))));
      if (submenu.length > 0) submenu.push({ label: "", separator: true, onClick: () => {} });
      submenu.push({
        label: "New Grid",
        icon: "add",
        onClick: () => void moveTabsToGrid([tab.id], { newInProject: projectKey }),
      });
      return { label: "Move to Grid", onClick: () => {}, submenu };
    },
    [grids, projectKeyForSession, chipKeyOf, gridLabel, moveTabsToGrid],
  );

  // The chip's right-click menu (R17, R18).
  const chipGridMenuItems = useCallback(
    (editorGroupId: string, chipKey: string): MenuItem[] => {
      if (!sessions.some((s) => (s.path || s.name) === chipKey)) return [];
      const items: MenuItem[] = [{ label: "New Grid", onClick: () => void newGrid(editorGroupId, chipKey) }];
      if (projectTerminalTabIds(editorGroupId, chipKey).length > 0) {
        items.push({ label: "Tile All Terminals", onClick: () => void tileAll(editorGroupId, chipKey) });
      }
      return items;
    },
    [sessions, newGrid, tileAll, projectTerminalTabIds],
  );

  // The chip arrow's dropdown (R21): one row per grid of the project,
  // checked when the pane already shows it.
  const chipGridDropdownItems = useCallback(
    (editorGroupId: string, chipKey: string): MenuItem[] =>
      Object.values(grids)
        .filter((g) => chipKeyOf(g) === chipKey)
        .map((g) => ({
          label: g.name,
          icon: "layout",
          checked: tabsRef.current.some((t) => t.gridId === g.id && t.groupId === editorGroupId),
          onClick: () => openGridTab(g.id, editorGroupId),
        })),
    [grids, tabsRef, chipKeyOf, openGridTab],
  );

  return {
    newGrid,
    moveTabsToGrid,
    tileAll,
    addTerminalToGrid,
    addTerminalFromProject,
    openManagedGrid,
    gridLabel,
    popOutCell,
    popOutAll,
    closeCell,
    swapGridCells,
    setGridTracks,
    toggleGridZoom,
    renameGrid,
    focusCell,
    focusAdjacentCell,
    focusCellInDirection,
    openGridTab,
    gridTabMenuItems,
    moveToGridMenuItem,
    chipGridMenuItems,
    chipGridDropdownItems,
  };
}

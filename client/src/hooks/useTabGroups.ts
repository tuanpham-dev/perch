import { useCallback, useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

// Mirrors useTabs.ts's own (unexported) SetActiveTabIdArg — the argument
// shape its setActiveTabId accepts, beyond the plain Dispatch shape this
// file used before targeted (per-editor-group) activation existed.
type SetActiveTabIdArg = string | null | ((current: string | null) => string | null);
import * as api from "../api";
import { groupKeyForTab, isRealTab, loadStoredTabGroupState, moveGroupWithin, normalizeWithinGroups, orderedGroupKeys } from "../lib/tabs";
import type { AppSettings } from "../settings";
import { tabStorage } from "../lib/detachedWindows";
import type { MenuItem, Tab, TabGroupState, TerminalSession } from "../types";
import { GROUP_COLORS, nextAutoColor } from "../utils/groupColor";

// Chrome-style tab-group UI state (color/collapsed) and every interaction
// on it: auto-color-assign, prune, contiguity normalization, auto-expand on
// activate, collapse/expand with active-tab handoff, close-group, and the
// chip's context-menu items. See plans/tab-groups-by-session.md.
export function useTabGroups(
  tabs: Tab[],
  tabsRef: MutableRefObject<Tab[]>,
  setTabs: Dispatch<SetStateAction<Tab[]>>,
  activeTabId: string | null,
  // useTabs.ts's richer setActiveTabId — the plain Dispatch shape still
  // works for a call with just the functional-updater argument (see
  // toggleGroupCollapsed below), but closeGroupTabs needs the optional
  // second (editorGroupId) argument to target one specific bar.
  setActiveTabId: (arg: SetActiveTabIdArg, groupId?: string) => void,
  mruTabIdsRef: MutableRefObject<string[]>,
  dirtyTabsRef: MutableRefObject<Set<string>>,
  sessions: TerminalSession[],
  sessionsLoadedRef: MutableRefObject<boolean>,
  settingsRef: MutableRefObject<AppSettings>,
  groupingEnabled: boolean,
  confirmDialog: (message: string, confirmLabel?: string) => Promise<boolean>,
  // Maps a session name to its group key — useTabs' projectKeyForSession
  // (the session's folder, falling back to its name), so every session
  // rooted in one folder shares a single chip (plans/project-first-ui.md).
  keyForSession: (sessionName: string) => string,
) {
  const [tabGroupState, setTabGroupState] = useState<Record<string, TabGroupState>>(
    loadStoredTabGroupState,
  );
  useEffect(() => {
    tabStorage().setItem("tabGroupState", JSON.stringify(tabGroupState));
  }, [tabGroupState]);

  // Keeps tabGroupState in sync with which projects actually have tabs open:
  // prunes entries for group keys with no tab left (forgets color/collapsed,
  // same as Chrome forgetting a closed group), and — only while grouping is
  // enabled — auto-assigns a fresh palette color to any key that gained tabs
  // without one yet. Also the best-effort key migration from the pre-project
  // era, when this state was keyed by session name: a live key with no entry
  // adopts its session's name-keyed entry (if any) before a fresh color
  // would be assigned, so stored chip colors survive the re-key.
  useEffect(() => {
    setTabGroupState((prev) => {
      const liveKeys = new Map<string, string>(); // group key -> a session name mapping to it
      for (const t of tabs) {
        if (isRealTab(t)) liveKeys.set(keyForSession(t.sessionName), t.sessionName);
      }
      let changed = false;
      const next: Record<string, TabGroupState> = {};
      for (const [key, state] of Object.entries(prev)) {
        if (liveKeys.has(key)) next[key] = state;
        else changed = true;
      }
      if (settingsRef.current.tabGroupsBySession) {
        let colorCount = Object.keys(next).length;
        for (const [key, sessionName] of liveKeys) {
          if (!next[key]) {
            const legacy = key !== sessionName ? prev[sessionName] : undefined;
            next[key] = legacy ?? { color: nextAutoColor(colorCount), collapsed: false };
            if (!legacy) colorCount++;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [tabs, groupingEnabled, settingsRef, keyForSession]);

  // Enforces group contiguity while grouping is enabled — reorders `tabs` so
  // each session's tabs sit adjacent to each other, independently within
  // each editor group/split pane (see normalizeWithinGroups). A no-op (same
  // array reference) once already normalized, so this can't loop: setTabs
  // bails on an unchanged reference.
  useEffect(() => {
    if (!groupingEnabled) return;
    setTabs((prev) => normalizeWithinGroups(prev, keyForSession));
  }, [tabs, groupingEnabled, setTabs, keyForSession]);

  // A tab activated while its group is collapsed must not stay hidden
  // behind its own chip — expand its group so the active tab is always
  // reachable (quick switcher, sidebar, tab cycling, dedupe-activation all
  // funnel through setActiveTabId, so this one effect covers every path).
  useEffect(() => {
    if (!activeTabId) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    const key = tab ? groupKeyForTab(tab, keyForSession) : null;
    if (!key) return;
    setTabGroupState((prev) => {
      const state = prev[key];
      if (!state?.collapsed) return prev;
      return { ...prev, [key]: { ...state, collapsed: false } };
    });
  }, [activeTabId, tabs, keyForSession]);

  // tabGroupState's own key migration for an out-of-band session rename —
  // useTabs runs the equivalent rename-detection independently (from
  // tabsRef, same trigger) to migrate tabs' own sessionName/originSessionName
  // fields; this one only ever touches tabGroupState, so the two concerns
  // don't need to reach into each other.
  useEffect(() => {
    if (!sessionsLoadedRef.current) return;
    const renames = new Map<string, string>();
    for (const tab of tabsRef.current) {
      if (!tab.sessionId) continue;
      const session = sessions.find((s) => s.id === tab.sessionId);
      if (session && session.name !== tab.sessionName) renames.set(tab.sessionName, session.name);
    }
    if (renames.size === 0) return;
    setTabGroupState((prev) => {
      const next: Record<string, TabGroupState> = {};
      for (const [name, state] of Object.entries(prev)) {
        next[renames.get(name) ?? name] = state;
      }
      return next;
    });
  }, [sessions, sessionsLoadedRef, tabsRef]);

  // Toggles a group's collapsed state. Collapsing the group holding the
  // active tab hands activation to the MRU tab outside it (same fallback
  // order as closeTab), falling back to the nearest tab outside the group;
  // if the group contains every open tab, there's nothing to hand off to —
  // silent no-op rather than stranding the active tab with no visible tab.
  const toggleGroupCollapsed = useCallback((sessionName: string) => {
    setTabGroupState((prev) => {
      const state = prev[sessionName];
      if (!state) return prev;
      const collapsing = !state.collapsed;
      if (collapsing) {
        const memberIds = new Set(
          tabsRef.current.filter((t) => groupKeyForTab(t, keyForSession) === sessionName).map((t) => t.id),
        );
        const hasOutside = tabsRef.current.some((t) => !memberIds.has(t.id));
        if (!hasOutside) return prev;
        setActiveTabId((current) => {
          if (!current || !memberIds.has(current)) return current;
          const previous = mruTabIdsRef.current.find(
            (tid) => !memberIds.has(tid) && tabsRef.current.some((t) => t.id === tid),
          );
          if (previous) return previous;
          const neighbor = tabsRef.current.find((t) => !memberIds.has(t.id));
          return neighbor ? neighbor.id : current;
        });
      }
      return { ...prev, [sessionName]: { ...state, collapsed: collapsing } };
    });
  }, [tabsRef, mruTabIdsRef, setActiveTabId, keyForSession]);

  // Makes a project the active one from its chip: activates that group's
  // most-recently-used tab within this one bar, falling back to its first.
  // Scoped per bar (editorGroupId) like closeGroupTabs — a chip only ever
  // acts on the tabs sitting under it. The group's own collapsed state needs
  // no handling here: activating a tab inside a collapsed group expands it
  // through the auto-expand effect above.
  const activateGroup = useCallback(
    (editorGroupId: string, sessionName: string) => {
      const members = tabsRef.current.filter(
        (t) => t.groupId === editorGroupId && groupKeyForTab(t, keyForSession) === sessionName,
      );
      if (members.length === 0) return;
      const memberIds = new Set(members.map((t) => t.id));
      const recent = mruTabIdsRef.current.find((tid) => memberIds.has(tid));
      setActiveTabId(recent ?? members[0].id, editorGroupId);
    },
    [tabsRef, mruTabIdsRef, setActiveTabId, keyForSession],
  );

  // Moves a whole group's block to a new position relative to the other
  // groups within one editor group's own tab bar only — the drag-a-chip /
  // "Move Group Left/Right" operation. See plans/reorder-tab-groups.md and
  // plans/vscode-editor-group-splits.md. No new persisted state: group order
  // rides entirely on `tabs`' own array order, already persisted like any
  // other tab-order change.
  const moveGroup = useCallback(
    (editorGroupId: string, sessionName: string, toIndex: number) => {
      setTabs((prev) => moveGroupWithin(prev, editorGroupId, sessionName, toIndex, keyForSession));
    },
    [setTabs, keyForSession],
  );

  // Scoped to one editor group's own tabs — closing a session's chip in one
  // split pane never touches that session's tabs in another pane (tabGroupState
  // itself — color/collapsed — stays a global, session-keyed singleton so the
  // same chip looks identical in every bar; only which *tabs* it acts on is
  // per-bar).
  const closeGroupTabs = useCallback(
    async (editorGroupId: string, sessionName: string) => {
      const toClose = tabs.filter((t) => t.groupId === editorGroupId && groupKeyForTab(t, keyForSession) === sessionName);
      if (toClose.length === 0) return;
      const anyDirty = toClose.some((t) => dirtyTabsRef.current.has(t.id));
      if (anyDirty) {
        const ok = await confirmDialog("Some tabs have unsaved changes. Close this group anyway?", "Close Group");
        if (!ok) return;
      }
      const closedIds = new Set(toClose.map((t) => t.id));
      for (const t of toClose) {
        dirtyTabsRef.current.delete(t.id);
        if (t.windowIndex !== undefined) api.closeWindowTab(t.attachName).catch(() => {});
      }
      mruTabIdsRef.current = mruTabIdsRef.current.filter((tid) => !closedIds.has(tid));
      setTabs((prev) => {
        const idx = prev.findIndex((t) => closedIds.has(t.id));
        const next = prev.filter((t) => !closedIds.has(t.id));
        setActiveTabId((current) => {
          if (!current || !closedIds.has(current)) return current;
          if (settingsRef.current.tabCloseActivation === "recent") {
            const previous = mruTabIdsRef.current.find(
              (tid) => tid !== current && next.some((t) => t.id === tid),
            );
            if (previous) return previous;
          }
          const neighbor = next[Math.min(idx, next.length - 1)];
          return neighbor ? neighbor.id : null;
        }, editorGroupId);
        return next;
      });
    },
    [tabs, confirmDialog, dirtyTabsRef, mruTabIdsRef, setTabs, setActiveTabId, settingsRef, keyForSession],
  );

  // `editorGroupId` scopes chip order/position (Move Left/Right) and Close
  // Group to that one split pane's own session chips — SplitLayout's Leaf
  // binds it per-instance before handing this to TabBar (see
  // App.tsx/SplitLayout.tsx). Collapse/color stay global (tabGroupState).
  const groupMenuItems = useCallback(
    (editorGroupId: string, sessionName: string): MenuItem[] => {
      const state = tabGroupState[sessionName];
      const collapsed = state?.collapsed ?? false;
      // Omitted entirely at each boundary (no "Move Left" for the first
      // group, no "Move Right" for the last) rather than rendered disabled —
      // MenuItem has no disabled field, and a two-item omit is simpler.
      const barTabs = tabs.filter((t) => t.groupId === editorGroupId);
      const order = orderedGroupKeys(barTabs, keyForSession);
      const index = order.indexOf(sessionName);
      const moveItems: MenuItem[] = [];
      if (index > 0) {
        moveItems.push({
          label: "Move Group Left",
          onClick: () => moveGroup(editorGroupId, sessionName, index - 1),
        });
      }
      if (index !== -1 && index < order.length - 1) {
        moveItems.push({
          label: "Move Group Right",
          onClick: () => moveGroup(editorGroupId, sessionName, index + 1),
        });
      }
      return [
        {
          label: collapsed ? "Expand Group" : "Collapse Group",
          onClick: () => toggleGroupCollapsed(sessionName),
        },
        {
          label: "",
          onClick: () => {},
          swatches: {
            colors: GROUP_COLORS.map((c) => ({ key: c.key, hex: c.hex })),
            selected: state?.color ?? GROUP_COLORS[0].key,
            onPick: (color) =>
              setTabGroupState((prev) => {
                const s = prev[sessionName];
                if (!s) return prev;
                return { ...prev, [sessionName]: { ...s, color } };
              }),
          },
        },
        ...moveItems,
        { label: "Close Group", danger: true, onClick: () => closeGroupTabs(editorGroupId, sessionName) },
      ];
    },
    [tabGroupState, tabs, toggleGroupCollapsed, moveGroup, closeGroupTabs, keyForSession],
  );

  // Synchronous counterpart to the out-of-band rename-migration effect above
  // — kept for out-of-band rename reconciliation callers; sessions no
  // longer have an in-app rename action (a project's name is its folder's)
  // succeeds, so the group's color/collapsed state follows immediately
  // instead of waiting for the next sessions poll to detect the rename.
  const renameGroup = useCallback((oldName: string, newName: string) => {
    setTabGroupState((prev) => {
      const state = prev[oldName];
      if (!state) return prev;
      const { [oldName]: _moved, ...rest } = prev;
      return { ...rest, [newName]: state };
    });
  }, []);

  return { tabGroupState, toggleGroupCollapsed, activateGroup, closeGroupTabs, groupMenuItems, renameGroup, moveGroup };
}

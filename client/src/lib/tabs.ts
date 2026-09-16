import type { Tab, TabGroupState, TerminalSession } from "../types";

// A "virtual" tab (image viewer, markdown preview, settings, …) has no
// session behind it — sessionName/attachName are "". Centralized here so a
// future virtual-tab kind only needs to extend this one place, not every
// imagePath-only check that predates it.
export function isRealTab(tab: Tab): boolean {
  return (
    tab.imagePath === undefined &&
    tab.previewPath === undefined &&
    tab.settingsView === undefined &&
    tab.keyboardView === undefined &&
    tab.extViewerPath === undefined &&
    tab.extensionPageId === undefined
  );
}

export function tabVirtualPath(tab: Tab): string | undefined {
  return tab.imagePath ?? tab.previewPath ?? tab.extViewerPath;
}

// Same underlying content, regardless of which tab instance — the same
// dedupe notion openSession/openWindowTab/openExtViewerTab already apply
// when deciding whether to activate an existing tab instead of opening a
// new one (see useTabs.ts), reused by "Move into Next/Previous Group" so it
// never moves a tab into a group that already shows the same thing.
export function tabsAreDuplicates(a: Tab, b: Tab): boolean {
  if (a.settingsView || b.settingsView) return !!a.settingsView && !!b.settingsView;
  if (a.keyboardView || b.keyboardView) return !!a.keyboardView && !!b.keyboardView;
  if (a.extensionPageId !== undefined || b.extensionPageId !== undefined) {
    return a.extensionPageId !== undefined && a.extensionPageId === b.extensionPageId;
  }
  if (isRealTab(a) && isRealTab(b)) {
    return a.sessionName === b.sessionName && a.windowIndex === b.windowIndex;
  }
  if (!isRealTab(a) && !isRealTab(b)) {
    if (a.extViewerId !== undefined || b.extViewerId !== undefined) {
      return a.extViewerId === b.extViewerId && a.extViewerPath === b.extViewerPath;
    }
    const path = tabVirtualPath(a);
    return path !== undefined && path === tabVirtualPath(b);
  }
  return false;
}

// Maps a tab's session name to its group key. Identity by default; the app
// passes useTabs' projectKeyForSession (the session's folder, falling back
// to its name) so every session rooted in one folder shares a single group
// — one project, one chip (plans/project-first-ui.md).
export type SessionKeyResolver = (sessionName: string) => string;
const identityKey: SessionKeyResolver = (name) => name;

// Chrome-style tab groups (plans/tab-groups-by-session.md): a real tab's
// group is its session's key under `keyForSession` — the project folder in
// the app, the raw session name by default. A viewer tab
// (image/markdown/etc.) joins the group of the real session it was opened
// from (originSessionName, cleared once that session no longer exists — see
// the effect in App() that strips it). The settings tab is never grouped —
// it's a global singleton, not tied to any one session.
export function groupKeyForTab(tab: Tab, keyForSession: SessionKeyResolver = identityKey): string | null {
  if (isRealTab(tab)) return keyForSession(tab.sessionName);
  return tab.originSessionName !== undefined ? keyForSession(tab.originSessionName) : null;
}

// Every group's tabs as a contiguous block, keyed by group, in first-
// appearance order, plus the trailing ungrouped ("singleton") tabs —
// settings, or a preview tab whose origin session went away. The one
// decomposition normalizeTabGroups, orderedGroupKeys, and moveGroup all
// share, so "what order are the groups in" can't drift across call sites.
function groupBlocks(
  tabs: Tab[],
  keyForSession: SessionKeyResolver = identityKey,
): { order: string[]; blocks: Map<string, Tab[]>; singletons: Tab[] } {
  const order: string[] = [];
  const blocks = new Map<string, Tab[]>();
  const singletons: Tab[] = [];
  for (const tab of tabs) {
    const key = groupKeyForTab(tab, keyForSession);
    if (key === null) {
      singletons.push(tab);
      continue;
    }
    const members = blocks.get(key);
    if (members) members.push(tab);
    else {
      order.push(key);
      blocks.set(key, [tab]);
    }
  }
  return { order, blocks, singletons };
}

// The distinct group keys among `tabs`, in first-appearance order — the
// same order normalizeTabGroups anchors on and moveGroup reorders.
export function orderedGroupKeys(tabs: Tab[], keyForSession?: SessionKeyResolver): string[] {
  return groupBlocks(tabs, keyForSession).order;
}

// Reorders `tabs` so every group's members sit contiguously, anchored at the
// position of the group's first-encountered tab, with every ungrouped
// ("singleton") tab — settings, or a preview tab whose origin session went
// away — pushed after every group, in their own original relative order.
// Returns the same array reference when the order is already normalized, so
// callers can safely bail a setState on it.
export function normalizeTabGroups(tabs: Tab[], keyForSession?: SessionKeyResolver): Tab[] {
  const { order, blocks, singletons } = groupBlocks(tabs, keyForSession);
  const next: Tab[] = [];
  for (const key of order) next.push(...blocks.get(key)!);
  next.push(...singletons);
  const changed = next.some((t, i) => t.id !== tabs[i]?.id);
  return changed ? next : tabs;
}

// Moves a whole group's contiguous tab block to a new position relative to
// the other groups — the drag-a-chip / "Move Group Left/Right" operation.
// Mirrors moveTab's remove-then-splice pattern but at group-block
// granularity; singletons always stay trailing every group, untouched.
// Assumes `tabs` is already normalized (groups contiguous) — true whenever
// grouping is enabled, the only time this is callable. Returns the same
// array reference when the move is a no-op (unknown group key, or the
// target position doesn't actually change anything).
export function moveGroup(tabs: Tab[], groupKey: string, toIndex: number, keyForSession?: SessionKeyResolver): Tab[] {
  const { order, blocks, singletons } = groupBlocks(tabs, keyForSession);
  if (!blocks.has(groupKey)) return tabs;
  const withoutDragged = order.filter((k) => k !== groupKey);
  const clamped = Math.max(0, Math.min(toIndex, withoutDragged.length));
  const nextOrder = [...withoutDragged];
  nextOrder.splice(clamped, 0, groupKey);
  const next: Tab[] = [];
  for (const key of nextOrder) next.push(...blocks.get(key)!);
  next.push(...singletons);
  const changed = next.some((t, i) => t.id !== tabs[i]?.id);
  return changed ? next : tabs;
}

// Moves an id to a new position within a flat string-id array — the sidebar
// tab strip's drag-a-tab reorder. Same remove-then-splice shape as moveGroup,
// but at plain-array granularity (no grouping concept). Returns the same
// array reference when the id is unknown or the move is a no-op.
export function moveId(order: string[], id: string, toIndex: number): string[] {
  if (!order.includes(id)) return order;
  const without = order.filter((x) => x !== id);
  const clamped = Math.max(0, Math.min(toIndex, without.length));
  const next = [...without];
  next.splice(clamped, 0, id);
  return next.some((x, i) => x !== order[i]) ? next : order;
}

// Keeps tabs pointed at the right session/window across an out-of-band
// rename or renumber (another terminal, not this app). Matches by stable
// window id first — falls back to name/index only for a tab whose ids haven't
// resolved yet (freshly opened, or restored from localStorage before
// id-keying shipped), which then adopts the id it finds for next time. A
// session/window that's gone entirely is left alone here; the attach's own
// "exit" message (or the window-tab cleanup effect below) closes that tab.
export function reconcileTabs(tabs: Tab[], sessions: TerminalSession[]): Tab[] {
  let changed = false;
  const next = tabs.map((tab) => {
    const session = tab.sessionId
      ? sessions.find((s) => s.id === tab.sessionId)
      : sessions.find((s) => s.name === tab.sessionName);
    if (!session) return tab;

    let updated = tab;
    if (updated.sessionId !== session.id || updated.sessionName !== session.name) {
      changed = true;
      updated = {
        ...updated,
        sessionId: session.id,
        sessionName: session.name,
        // attachName tracks the base session's name only for a whole-session
        // tab; a window-tab's attachName is its own synthetic session name
        // and must never follow a rename of the base session.
        attachName: updated.windowIndex === undefined ? session.name : updated.attachName,
      };
    }

    if (updated.windowIndex !== undefined) {
      const win = updated.windowId
        ? session.windows.find((w) => w.id === updated.windowId)
        : session.windows.find((w) => w.index === updated.windowIndex);
      if (win && (updated.windowId !== win.id || updated.windowIndex !== win.index)) {
        changed = true;
        updated = { ...updated, windowId: win.id, windowIndex: win.index };
      }
    }

    return updated;
  });
  return changed ? next : tabs;
}

export function loadStoredTabs(fallbackGroupId: string): Tab[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("tabs") ?? "[]");
    if (!Array.isArray(parsed)) return [];
    // Tabs stored before per-window tabs shipped won't have attachName —
    // every tab back then was a whole-session tab, where it always equals
    // sessionName. Tabs stored before editor-group splits shipped won't have
    // groupId — they all land in the caller's fresh single-leaf tree.
    return parsed.map((t) => ({
      ...t,
      attachName: t.attachName ?? t.sessionName,
      groupId: typeof t.groupId === "string" ? t.groupId : fallbackGroupId,
    }));
  } catch {
    return [];
  }
}

// Applies normalizeTabGroups's session-chip contiguity independently within
// each editor group (Tab.groupId) — a tab's editor group is never changed
// here, and one group's reordering never disturbs another group's tabs, even
// though both live in the same flat array. Returns the same reference when
// no editor group's subsequence changed.
export function normalizeWithinGroups(tabs: Tab[], keyForSession?: SessionKeyResolver): Tab[] {
  const editorGroupIds = Array.from(new Set(tabs.map((t) => t.groupId)));
  let next = tabs;
  for (const editorGroupId of editorGroupIds) {
    const slots: number[] = [];
    for (let i = 0; i < next.length; i++) {
      if (next[i].groupId === editorGroupId) slots.push(i);
    }
    const subsequence = slots.map((i) => next[i]);
    const normalized = normalizeTabGroups(subsequence, keyForSession);
    if (normalized === subsequence) continue;
    const replaced = [...next];
    slots.forEach((slot, idx) => {
      replaced[slot] = normalized[idx];
    });
    next = replaced;
  }
  return next;
}

// moveGroup (session-chip drag reorder), scoped to one editor group's own
// subsequence — mirrors normalizeWithinGroups' slot-splice approach so a
// chip drag in one split pane never reorders another pane's tabs. Returns
// the same reference when the move is a no-op within that group.
export function moveGroupWithin(
  tabs: Tab[],
  editorGroupId: string,
  sessionKey: string,
  toIndex: number,
  keyForSession?: SessionKeyResolver,
): Tab[] {
  const slots: number[] = [];
  for (let i = 0; i < tabs.length; i++) {
    if (tabs[i].groupId === editorGroupId) slots.push(i);
  }
  const subsequence = slots.map((i) => tabs[i]);
  const moved = moveGroup(subsequence, sessionKey, toIndex, keyForSession);
  if (moved === subsequence) return tabs;
  const next = [...tabs];
  slots.forEach((slot, idx) => {
    next[slot] = moved[idx];
  });
  return next;
}

// Per-device, not server-synced (like `tabs` itself) — group color/collapse
// state is meaningless without the device's own tab list.
export function loadStoredTabGroupState(): Record<string, TabGroupState> {
  try {
    const parsed = JSON.parse(localStorage.getItem("tabGroupState") ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import * as api from "../api";
import { ApiError } from "../api";
import {
  findFileViewerFor,
  requestTerminalRefocus,
  setActiveContext,
  type RegisteredFileViewer,
} from "../extensions";
import {
  groupKeyForTab,
  isRealTab,
  loadStoredTabs,
  reconcileTabs,
  tabsAreDuplicates,
  tabVirtualPath,
} from "../lib/tabs";
import {
  leaves,
  parseStoredTree,
  removeLeaf,
  setBranchSizes,
  splitLeaf,
  type SplitDirection,
  type SplitNode,
} from "../lib/splits";
import { projectName } from "../lib/projects";
import type { AppSettings } from "../settings";
import { tabStorage } from "../lib/detachedWindows";
import type { ExtensionInfo, RegistrySourceResult, Tab, TerminalSession } from "../types";
import type { DetachedApi } from "./useDetachedWindows";

const SPLIT_LAYOUT_KEY = "splitLayout";
// The id of the app's very first editor group — before any split has ever
// been made, and the fallback every pre-splits tab (and a corrupted/partial
// splitLayout entry) migrates onto. Just needs to be unique within the tree,
// not globally — every group created afterward (splitLeaf) gets a real
// crypto.randomUUID() instead.
const DEFAULT_GROUP_ID = "root";

interface SplitLayout {
  tree: SplitNode;
  // Each editor group's own active tab — VS Code's "which tab is showing in
  // this pane" — independent of which group currently has app focus.
  groupActive: Record<string, string | null>;
  // Which editor group currently has app/keyboard focus.
  activeGroupId: string;
}

function loadSplitLayout(): SplitLayout {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(tabStorage().getItem(SPLIT_LAYOUT_KEY) ?? "null");
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object") {
    const tree = parseStoredTree((parsed as { tree?: unknown }).tree);
    if (tree) {
      const validGroupIds = leaves(tree);
      const storedActive = (parsed as { groupActive?: unknown }).groupActive;
      const groupActive: Record<string, string | null> = {};
      for (const id of validGroupIds) {
        const v =
          storedActive && typeof storedActive === "object"
            ? (storedActive as Record<string, unknown>)[id]
            : undefined;
        groupActive[id] = typeof v === "string" ? v : null;
      }
      const storedActiveGroupId = (parsed as { activeGroupId?: unknown }).activeGroupId;
      const activeGroupId =
        typeof storedActiveGroupId === "string" && validGroupIds.includes(storedActiveGroupId)
          ? storedActiveGroupId
          : validGroupIds[0];
      return { tree, groupActive, activeGroupId };
    }
  }
  // Fresh default: a single root leaf, seeded from the pre-splits
  // "activeTabId" key (no longer written once this ships) so upgrading
  // doesn't lose which tab was focused.
  const legacyActiveTabId = tabStorage().getItem("activeTabId");
  return {
    tree: { type: "leaf", groupId: DEFAULT_GROUP_ID },
    groupActive: { [DEFAULT_GROUP_ID]: legacyActiveTabId },
    activeGroupId: DEFAULT_GROUP_ID,
  };
}

type SetActiveTabIdArg = string | null | ((current: string | null) => string | null);

// Owns the tabs array and its whole lifecycle: persistence, open/close/move,
// window-tab and viewer-tab activation, the out-of-band reconcile/vanished-
// window/origin-clear sweeps, and the derived "active real tab" context the
// sidebar/FILES panel/extensions read. Also owns the editor-group split tree
// (plans/vscode-editor-group-splits.md) — tabs stay one flat array (each
// stamped with the groupId of the pane it belongs to), so every existing
// sweep above keeps working untouched; only open/close/activate/move gained
// group-scoping. Takes sessions + a handful of small cross-hook dependencies
// as explicit parameters rather than reaching for module state, per
// plans/client-structure-split.md's Approach.
export function useTabs(
  sessions: TerminalSession[],
  sessionsLoadedRef: MutableRefObject<boolean>,
  showError: (err: unknown) => void,
  confirmDialog: (message: string, confirmLabel?: string) => Promise<boolean>,
  settingsRef: MutableRefObject<AppSettings>,
  extFileViewers: RegisteredFileViewer[],
  extensions: ExtensionInfo[],
  registryCatalog: RegistrySourceResult[],
  // Cross-window dedupe (plans/detach-tab-to-new-window.md): populated by
  // App from useDetachedWindows, which itself needs this hook's adoptTabs -
  // a ref bridges the cycle, same pattern as App's refreshClipboardMirrorRef.
  detachedApiRef: MutableRefObject<DetachedApi | null>,
) {
  const [splitLayout, setSplitLayout] = useState<SplitLayout>(loadSplitLayout);
  // Snapshot for closures/effects that must read the current tree/groupActive
  // without depending on splitLayout itself — same rationale as tabsRef.
  const splitLayoutRef = useRef(splitLayout);
  splitLayoutRef.current = splitLayout;

  useEffect(() => {
    tabStorage().setItem(SPLIT_LAYOUT_KEY, JSON.stringify(splitLayout));
  }, [splitLayout]);

  // Restored tabs whose session no longer exists self-heal: attaching to a
  // dead session makes the attach exit immediately, the server relays "exit", and
  // the normal onExit handler closes that tab — no separate validation pass
  // needed here.
  const [tabs, setTabs] = useState<Tab[]>(() => loadStoredTabs(splitLayoutRef.current.activeGroupId));
  // Snapshot of `tabs` for effects/callbacks that must not themselves
  // depend on `tabs` (would either widen their run cadence or create a
  // stale closure) — same rationale as activeTabIdRef below.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // Same rationale, for `sessions` — openWindowTab awaits a refresh() partway
  // through (see useFileOpeners' openFileInSession) and must see the
  // post-refresh session list on the other side of that await, not whatever
  // `sessions` closure it captured when this render created it.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // One-time defensive migration: a tab whose groupId doesn't name a leaf
  // in the restored tree (corrupted/partial localStorage — normal operation
  // never produces this, since removeLeaf only ever runs once a group's
  // last tab is already gone) lands in the tree's first leaf instead of
  // rendering nowhere.
  useEffect(() => {
    const validGroupIds = new Set(leaves(splitLayoutRef.current.tree));
    const fallback = leaves(splitLayoutRef.current.tree)[0];
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.groupId !== undefined && validGroupIds.has(t.groupId)) return t;
        changed = true;
        return { ...t, groupId: fallback };
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derived from splitLayout rather than its own state — see setActiveTabId
  // below for how activation now also resolves/switches the owning group.
  const activeTabId = splitLayout.groupActive[splitLayout.activeGroupId] ?? null;
  // Mirror for insertTab below: every opener activates its new tab only
  // after computing where to insert it, so this ref still holds the
  // *previous* active tab at insertion time — exactly the anchor
  // "afterActive" placement wants. Same pattern as settingsRef.
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  // Every tab belonging to whichever editor group currently has focus — the
  // basis for tab.focusN/cycleTab/closeOtherTabs' group-scoped tab lists.
  const activeGroupTabs = tabs.filter((t) => t.groupId === splitLayout.activeGroupId);
  // Virtual tabs (image/markdown preview) have no session, so sidebar
  // context (the FILES tree root, the lazygit branch pill, "new window in
  // dir") keeps reflecting whichever real (terminal) tab was open most
  // recently instead of collapsing to empty while a virtual tab is active.
  // Mutated during render — same pattern as onBranchChangeRef in FileTree —
  // so it's always current without an effect's one-render lag. Declared
  // here (rather than by the activeRealTab derivation below) so
  // openExtViewerTab can pin a new viewer tab's origin session to it too.
  // Seeded from any real tab restored on this mount (useRef's initializer
  // only runs once) so a reload that lands back on a virtual tab doesn't
  // leave the sidebar empty until the user manually switches tabs.
  const lastRealTabIdRef = useRef<string | null>(tabs.find(isRealTab)?.id ?? null);
  if (activeTab && isRealTab(activeTab)) {
    lastRealTabIdRef.current = activeTab.id;
  }

  useEffect(() => {
    tabStorage().setItem("tabs", JSON.stringify(tabs));
  }, [tabs]);

  // Activation history, most recent first — closing the active tab returns
  // to the previously active tab (VS Code behavior) rather than a positional
  // neighbor. A ref: only read inside closeTab's state updater.
  const mruTabIdsRef = useRef<string[]>([]);
  useEffect(() => {
    if (!activeTabId) return;
    mruTabIdsRef.current = [
      activeTabId,
      ...mruTabIdsRef.current.filter((tid) => tid !== activeTabId),
    ];
  }, [activeTabId]);

  // Activates a tab, resolving which editor group it belongs to and
  // switching app focus there — used by every "user/action chose this tab"
  // call site (TabBar clicks, QuickSwitcher, dedupe-activation, tab.focusN).
  // A second, explicit `groupId` switches to a *targeted* mode instead: it
  // only ever updates that one group's own active-tab pointer and never
  // changes which group has app focus — for bookkeeping that must not steal
  // focus (closeTab tidying up a background group, closeOtherTabs, a newly
  // created tab seeding the group it was just inserted into — which is
  // always already the focused group, so this is equivalent but avoids
  // depending on tabsRef having caught up with a tab created this same
  // tick). Accepts a plain id/null or a functional updater (matching
  // useState's own setter shape) so useTabGroups.ts's existing
  // current-tab-aware callers keep working untouched.
  const setActiveTabId = useCallback((arg: SetActiveTabIdArg, groupId?: string) => {
    setSplitLayout((prev) => {
      if (groupId !== undefined) {
        const currentId = prev.groupActive[groupId] ?? null;
        const id = typeof arg === "function" ? arg(currentId) : arg;
        if (id === currentId) return prev;
        return { ...prev, groupActive: { ...prev.groupActive, [groupId]: id } };
      }
      const currentId = prev.groupActive[prev.activeGroupId] ?? null;
      const id = typeof arg === "function" ? arg(currentId) : arg;
      const targetGroup =
        (id !== null ? tabsRef.current.find((t) => t.id === id)?.groupId : undefined) ??
        prev.activeGroupId;
      if (prev.activeGroupId === targetGroup && prev.groupActive[targetGroup] === id) return prev;
      return {
        ...prev,
        activeGroupId: targetGroup,
        groupActive: { ...prev.groupActive, [targetGroup]: id },
      };
    });
  }, []);

  // Inserts a newly opened tab per the newTabPlacement setting. `tab` must
  // already carry its final groupId (every opener stamps it from
  // splitLayoutRef.current.activeGroupId before calling this — new tabs
  // always join the currently focused group, VS Code's own rule).
  // `anchorId` overrides the active-tab-ref anchor for callers that need to
  // snapshot it before an await (see openWindowTab) rather than reading it
  // fresh at insertion time; omit it to use activeTabIdRef.current. The
  // anchor only affects *position* within the flat array — since the anchor
  // is always a tab in the same (already-focused) group as the new tab, the
  // splice lands the new tab immediately after it in that group's own
  // rendered order, regardless of any other group's tabs physically
  // interleaved between them in the flat array.
  const insertTab = useCallback((prev: Tab[], tab: Tab, anchorId?: string | null): Tab[] => {
    if (settingsRef.current.newTabPlacement !== "afterActive") return [...prev, tab];
    const anchor = anchorId !== undefined ? anchorId : activeTabIdRef.current;
    const index = anchor ? prev.findIndex((t) => t.id === anchor) : -1;
    if (index === -1) return [...prev, tab];
    return [...prev.slice(0, index + 1), tab, ...prev.slice(index + 1)];
  }, [settingsRef]);

  // Every open path below, once its own in-group dedupe finds nothing,
  // asks whether a detached window already shows the same content
  // (tabsAreDuplicates) and, if so, focuses that window instead of opening
  // a second copy here. `retry` reruns the open locally when the holder
  // never answers (closed abnormally, so the registry was stale).
  const heldElsewhere = useCallback(
    (candidate: Tab, retry: () => void): boolean => {
      const detached = detachedApiRef.current;
      const holder = detached?.holderOf((t) => tabsAreDuplicates(t, candidate));
      if (!detached || !holder) return false;
      void detached.focusDetachedTab(holder.windowId, holder.tabId).then((ok) => {
        if (!ok) retry();
      });
      return true;
    },
    [detachedApiRef],
  );

  const openSession = useCallback(
    (name: string, ignoreDetached = false) => {
      if (!ignoreDetached) {
        const activeGroup = splitLayoutRef.current.activeGroupId;
        const activeIndex = sessions.find((s) => s.name === name)?.windows.find((w) => w.active)?.index;
        const local = tabsRef.current.some(
          (t) =>
            t.sessionName === name &&
            t.groupId === activeGroup &&
            (t.windowIndex === undefined || (activeIndex !== undefined && t.windowIndex === activeIndex)),
        );
        const candidate: Tab = { id: "", sessionName: name, attachName: name };
        if (!local && heldElsewhere(candidate, () => openSession(name, true))) return;
      }
      setTabs((prev) => {
        const activeGroup = splitLayoutRef.current.activeGroupId;
        // Only match a whole-session tab in the focused editor group — a
        // window-tab for this session, or a match sitting in a *different*
        // split pane, must never be treated as it (VS Code dedupes within
        // the target group, not globally).
        const existing = prev.find(
          (t) => t.sessionName === name && t.windowIndex === undefined && t.groupId === activeGroup,
        );
        if (existing) {
          setActiveTabId(existing.id);
          return prev;
        }
        // A window-tab pinned to this session's currently active window
        // shows this exact same content under a different label — focus it
        // instead of opening a duplicate whole-session tab.
        const activeIndex = sessions.find((s) => s.name === name)?.windows.find((w) => w.active)?.index;
        const pinnedActive = prev.find(
          (t) => t.sessionName === name && t.windowIndex === activeIndex && t.groupId === activeGroup,
        );
        if (activeIndex !== undefined && pinnedActive) {
          setActiveTabId(pinnedActive.id);
          return prev;
        }
        const tab: Tab = { id: crypto.randomUUID(), sessionName: name, attachName: name, groupId: activeGroup };
        setActiveTabId(tab.id, activeGroup);
        return insertTab(prev, tab);
      });
      // Unconditional (not transition-dependent): when the activated tab was
      // already active, TerminalView's [focused] effect won't fire, and the
      // invoking UI (quick switcher, sidebar row) otherwise keeps/strands
      // keyboard focus.
      requestTerminalRefocus();
    },
    [sessions, insertTab, heldElsewhere],
  );

  // Activate-or-create, keyed on (viewerId, path) within the focused editor
  // group — viewerId is stored on the tab so the render dispatch knows
  // which registered component to use without re-matching by extension (a
  // second extension could register for the same one later). Every built-in
  // preview (image/media/pdf/markdown/json/yaml/csv) is itself an
  // extension-registered viewer now, so this is the only virtual-file-tab
  // opener — see findFileViewerFor for how a path resolves to a viewer.
  const openExtViewerTab = useCallback((viewerId: string, filePath: string, title?: string, ignoreDetached = false) => {
    if (!ignoreDetached) {
      const activeGroup = splitLayoutRef.current.activeGroupId;
      const local = tabsRef.current.some(
        (t) => t.extViewerId === viewerId && t.extViewerPath === filePath && t.groupId === activeGroup,
      );
      const candidate: Tab = { id: "", sessionName: "", attachName: "", extViewerId: viewerId, extViewerPath: filePath };
      if (!local && heldElsewhere(candidate, () => openExtViewerTab(viewerId, filePath, title, true))) return;
    }
    // Pins the viewer tab to whichever real tab it was opened "from" — same
    // sticky lookup the FILES panel itself uses (lastRealTabIdRef), so a
    // preview opened while another viewer tab is active still attributes to
    // the last real session, not none — so it can join that session's tab
    // group (groupKeyForTab). Undefined origin (no real tab ever opened)
    // just means the tab stays ungrouped, same as today.
    const origin = tabsRef.current.find((t) => t.id === lastRealTabIdRef.current);
    setTabs((prev) => {
      const activeGroup = splitLayoutRef.current.activeGroupId;
      const existing = prev.find(
        (t) => t.extViewerId === viewerId && t.extViewerPath === filePath && t.groupId === activeGroup,
      );
      if (existing) {
        setActiveTabId(existing.id);
        // Re-opening an already-open viewer tab still applies a freshly
        // passed title — e.g. git-scm's diff viewer toggling Working Tree
        // <-> Staged on the same path — and bumps extViewerReloadKey so the
        // mounted viewer re-fetches from disk (every call here is an
        // explicit open/preview action, never a plain tab switch).
        return prev.map((t) =>
          t.id === existing.id
            ? {
                ...t,
                extViewerTitle: title !== undefined ? title : t.extViewerTitle,
                extViewerReloadKey: (t.extViewerReloadKey ?? 0) + 1,
              }
            : t,
        );
      }
      const tab: Tab = {
        id: crypto.randomUUID(),
        sessionName: "",
        attachName: "",
        groupId: activeGroup,
        extViewerId: viewerId,
        extViewerPath: filePath,
        extViewerTitle: title,
        originSessionName: origin?.sessionName,
        originSessionId: origin?.sessionId,
      };
      setActiveTabId(tab.id, activeGroup);
      return insertTab(prev, tab);
    });
  }, [insertTab, heldElsewhere]);

  // One-time migration for tabs restored from localStorage before this
  // extraction shipped — old imagePath/previewPath tabs become extViewerId/
  // extViewerPath tabs against whichever registered viewer now claims that
  // path, in the equivalent mode. Runs whenever the registry changes (i.e.
  // once activation completes); a tab whose viewer never shows up (its
  // extension got removed) is left as-is and falls through to the "loading"
  // placeholder in App's render switch.
  useEffect(() => {
    if (extFileViewers.length === 0) return;
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        const legacyPath = tab.imagePath ?? tab.previewPath;
        if (legacyPath === undefined) return tab;
        const mode: "default" | "preview" = tab.imagePath !== undefined ? "default" : "preview";
        const viewer = findFileViewerFor(legacyPath, extFileViewers, mode);
        if (!viewer) return tab;
        changed = true;
        return {
          id: tab.id,
          groupId: tab.groupId,
          sessionName: "",
          attachName: "",
          extViewerId: viewer.id,
          extViewerPath: legacyPath,
        };
      });
      return changed ? next : prev;
    });
  }, [extFileViewers]);

  // Singleton settings tab — the third virtual-tab kind, deduped globally
  // (not per-group, unlike every other opener) since it's a single shared
  // editor, matching VS Code's own Settings tab. Activate-or-create like
  // openExtViewerTab.
  const openSettingsTab = useCallback((ignoreDetached = false) => {
    if (!ignoreDetached && !tabsRef.current.some((t) => t.settingsView)) {
      const candidate: Tab = { id: "", sessionName: "", attachName: "", settingsView: true };
      if (heldElsewhere(candidate, () => openSettingsTab(true))) return;
    }
    setTabs((prev) => {
      const existing = prev.find((t) => t.settingsView);
      if (existing) {
        setActiveTabId(existing.id);
        return prev;
      }
      const groupId = splitLayoutRef.current.activeGroupId;
      const tab: Tab = { id: crypto.randomUUID(), sessionName: "", attachName: "", settingsView: true, groupId };
      setActiveTabId(tab.id, groupId);
      return insertTab(prev, tab);
    });
  }, [insertTab]);

  // Singleton Keyboard Shortcuts editor tab — same dedupe/activate-or-create
  // conventions as openSettingsTab above.
  const openKeyboardShortcutsTab = useCallback((ignoreDetached = false) => {
    if (!ignoreDetached && !tabsRef.current.some((t) => t.keyboardView)) {
      const candidate: Tab = { id: "", sessionName: "", attachName: "", keyboardView: true };
      if (heldElsewhere(candidate, () => openKeyboardShortcutsTab(true))) return;
    }
    setTabs((prev) => {
      const existing = prev.find((t) => t.keyboardView);
      if (existing) {
        setActiveTabId(existing.id);
        return prev;
      }
      const groupId = splitLayoutRef.current.activeGroupId;
      const tab: Tab = { id: crypto.randomUUID(), sessionName: "", attachName: "", keyboardView: true, groupId };
      setActiveTabId(tab.id, groupId);
      return insertTab(prev, tab);
    });
  }, [insertTab]);

  // Extension detail-page tab — deduped globally by extensionPageId, like
  // openSettingsTab above (one page per extension, not per editor group).
  // `source` is only meaningful for a registry-only subject (not yet
  // installed); reopening an already-open page with a different source
  // (e.g. the registry catalog resolved after the tab was first opened from
  // a stale id) updates it in place rather than creating a second tab.
  const openExtensionPageTab = useCallback((id: string, source?: string, ignoreDetached = false) => {
    if (!ignoreDetached && !tabsRef.current.some((t) => t.extensionPageId === id)) {
      const candidate: Tab = { id: "", sessionName: "", attachName: "", extensionPageId: id };
      if (heldElsewhere(candidate, () => openExtensionPageTab(id, source, true))) return;
    }
    setTabs((prev) => {
      const existing = prev.find((t) => t.extensionPageId === id);
      if (existing) {
        setActiveTabId(existing.id);
        if (source !== existing.extensionPageSource) {
          return prev.map((t) => (t.id === existing.id ? { ...t, extensionPageSource: source } : t));
        }
        return prev;
      }
      const groupId = splitLayoutRef.current.activeGroupId;
      const tab: Tab = {
        id: crypto.randomUUID(),
        sessionName: "",
        attachName: "",
        groupId,
        extensionPageId: id,
        extensionPageSource: source,
      };
      setActiveTabId(tab.id, groupId);
      return insertTab(prev, tab);
    });
  }, [insertTab]);

  // `anchorOverride` lets a caller that opens several window-tabs in one go
  // (openAllWindows below) chain its own locally-tracked anchor instead of
  // relying on activeTabIdRef — across a tight sequence of awaited calls,
  // the ref isn't guaranteed to reflect the previous call's new tab by the
  // time the next call reads it (React's re-render isn't synchronous with a
  // resolved await), which produced a genuinely wrong tab order under
  // newTabPlacement "afterActive" (caught live in QA, not by inspection).
  // Returns the id of the tab that ends up focused (existing/folded/new), or
  // null on failure, so callers can chain it as the next call's anchor.
  const openWindowTab = useCallback(
    async (
      session: string,
      index: number,
      anchorOverride?: string | null,
      ignoreDetached = false,
    ): Promise<string | null> => {
      // Snapshotted up front, same rationale as anchorId below: if the user
      // switches focus to a different split pane while this request is in
      // flight, the new tab still lands in the group they initiated it
      // from, not whatever became focused meanwhile.
      const activeGroup = splitLayoutRef.current.activeGroupId;
      // tabsRef/sessionsRef, not the closed-over tabs/sessions: a caller may
      // have awaited a refresh() immediately before this call (see
      // useFileOpeners' openFileInSession) expecting the post-refresh state,
      // but this function's own closure was fixed at the render that created
      // it — same stale-closure rationale as tabsRef itself.
      const existing = tabsRef.current.find(
        (t) => t.sessionName === session && t.windowIndex === index && t.groupId === activeGroup,
      );
      if (existing) {
        setActiveTabId(existing.id);
        // Same rationale as openSession's call: an already-active target
        // produces no focused-state transition, so grant terminal focus
        // explicitly.
        requestTerminalRefocus();
        return existing.id;
      }
      // If this is the session's currently active window and a whole-session
      // tab is already open in this group, that tab already shows this exact
      // content — focus it instead of spawning a duplicate grouped-session
      // tab under a different label.
      const isActiveWindow = sessionsRef.current
        .find((s) => s.name === session)
        ?.windows.find((w) => w.index === index)?.active;
      if (isActiveWindow) {
        const wholeSessionTab = tabsRef.current.find(
          (t) => t.sessionName === session && t.windowIndex === undefined && t.groupId === activeGroup,
        );
        if (wholeSessionTab) {
          setActiveTabId(wholeSessionTab.id);
          requestTerminalRefocus();
          return wholeSessionTab.id;
        }
      }
      // Snapshotted before the await below: if the user switches the active
      // tab while this request is in flight, the new tab still lands next to
      // whichever tab they initiated it from, not whatever became active
      // meanwhile.
      const anchorId = anchorOverride !== undefined ? anchorOverride : activeTabIdRef.current;
      if (!ignoreDetached) {
        const candidate: Tab = { id: "", sessionName: session, attachName: "", windowIndex: index };
        if (heldElsewhere(candidate, () => void openWindowTab(session, index, anchorOverride, true))) return null;
      }
      try {
        const { attachName } = await api.openWindowTab(session, index);
        const tab: Tab = {
          id: crypto.randomUUID(),
          sessionName: session,
          attachName,
          windowIndex: index,
          groupId: activeGroup,
        };
        setTabs((prev) => insertTab(prev, tab, anchorId));
        setActiveTabId(tab.id, activeGroup);
        return tab.id;
      } catch (err) {
        // The window vanished between the caller resolving `index` and this
        // call reaching the server (createWindowTab's WindowGoneError, see
        // server/src/terminals.ts) — an ordinary race, not a real failure. Recover
        // quietly rather than surfacing the backend's raw error as a toast.
        if (err instanceof ApiError && err.status === 404) return null;
        showError(err);
        return null;
      }
    },
    [showError, insertTab, heldElsewhere],
  );

  // Opens every one of a session's windows as its own window-tab (the
  // session-click behavior — see plans/session-open-all-and-pinned-
  // sessions.md). Reuses openWindowTab per-window for its existing dedupe/
  // fold-into-whole-session-tab logic; only the final "which tab ends up
  // focused" step is extra, since opening windows one at a time otherwise
  // leaves whichever window was opened last focused, not necessarily the
  // active one. Windows are sorted by index before iterating — the
  // server's session listing isn't guaranteed to return them in index
  // order — and each call passes the previous call's own returned tab id as
  // the next anchor, rather than trusting activeTabIdRef's render timing
  // across a tight awaited sequence (see openWindowTab's anchorOverride).
  const openAllWindows = useCallback(
    async (session: string) => {
      const target = sessions.find((s) => s.name === session);
      if (!target) return;
      const orderedWindows = [...target.windows].sort((a, b) => a.index - b.index);
      let anchor = activeTabIdRef.current;
      for (const w of orderedWindows) {
        const tabId = await openWindowTab(session, w.index, anchor);
        if (tabId) anchor = tabId;
      }
      const activeIndex = target.windows.find((w) => w.active)?.index;
      if (activeIndex === undefined) return;
      const activeGroup = splitLayoutRef.current.activeGroupId;
      const activeWindowTab = tabsRef.current.find(
        (t) => t.sessionName === session && t.windowIndex === activeIndex && t.groupId === activeGroup,
      );
      if (activeWindowTab) {
        setActiveTabId(activeWindowTab.id);
        return;
      }
      // The active window folded into an existing whole-session tab instead
      // of getting its own window-tab (see openWindowTab).
      const wholeSessionTab = tabsRef.current.find(
        (t) => t.sessionName === session && t.windowIndex === undefined && t.groupId === activeGroup,
      );
      if (wholeSessionTab) setActiveTabId(wholeSessionTab.id);
    },
    [sessions, openWindowTab],
  );

  // Tabs with unsaved edits (currently only csv-preview's editable grid
  // reports into this via setDirty — JSON's Format & Save is a one-shot
  // action, not an edit buffer). A plain ref, not state: membership changes
  // don't need to trigger a render on
  // their own, only the confirm check below reads it.
  const dirtyTabsRef = useRef<Set<string>>(new Set());

  // Reopen-closed-tab history (Alt+Shift+T), most-recently-closed last —
  // only user-initiated closes push here (closeTab, closeOtherTabs), never
  // the vanished-window sweep below: that tab's window is already
  // gone, so "reopening" it would just error. Capped so a burst of
  // closeOtherTabs can't grow this unbounded.
  const closedTabsRef = useRef<Tab[]>([]);
  const CLOSED_TABS_LIMIT = 10;
  const pushClosedTab = (tab: Tab) => {
    closedTabsRef.current = [...closedTabsRef.current, tab].slice(-CLOSED_TABS_LIMIT);
  };

  // The actual removal — MRU/window cleanup, group collapse, active-tab
  // reassignment — split out from closeTab so an unconditional close (no
  // dirty-changes confirm) can reuse it. See closeExtViewerTab below.
  // `record` false is a move, not a close (removeTabForMove below): the tab
  // lives on in another window, so it must neither join the reopen-closed
  // history nor release its attach.
  const dropTab = useCallback(
    (id: string, record: boolean) => {
      dirtyTabsRef.current.delete(id);
      const tab = tabs.find((t) => t.id === id);
      if (record && tab?.windowIndex !== undefined) {
        api.closeWindowTab(tab.attachName).catch(() => {});
      }
      if (record && tab) pushClosedTab(tab);
      mruTabIdsRef.current = mruTabIdsRef.current.filter((tid) => tid !== id);
      setTabs((prev) => prev.filter((t) => t.id !== id));

      if (!tab || tab.groupId === undefined) return;
      const closingGroupId = tab.groupId;
      const groupTabsAfter = tabs.filter((t) => t.id !== id && t.groupId === closingGroupId);
      const otherGroupsExist = leaves(splitLayoutRef.current.tree).length > 1;

      if (groupTabsAfter.length === 0 && otherGroupsExist) {
        // The closing group is now empty and isn't the app's only group —
        // collapse it (removeLeaf) and hand app focus to wherever the
        // most-recently-used surviving tab lives, in whatever group that is.
        setSplitLayout((prev) => {
          const tree = removeLeaf(prev.tree, closingGroupId);
          const groupActive = { ...prev.groupActive };
          delete groupActive[closingGroupId];
          const fallbackTab = mruTabIdsRef.current
            .map((tid) => tabs.find((t) => t.id === tid && t.id !== id))
            .find((t): t is Tab => t !== undefined);
          const activeGroupId = fallbackTab?.groupId ?? leaves(tree)[0];
          return { tree, groupActive, activeGroupId };
        });
        return;
      }

      // Targeted: only updates closingGroupId's own pointer, never steals
      // app focus for a background group whose tab closed via e.g.
      // middle-click while another split pane is focused.
      setActiveTabId((current) => {
        if (current !== id) return current;
        if (settingsRef.current.tabCloseActivation === "recent") {
          const previous = mruTabIdsRef.current.find(
            (tid) => tid !== id && groupTabsAfter.some((t) => t.id === tid),
          );
          if (previous) return previous;
        }
        const idx = tabs.filter((t) => t.groupId === closingGroupId).findIndex((t) => t.id === id);
        const neighbor = groupTabsAfter[Math.min(idx, groupTabsAfter.length - 1)];
        return neighbor ? neighbor.id : null;
      }, closingGroupId);
    },
    [tabs, settingsRef],
  );
  const closeTabImmediate = useCallback((id: string) => dropTab(id, true), [dropTab]);
  // "Move into New Window" (plans/detach-tab-to-new-window.md): the tab
  // leaves this window for a detached one, which reattaches by the same
  // attachName.
  const removeTabForMove = useCallback((id: string) => dropTab(id, false), [dropTab]);

  // The reverse: a detached window closed and handed its tabs back. They
  // join the focused editor group, minus any this window already shows
  // (tabsAreDuplicates), keeping their ids so the detached window's active
  // tab can be activated here by id.
  const adoptTabs = useCallback((incoming: Tab[], activeId: string | null) => {
    const groupId = splitLayoutRef.current.activeGroupId;
    // Deduped against this window's tabs and against each other: two split
    // panes showing one terminal over there collapse to one tab here.
    const fresh: Tab[] = [];
    for (const t of incoming) {
      const taken = (p: Tab) => p.id === t.id || tabsAreDuplicates(p, t);
      if (tabsRef.current.some(taken) || fresh.some(taken)) continue;
      fresh.push({ ...t, groupId });
    }
    if (fresh.length === 0) return;
    setTabs((prev) => [...prev, ...fresh]);
    if (activeId && fresh.some((t) => t.id === activeId)) setActiveTabId(activeId, groupId);
  }, [setActiveTabId]);

  const closeTab = useCallback(
    async (id: string) => {
      if (dirtyTabsRef.current.has(id)) {
        const ok = await confirmDialog("This tab has unsaved changes. Close anyway?", "Close");
        if (!ok) return;
      }
      closeTabImmediate(id);
    },
    [confirmDialog, closeTabImmediate],
  );

  // Closes an extension's own viewer tab by (viewerId, path) with no dirty-
  // changes confirm — for an extension that already knows it's safe to
  // close (e.g. prompts' draft tab right after its own save completes), the
  // one case extensions have no close-tab API for otherwise. No-op if no
  // such tab is open.
  const closeExtViewerTab = useCallback(
    (viewerId: string, path: string) => {
      const tab = tabs.find((t) => t.extViewerId === viewerId && t.extViewerPath === path);
      if (tab) closeTabImmediate(tab.id);
    },
    [tabs, closeTabImmediate],
  );

  // Cycles within whichever editor group currently has focus (Ctrl+Tab
  // moves through the focused split pane's own tabs, matching VS Code).
  const cycleTab = (delta: number) => {
    const activeGroup = splitLayoutRef.current.activeGroupId;
    const groupTabs = tabs.filter((t) => t.groupId === activeGroup);
    if (groupTabs.length < 2 || !activeTabId) return;
    const idx = groupTabs.findIndex((t) => t.id === activeTabId);
    if (idx === -1) return;
    setActiveTabId(groupTabs[(idx + delta + groupTabs.length) % groupTabs.length].id, activeGroup);
  };

  const moveTab = useCallback((draggedId: string, toIndex: number) => {
    setTabs((prev) => {
      const dragged = prev.find((t) => t.id === draggedId);
      if (!dragged) return prev;
      const slots: number[] = [];
      for (let i = 0; i < prev.length; i++) {
        if (prev[i].groupId === dragged.groupId) slots.push(i);
      }
      const groupTabs = slots.map((i) => prev[i]);
      const without = groupTabs.filter((t) => t.id !== draggedId);
      const clamped = Math.max(0, Math.min(toIndex, without.length));
      const reordered = [...without];
      reordered.splice(clamped, 0, dragged);
      if (reordered.every((t, i) => t.id === groupTabs[i]?.id)) return prev;
      const next = [...prev];
      slots.forEach((slot, i) => {
        next[slot] = reordered[i];
      });
      return next;
    });
  }, []);

  // Every tab in one editor group, as the tab bar's own empty-space menu
  // offers it. Mirrors closeOtherTabs — one dirty confirm for the whole
  // batch, each tab pushed on the reopen stack, MRU pruned — plus
  // closeTabImmediate's empty-pane branch: a split pane left with nothing
  // collapses, unless it is the only pane there is.
  const closeAllTabs = useCallback(
    async (editorGroupId: string) => {
      const toClose = tabsRef.current.filter((t) => t.groupId === editorGroupId);
      if (toClose.length === 0) return;
      const anyDirty = toClose.some((t) => dirtyTabsRef.current.has(t.id));
      if (anyDirty) {
        const ok = await confirmDialog("Some tabs have unsaved changes. Close them all anyway?", "Close All");
        if (!ok) return;
      }
      const closedIds = new Set(toClose.map((t) => t.id));
      for (const t of toClose) {
        dirtyTabsRef.current.delete(t.id);
        if (t.windowIndex !== undefined) api.closeWindowTab(t.attachName).catch(() => {});
        pushClosedTab(t);
      }
      mruTabIdsRef.current = mruTabIdsRef.current.filter((tid) => !closedIds.has(tid));
      const survivors = tabsRef.current.filter((t) => !closedIds.has(t.id));
      setTabs(survivors);
      setSplitLayout((prev) => {
        if (leaves(prev.tree).length <= 1) {
          return { ...prev, groupActive: { ...prev.groupActive, [editorGroupId]: null } };
        }
        const tree = removeLeaf(prev.tree, editorGroupId);
        const groupActive = { ...prev.groupActive };
        delete groupActive[editorGroupId];
        const fallback = mruTabIdsRef.current
          .map((tid) => survivors.find((t) => t.id === tid))
          .find((t): t is Tab => t !== undefined);
        return { tree, groupActive, activeGroupId: fallback?.groupId ?? leaves(tree)[0] };
      });
    },
    [confirmDialog],
  );

  const closeOtherTabs = useCallback(
    async (id: string) => {
      const target = tabs.find((t) => t.id === id);
      if (!target) return;
      // Scoped to id's own editor group — VS Code's tab-menu "Close Others"
      // never touches another split pane's tabs.
      const toClose = tabs.filter((t) => t.id !== id && t.groupId === target.groupId);
      const anyDirty = toClose.some((t) => dirtyTabsRef.current.has(t.id));
      if (anyDirty) {
        const ok = await confirmDialog("Some tabs have unsaved changes. Close all others anyway?", "Close All");
        if (!ok) return;
      }
      const closedIds = new Set(toClose.map((t) => t.id));
      for (const t of toClose) {
        dirtyTabsRef.current.delete(t.id);
        if (t.windowIndex !== undefined) api.closeWindowTab(t.attachName).catch(() => {});
        pushClosedTab(t);
      }
      mruTabIdsRef.current = mruTabIdsRef.current.filter((tid) => !closedIds.has(tid));
      setTabs((prev) => prev.filter((t) => !closedIds.has(t.id)));
      setActiveTabId(id, target.groupId);
    },
    [tabs, confirmDialog],
  );

  // Pops the most-recently-closed tab and replays it through the same
  // opener its kind normally uses — reuses each opener's own dedupe/fold
  // logic and (for window/session tabs) self-heals a dead session exactly
  // like a restored-from-localStorage tab does. Original position/group is
  // not restored; the reopened tab lands per newTabPlacement in whichever
  // group is currently focused, like any newly-opened tab.
  const reopenClosedTab = useCallback(() => {
    const stack = closedTabsRef.current;
    if (!stack.length) return;
    const tab = stack[stack.length - 1];
    closedTabsRef.current = stack.slice(0, -1);
    if (tab.settingsView) {
      openSettingsTab();
    } else if (tab.keyboardView) {
      openKeyboardShortcutsTab();
    } else if (tab.extensionPageId !== undefined) {
      openExtensionPageTab(tab.extensionPageId, tab.extensionPageSource);
    } else if (tab.extViewerId !== undefined && tab.extViewerPath !== undefined) {
      openExtViewerTab(tab.extViewerId, tab.extViewerPath, tab.extViewerTitle);
    } else if (tab.windowIndex !== undefined) {
      openWindowTab(tab.sessionName, tab.windowIndex);
    } else if (tab.sessionName) {
      openSession(tab.sessionName);
    }
  }, [
    openSettingsTab,
    openKeyboardShortcutsTab,
    openExtensionPageTab,
    openExtViewerTab,
    openWindowTab,
    openSession,
  ]);

  // Runs every poll: rewrites any tab whose session/window drifted from an
  // out-of-band rename or renumber (see reconcileTabs), and follows the same
  // rename for any viewer tab's originSessionName (see openExtViewerTab) —
  // otherwise it'd silently drop out of its group the instant the session it
  // was opened from gets renamed. tabGroupState's own key migration (App.tsx,
  // until it moves into useTabGroups) detects the same renames independently
  // from tabsRef rather than sharing this effect's computation, so the two
  // concerns don't need to reach into each other.
  useEffect(() => {
    if (!sessionsLoadedRef.current) return;
    const renames = new Map<string, string>();
    for (const tab of tabsRef.current) {
      if (!tab.sessionId) continue;
      const session = sessions.find((s) => s.id === tab.sessionId);
      if (session && session.name !== tab.sessionName) renames.set(tab.sessionName, session.name);
    }
    setTabs((prev) => {
      const reconciled = reconcileTabs(prev, sessions);
      if (renames.size === 0) return reconciled;
      let changed = false;
      const next = reconciled.map((tab) => {
        const renamed = tab.originSessionName && renames.get(tab.originSessionName);
        if (!renamed) return tab;
        changed = true;
        return { ...tab, originSessionName: renamed };
      });
      return changed ? next : reconciled;
    });
  }, [sessions, sessionsLoadedRef]);

  // A window-tab's pinned window can disappear for reasons we can't
  // explicitly intercept client-side — nvim exiting closes the window it
  // was the sole command of, a shell's own "exit", someone killing it from
  // a real terminal. Left alone, the tab would silently start showing
  // whatever adjacent window the backend falls back to (same root cause as the
  // explicit "Kill Window" cascade in useSessionActions, but for every other
  // trigger). This is deliberately generic rather than another explicit
  // cascade: it catches all of the above, including the vanished-real-
  // session edge case noted in plans/per-window-tabs.md, from the poll we
  // already run.
  useEffect(() => {
    if (!sessionsLoadedRef.current) return;
    for (const tab of tabs) {
      if (tab.windowIndex === undefined) continue;
      // id first: an out-of-band rename/renumber must not read as the
      // window having disappeared (see reconcileTabs above this effect).
      const session = tab.sessionId
        ? sessions.find((s) => s.id === tab.sessionId)
        : sessions.find((s) => s.name === tab.sessionName);
      const stillExists = tab.windowId
        ? (session?.windows.some((w) => w.id === tab.windowId) ?? false)
        : (session?.windows.some((w) => w.index === tab.windowIndex) ?? false);
      if (!stillExists) closeTab(tab.id);
    }
  }, [sessions, tabs, sessionsLoadedRef, closeTab]);

  // A viewer tab's origin session (see openExtViewerTab) can go away —
  // killed, or its last real tab closed independently of the viewer tab.
  // The viewer tab itself has no live terminal process to lose, so it stays
  // open; it just ungroups (clears origin) rather than keeping a chip for a
  // session that no longer exists.
  useEffect(() => {
    if (!sessionsLoadedRef.current) return;
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        if (tab.originSessionName === undefined) return tab;
        const stillExists = tab.originSessionId
          ? sessions.some((s) => s.id === tab.originSessionId)
          : sessions.some((s) => s.name === tab.originSessionName);
        if (stillExists) return tab;
        changed = true;
        const { originSessionName: _n, originSessionId: _i, ...rest } = tab;
        return rest;
      });
      return changed ? next : prev;
    });
  }, [sessions, sessionsLoadedRef]);

  // A virtual tab opened from a project (originSessionName — a preview of
  // one of its files, say) belongs to that project, so switching to it moves
  // the sidebar there: the real tab it resolves to is one of that session's
  // own, preferring the last-active one, and only a virtual tab with no
  // origin (settings, or a preview whose session went away) falls back to
  // whichever real tab was open most recently.
  const virtualOrigin = activeTab && !isRealTab(activeTab) ? activeTab.originSessionName : undefined;
  const lastRealTab = tabs.find((t) => t.id === lastRealTabIdRef.current) ?? null;
  const activeRealTab =
    activeTab && isRealTab(activeTab)
      ? activeTab
      : virtualOrigin === undefined
        ? lastRealTab
        : lastRealTab?.sessionName === virtualOrigin
          ? lastRealTab
          : (tabs.find((t) => isRealTab(t) && t.sessionName === virtualOrigin) ?? lastRealTab);

  // The session the sidebar (FILES root, PROJECTS highlight, lazygit pill)
  // and every session-level command act on. Usually activeRealTab's, but a
  // virtual tab's origin session wins even when none of its terminals is
  // open as a tab any more — the project is still the one the tab came from.
  const activeSessionName: string | null =
    virtualOrigin !== undefined && sessions.some((s) => s.name === virtualOrigin)
      ? virtualOrigin
      : (activeRealTab?.sessionName ?? null);

  const activeSession = sessions.find((s) => s.name === activeSessionName) ?? null;
  // A window-tab is pinned to a specific window, which may not be the
  // session's own active window (their current-window pointers
  // diverge independently once a window-tab exists) — look it up by index
  // rather than falling back to whatever the session considers active. Only
  // when the tab is in the active session, though: a real tab left over
  // from another project says nothing about this one's windows.
  const activeWindow =
    activeRealTab?.windowIndex !== undefined && activeRealTab.sessionName === activeSessionName
      ? activeSession?.windows.find((w) => w.index === activeRealTab.windowIndex)
      : activeSession?.windows.find((w) => w.active);
  const filesRootDir = activeWindow?.cwd ?? null;

  // Feeds ctx.app.getActiveContext()/onDidChangeContext() for extensions —
  // reuses the exact same activeRealTab/activeWindow derivation the FILES
  // panel and lazygit pill already trust, so an extension sees the same
  // "current session/window" a virtual tab (image/preview/settings/another
  // ext viewer) doesn't collapse to.
  useEffect(() => {
    setActiveContext({
      sessionName: activeSessionName,
      windowIndex: activeWindow?.index ?? null,
      cwd: filesRootDir,
    });
  }, [activeSessionName, activeWindow, filesRootDir]);

  // Folder-derived display name for a session's project — the label every
  // surface (tabs, chips, quick switcher) uses instead of the session
  // name; pathless sessions keep their name. projectKeyForSession is the
  // grouping counterpart: same-folder sessions share a key, so a merged
  // project gets one tab-group chip (see useTabGroups).
  const projectLabelForSession = useCallback(
    (name: string): string => {
      const s = sessions.find((x) => x.name === name);
      return s?.path ? projectName(s.path) : name;
    },
    [sessions],
  );
  const projectKeyForSession = useCallback(
    (name: string): string => {
      const s = sessions.find((x) => x.name === name);
      return s?.path || name;
    },
    [sessions],
  );

  const tabLabel = useCallback(
    (tab: Tab): string => {
      if (tab.settingsView) return "Settings";
      if (tab.keyboardView) return "Keyboard Shortcuts";
      if (tab.extensionPageId !== undefined) {
        const installed = extensions.find((e) => e.id === tab.extensionPageId);
        if (installed) return installed.displayName;
        for (const src of registryCatalog) {
          const entry = src.entries.find((e) => e.id === tab.extensionPageId);
          if (entry) return entry.displayName;
        }
        return tab.extensionPageId;
      }
      if (tab.extViewerTitle !== undefined) return tab.extViewerTitle;
      const virtualPath = tabVirtualPath(tab);
      if (virtualPath !== undefined) {
        return virtualPath.slice(virtualPath.lastIndexOf("/") + 1);
      }
      if (tab.windowIndex === undefined) return projectLabelForSession(tab.sessionName);
      const session = sessions.find((s) => s.name === tab.sessionName);
      const win = session?.windows.find((w) => w.index === tab.windowIndex);
      return `${projectLabelForSession(tab.sessionName)} · ${win?.name ?? `terminal ${tab.windowIndex}`}`;
    },
    [sessions, extensions, registryCatalog, projectLabelForSession],
  );

  // Suppressed on the active tab — you're already looking at it, a dot
  // there would just be noise. A window tab reflects its one window; a
  // whole-session tab reflects "any window in it has new output".
  const tabActivity = useCallback(
    (tab: Tab): boolean => {
      // Suppressed on every group's own currently-visible tab, not just the
      // app-focused one — VS Code shows no dot on any visible editor, and a
      // background split pane's own shown tab is still visible on screen.
      if (tab.groupId !== undefined && splitLayout.groupActive[tab.groupId] === tab.id) return false;
      const session = sessions.find((s) => s.name === tab.sessionName);
      if (!session) return false;
      if (tab.windowIndex !== undefined) {
        return session.windows.find((w) => w.index === tab.windowIndex)?.activity ?? false;
      }
      return session.windows.some((w) => w.activity);
    },
    [sessions, splitLayout.groupActive],
  );

  // A cross-session pick made from inside the terminal (the tmux backend's choose-tree) — the server
  // already switched the client back to the tab's own session. Surface the
  // target, preferring a tab pinned to the exact window the pick landed on
  // over the whole-session tab.
  const openSwitchedSession = useCallback(
    (session: string, windowIndex: number) => {
      const existing = tabs.find(
        (t) => t.sessionName === session && t.windowIndex === windowIndex,
      );
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      openSession(session);
    },
    [tabs, openSession],
  );

  // Splits `tab` into `targetGroupId` as a second, independent tab —
  // "Split" duplicates rather than moves (plans/vscode-editor-group-splits.md).
  // A window-tab gets a fresh grouped view session (createWindowTab mints
  // one per open, so two live views of the same window is just calling
  // this route twice); a whole-session tab attaches the same session name a
  // second time (the backend supports multiple viewers and sizes the window
  // for the view used last, see server/src/terminals.ts); a
  // viewer tab copies its fields into an independent instance (editable
  // viewers don't sync — last save wins, documented in the README). The
  // Settings and Keyboard Shortcuts tabs are global singletons and aren't
  // duplicated.
  const duplicateTabToGroup = useCallback(
    async (tab: Tab, targetGroupId: string): Promise<void> => {
      if (tab.settingsView) return;
      if (tab.keyboardView) return;
      // Global singleton, like the settings tab — not duplicated per group.
      if (tab.extensionPageId !== undefined) return;
      if (tab.windowIndex !== undefined) {
        try {
          const { attachName } = await api.openWindowTab(tab.sessionName, tab.windowIndex);
          const copy: Tab = {
            id: crypto.randomUUID(),
            sessionName: tab.sessionName,
            attachName,
            windowIndex: tab.windowIndex,
            groupId: targetGroupId,
          };
          setTabs((prev) => [...prev, copy]);
          setActiveTabId(copy.id, targetGroupId);
        } catch (err) {
          showError(err);
        }
        return;
      }
      if (tab.extViewerId !== undefined && tab.extViewerPath !== undefined) {
        const copy: Tab = {
          id: crypto.randomUUID(),
          sessionName: "",
          attachName: "",
          groupId: targetGroupId,
          extViewerId: tab.extViewerId,
          extViewerPath: tab.extViewerPath,
          extViewerTitle: tab.extViewerTitle,
          originSessionName: tab.originSessionName,
          originSessionId: tab.originSessionId,
        };
        setTabs((prev) => [...prev, copy]);
        setActiveTabId(copy.id, targetGroupId);
        return;
      }
      if (tab.sessionName) {
        const copy: Tab = {
          id: crypto.randomUUID(),
          sessionName: tab.sessionName,
          attachName: tab.attachName,
          groupId: targetGroupId,
        };
        setTabs((prev) => [...prev, copy]);
        setActiveTabId(copy.id, targetGroupId);
      }
    },
    [showError],
  );

  // "Split Editor Right/Down/Left/Up": splits whichever group `tabId` (or
  // the active tab, if omitted) belongs to, and duplicates that tab into
  // the new group. An empty source group (no active tab) still splits —
  // it just produces an empty new group, matching VS Code's own "split an
  // empty group" behavior. `nextTree` is computed synchronously against
  // splitLayoutRef.current (not read back out of setSplitLayout's updater,
  // whose execution React may defer past this function's return).
  const splitGroup = useCallback(
    async (direction: SplitDirection, tabId?: string): Promise<void> => {
      const targetTabId = tabId ?? splitLayoutRef.current.groupActive[splitLayoutRef.current.activeGroupId];
      const sourceTab = targetTabId ? tabsRef.current.find((t) => t.id === targetTabId) : undefined;
      const sourceGroupId = sourceTab?.groupId ?? splitLayoutRef.current.activeGroupId;
      const newGroupId = crypto.randomUUID();
      const currentTree = splitLayoutRef.current.tree;
      const nextTree = splitLeaf(currentTree, sourceGroupId, direction, newGroupId);
      if (nextTree === currentTree) return;
      setSplitLayout((prev) => ({
        tree: nextTree,
        groupActive: { ...prev.groupActive, [newGroupId]: null },
        activeGroupId: newGroupId,
      }));
      if (sourceTab) {
        await duplicateTabToGroup(sourceTab, newGroupId);
      }
    },
    [duplicateTabToGroup],
  );

  // Moves (not duplicates) `tabId` into `targetGroupId` — the drag-to-split
  // "center zone" / cross-bar drop, and "Move into Next Group". `index`, if
  // given, is relative to the target group's own tab order (matching
  // moveTab's contract); omit it to append after the target group's last
  // tab. Always focuses the destination group (VS Code's own drag
  // semantics). The source group auto-closes (removeLeaf) if this was its
  // last tab and it isn't the app's only group; otherwise it's left with no
  // active tab, matching closeTab's own empty-group handling. Source-group
  // bookkeeping reads tabsRef.current once, up front — a snapshot from
  // before either setState call below, so it can't observe its own move.
  const moveTabToGroup = useCallback((tabId: string, targetGroupId: string, index?: number) => {
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (!tab || tab.groupId === targetGroupId) return;
    const sourceGroupId = tab.groupId;
    const sourceEmptyAfterMove =
      sourceGroupId !== undefined &&
      tabsRef.current.filter((t) => t.groupId === sourceGroupId && t.id !== tabId).length === 0;

    setTabs((prev) => {
      const withoutDragged = prev.filter((t) => t.id !== tabId);
      const moved: Tab = { ...tab, groupId: targetGroupId };
      const targetSlots: number[] = [];
      withoutDragged.forEach((t, i) => {
        if (t.groupId === targetGroupId) targetSlots.push(i);
      });
      let insertAt: number;
      if (index === undefined || index >= targetSlots.length) {
        insertAt = targetSlots.length > 0 ? targetSlots[targetSlots.length - 1] + 1 : withoutDragged.length;
      } else {
        insertAt = targetSlots[Math.max(0, index)];
      }
      return [...withoutDragged.slice(0, insertAt), moved, ...withoutDragged.slice(insertAt)];
    });

    setSplitLayout((prev) => {
      let tree = prev.tree;
      const groupActive = { ...prev.groupActive, [targetGroupId]: tabId };
      if (sourceGroupId !== undefined) {
        if (sourceEmptyAfterMove && leaves(tree).length > 1) {
          tree = removeLeaf(tree, sourceGroupId);
          delete groupActive[sourceGroupId];
        } else if (sourceEmptyAfterMove) {
          groupActive[sourceGroupId] = null;
        }
      }
      return { tree, groupActive, activeGroupId: targetGroupId };
    });
  }, []);

  // "Move Editor into Next/Previous Group" when there's no next/previous
  // group to move into (VS Code creates one) — unlike splitGroup, nothing is
  // duplicated into the new group; the tab is moved there directly. Both
  // setSplitLayout calls apply within the same batch, in order, so
  // moveTabToGroup's own updater sees this tree change already applied.
  // General primitive: splits `targetGroupId` in `direction`, creating a new
  // empty group, then moves `tabId` there directly (unlike splitGroup,
  // nothing is duplicated). `targetGroupId` need not be tabId's own group —
  // the drag-to-split edge-zone drop (SplitLayout's coordinator) splits
  // whichever group was dropped onto, which may differ from the dragged
  // tab's source group.
  const splitGroupAndMoveTab = useCallback(
    (targetGroupId: string, direction: SplitDirection, tabId: string) => {
      const newGroupId = crypto.randomUUID();
      const currentTree = splitLayoutRef.current.tree;
      const nextTree = splitLeaf(currentTree, targetGroupId, direction, newGroupId);
      if (nextTree === currentTree) return;
      setSplitLayout((prev) => ({
        ...prev,
        tree: nextTree,
        groupActive: { ...prev.groupActive, [newGroupId]: null },
      }));
      moveTabToGroup(tabId, newGroupId);
    },
    [moveTabToGroup],
  );

  // "Move Editor into Next/Previous Group" when there's no next/previous
  // group to move into — splits the tab's own current group.
  const moveTabToNewGroup = useCallback(
    (tabId: string, direction: SplitDirection) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab || tab.groupId === undefined) return;
      splitGroupAndMoveTab(tab.groupId, direction, tabId);
    },
    [splitGroupAndMoveTab],
  );

  // "Move Editor into Next/Previous Group" (App.tsx's tab.moveToNextGroup/
  // tab.moveToPreviousGroup commands, useSessionActions.ts's tab context
  // menu item). Walks outward from tabId's own group in `direction`,
  // skipping any group that already holds a duplicate of this tab
  // (tabsAreDuplicates) — moving into one would otherwise leave two tabs
  // pointing at the same content in a single group, breaking the
  // one-instance-per-group invariant every opener (openSession,
  // openWindowTab, openExtViewerTab) already enforces. Falls through to
  // splitting off a brand-new group only when there's no group at all in
  // that direction yet — a fresh group can never itself be a duplicate. If
  // every existing group in that direction already has a duplicate, this is
  // a no-op: every candidate is already showing this tab's content, and
  // there's no "no group exists" gap left to split open.
  const moveTabToAdjacentGroup = useCallback(
    (tabId: string, direction: "next" | "previous") => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab || tab.groupId === undefined) return;
      const order = leaves(splitLayoutRef.current.tree);
      const idx = order.indexOf(tab.groupId);
      if (idx === -1) return;
      const step = direction === "next" ? 1 : -1;
      const candidates: string[] = [];
      for (let i = idx + step; i >= 0 && i < order.length; i += step) candidates.push(order[i]);
      if (candidates.length === 0) {
        moveTabToNewGroup(tabId, direction === "next" ? "right" : "left");
        return;
      }
      const target = candidates.find(
        (groupId) => !tabsRef.current.some((t) => t.groupId === groupId && tabsAreDuplicates(t, tab)),
      );
      if (target) moveTabToGroup(tabId, target);
    },
    [moveTabToGroup, moveTabToNewGroup],
  );

  // A sash drag or double-click-to-even-out — see lib/splits.ts's
  // setBranchSizes for the path/sizes contract.
  const resizeBranch = useCallback((path: number[], sizes: number[]) => {
    setSplitLayout((prev) => {
      const tree = setBranchSizes(prev.tree, path, sizes);
      return tree === prev.tree ? prev : { ...prev, tree };
    });
  }, []);

  // Focuses `groupId` directly, leaving its own active-tab pointer untouched
  // — a click into a split pane's content area (including an empty group,
  // which has no tab id setActiveTabId could key off) that shouldn't change
  // which tab that group is showing, only which group has app focus.
  const focusGroup = useCallback((groupId: string) => {
    setSplitLayout((prev) => (prev.activeGroupId === groupId ? prev : { ...prev, activeGroupId: groupId }));
  }, []);

  return {
    tabs,
    setTabs,
    tabsRef,
    activeTabId,
    setActiveTabId,
    activeTabIdRef,
    lastRealTabIdRef,
    mruTabIdsRef,
    dirtyTabsRef,
    insertTab,
    openSession,
    openExtViewerTab,
    closeExtViewerTab,
    openSettingsTab,
    openKeyboardShortcutsTab,
    openExtensionPageTab,
    openWindowTab,
    openAllWindows,
    closeTab,
    removeTabForMove,
    adoptTabs,
    closeAllTabs,
    cycleTab,
    moveTab,
    closeOtherTabs,
    reopenClosedTab,
    activeTab,
    activeRealTab,
    activeSessionName,
    activeSession,
    activeWindow,
    filesRootDir,
    tabLabel,
    tabActivity,
    projectLabelForSession,
    projectKeyForSession,
    openSwitchedSession,
    splitTree: splitLayout.tree,
    activeGroupId: splitLayout.activeGroupId,
    groupActive: splitLayout.groupActive,
    activeGroupTabs,
    duplicateTabToGroup,
    splitGroup,
    moveTabToGroup,
    moveTabToNewGroup,
    moveTabToAdjacentGroup,
    splitGroupAndMoveTab,
    focusGroup,
    resizeBranch,
  };
}

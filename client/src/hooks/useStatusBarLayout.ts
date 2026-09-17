import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { extensionStatusBarItems, useExtensionRegistryVersion } from "../extensions";
import { loadStatusBarLayout, saveStatusBarLayout } from "../settings";
import {
  EMPTY_STATUS_BAR_LAYOUT,
  MANAGE_ITEM_ID,
  TERMINALS_ITEM_ID,
  toggleStatusBarItemHidden,
  type StatusBarLayout,
  type StatusBarSlot,
} from "../lib/statusBarLayout";
import type { ExtensionSettingsValues } from "../settings";
import type { ExtensionInfo, MenuItem } from "../types";

// Who is in the status bar, what each item is called, and which ones the user
// switched off (plans/status-bar-widget-show-hide.md).
//
// This lives outside StatusBar because the show/hide list has two homes: the
// bar's own right-click menu, and the gear menu App builds — which must still
// list every item when the bar itself is turned off in Settings and the
// component isn't mounted at all. So App owns the state and the bar renders
// what it's handed, the same split useSidebarLayout uses for the Panes list.
//
// Two kinds of switch, because an extension may already have one. Without a
// visibilitySetting the app keeps the id in layout.hidden, beside the drag
// order, and both travel between devices through the settings document. With
// one, that setting is the single source of truth and the app writes it — so
// Git's "show the branch" setting and its row in the list can never disagree.
//
// Storage is split the way useSidebarLayout splits it: localStorage renders
// instantly (settings.ts owns those accessors), and the cross-device copy
// arrives as `syncedLayout` from useSettingsSync, which also receives every
// deliberate change back through `onLayoutChange`.

// One row of the show/hide list.
export interface StatusBarEntry {
  id: string;
  label: string;
  visible: boolean;
  toggle: () => void;
}

interface Options {
  // Names the rows: an item with no title of its own borrows its extension's.
  extensions: ExtensionInfo[];
  extensionSettings: ExtensionSettingsValues;
  setExtensionSettings: Dispatch<SetStateAction<ExtensionSettingsValues>>;
  mobilePointer: boolean;
  // The cross-device arrangement, or null on a device that has never synced
  // one — applied once when it first arrives, never re-applied, so it can't
  // fight a later local drag (same contract as useSidebarLayout's).
  syncedLayout: StatusBarLayout | null;
  onLayoutChange: (layout: StatusBarLayout) => void;
}

export function useStatusBarLayout({
  extensions,
  extensionSettings,
  setExtensionSettings,
  mobilePointer,
  syncedLayout,
  onLayoutChange,
}: Options) {
  const [layout, setLayout] = useState<StatusBarLayout>(
    () => loadStatusBarLayout() ?? EMPTY_STATUS_BAR_LAYOUT,
  );

  useEffect(() => {
    saveStatusBarLayout(layout);
  }, [layout]);

  // Applied once, the first time a synced layout arrives.
  const appliedSyncedRef = useRef(false);
  useEffect(() => {
    if (appliedSyncedRef.current || !syncedLayout) return;
    appliedSyncedRef.current = true;
    setLayout(syncedLayout);
  }, [syncedLayout]);

  // Every write goes through here, so there is one place that pushes to the
  // settings document. Two writers reach it: the hidden toggle below, and the
  // drag in StatusBar.tsx, which calls this as its `setLayout` prop. Both are
  // deliberate user actions, so this pushes unconditionally — unlike
  // useSidebarLayout, whose panel state is also written by an append-only
  // reconciliation that runs on every load and must never be pushed.
  //
  // The updater is resolved against a ref rather than inside setLayout's own
  // updater, because a state updater can run twice under StrictMode and
  // onLayoutChange is a side effect (the same hazard useBottomPanel documents
  // for its detach calls). moveStatusBarItem and toggleStatusBarItemHidden
  // both return the previous object for a no-op, so identity is a sound test
  // for "nothing to push".
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const onLayoutChangeRef = useRef(onLayoutChange);
  onLayoutChangeRef.current = onLayoutChange;
  const applyLayout = useCallback((update: SetStateAction<StatusBarLayout>) => {
    const prev = layoutRef.current;
    const next = typeof update === "function" ? update(prev) : update;
    if (next === prev) return;
    layoutRef.current = next;
    setLayout(next);
    onLayoutChangeRef.current(next);
  }, []);

  // The registry is mutable state outside React, so this version is what
  // re-reads it when an extension registers an item or goes away.
  const registryVersion = useExtensionRegistryVersion();
  const extItems = useMemo(
    () => [...extensionStatusBarItems].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    [registryVersion],
  );

  // Every item the bar could render, in registration order, with the group it
  // belongs to until the user moves it.
  const slots = useMemo<StatusBarSlot[]>(
    () => [
      ...extItems.map((item) => ({ id: item.id, defaultSide: item.placement })),
      { id: TERMINALS_ITEM_ID, defaultSide: "right" as const },
      ...(mobilePointer ? [{ id: MANAGE_ITEM_ID, defaultSide: "right" as const }] : []),
    ],
    [extItems, mobilePointer],
  );

  const setExtensionFlag = useCallback(
    (extensionId: string, key: string, value: boolean) => {
      setExtensionSettings((prev) => ({
        ...prev,
        [extensionId]: { ...prev[extensionId], [key]: value },
      }));
    },
    [setExtensionSettings],
  );

  // One row per item the user may switch off. The phone's Manage gear is
  // deliberately absent: on a phone that button is the only way back to this
  // very list, so hiding it would be a one-way door.
  const entries = useMemo<StatusBarEntry[]>(() => {
    const rows = extItems.map((item) => {
      const setting = item.visibilitySetting;
      const visible = setting
        ? extensionSettings[item.extensionId]?.[setting] !== false
        : !layout.hidden.includes(item.id);
      return {
        id: item.id,
        label:
          item.title ?? extensions.find((e) => e.id === item.extensionId)?.displayName ?? item.id,
        visible,
        toggle: () =>
          setting
            ? setExtensionFlag(item.extensionId, setting, !visible)
            : applyLayout((prev) => toggleStatusBarItemHidden(prev, item.id)),
      };
    });
    rows.push({
      id: TERMINALS_ITEM_ID,
      label: "Terminals",
      visible: !layout.hidden.includes(TERMINALS_ITEM_ID),
      toggle: () => applyLayout((prev) => toggleStatusBarItemHidden(prev, TERMINALS_ITEM_ID)),
    });
    return rows.sort((a, b) => a.label.localeCompare(b.label));
  }, [extItems, extensions, extensionSettings, layout.hidden, setExtensionFlag, applyLayout]);

  // What the bar actually renders. A switched-off item is simply not a slot,
  // which is what keeps its stored position untouched while it's away.
  const visibleSlots = useMemo(() => {
    const off = new Set(entries.filter((e) => !e.visible).map((e) => e.id));
    return slots.filter((slot) => !off.has(slot.id));
  }, [slots, entries]);

  const menuItems = useCallback(
    (): MenuItem[] =>
      entries.length > 0
        ? entries.map((entry) => ({
            label: entry.label,
            checked: entry.visible,
            onClick: entry.toggle,
          }))
        : [{ label: "No widgets", disabled: true, onClick: () => {} }],
    [entries],
  );

  return { layout, setLayout: applyLayout, visibleSlots, menuItems };
}

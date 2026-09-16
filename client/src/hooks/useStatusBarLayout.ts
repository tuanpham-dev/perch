import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { extensionStatusBarItems, useExtensionRegistryVersion } from "../extensions";
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
// visibilitySetting the app keeps the id in layout.hidden (per device, beside
// the drag order). With one, that setting is the single source of truth and
// the app writes it — so Git's "show the branch" setting and its row in the
// list can never disagree.

const LAYOUT_KEY = "statusBarLayout";

function loadLayout(): StatusBarLayout {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
    if (parsed && typeof parsed === "object") {
      const ids = (value: unknown) =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      return { left: ids(parsed.left), right: ids(parsed.right), hidden: ids(parsed.hidden) };
    }
  } catch {
    // Fall through to the empty layout — every item then takes its default
    // group and registration order.
  }
  return EMPTY_STATUS_BAR_LAYOUT;
}

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
}

export function useStatusBarLayout({
  extensions,
  extensionSettings,
  setExtensionSettings,
  mobilePointer,
}: Options) {
  const [layout, setLayout] = useState<StatusBarLayout>(loadLayout);

  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  }, [layout]);

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
            : setLayout((prev) => toggleStatusBarItemHidden(prev, item.id)),
      };
    });
    rows.push({
      id: TERMINALS_ITEM_ID,
      label: "Terminals",
      visible: !layout.hidden.includes(TERMINALS_ITEM_ID),
      toggle: () => setLayout((prev) => toggleStatusBarItemHidden(prev, TERMINALS_ITEM_ID)),
    });
    return rows.sort((a, b) => a.label.localeCompare(b.label));
  }, [extItems, extensions, extensionSettings, layout.hidden, setExtensionFlag]);

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

  return { layout, setLayout, visibleSlots, menuItems };
}

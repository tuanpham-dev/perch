import type { Tab } from "../types";

// Detached windows (plans/detach-tab-to-new-window.md): "Move into New
// Window" opens a second window of the app that shows only the editor area.
// The same bundle serves both windows; a window is detached when its URL
// carries ?detached=<uuid>. Everything that must differ between the two
// roles reads IS_DETACHED, and every piece of tab state (tabs, split tree,
// chip state) goes through tabStorage() so a detached window keeps its own
// copy in sessionStorage - per top-level window, survives that window's
// reload, dies with it - and never touches the main window's localStorage.
//
// The two roles coordinate over a BroadcastChannel: a detached window
// announces its tabs (on load and on every change), the main window keeps a
// registry of them for cross-window dedupe and for adopting the tabs back
// when a detached window closes. Everything in this module is pure or
// DOM-trivial so the hook (hooks/useDetachedWindows.ts) stays thin.

const WINDOW_ID_RE = /^[0-9a-f-]{36}$/;
const HANDOFF_PARAM = "handoff";

function readDetachedWindowId(): string | null {
  if (typeof location === "undefined") return null;
  const value = new URLSearchParams(location.search).get("detached");
  return value && WINDOW_ID_RE.test(value) ? value : null;
}

export const DETACHED_WINDOW_ID: string | null = readDetachedWindowId();
export const IS_DETACHED = DETACHED_WINDOW_ID !== null;

// Identifies this window within one drag (plans/cross-window-tab-drag.md):
// a drop whose payload carries this id is an in-window drop. A main window
// gets a fresh id per load, which is all a drag needs.
export const WINDOW_INSTANCE_ID: string =
  DETACHED_WINDOW_ID ?? (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "main");

// Where this window's tab state lives. sessionStorage is copied from the
// opener when a window is opened by script, so a detached window that spawns
// another one hands its copy along - harmless, since the hand-off below
// overwrites every key it owns.
export function tabStorage(): Storage {
  return IS_DETACHED ? sessionStorage : localStorage;
}

// ---- Hand-off ---------------------------------------------------------------

export interface Handoff {
  tabs: Tab[];
  activeTabId: string | null;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function encodeHandoff(handoff: Handoff): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(handoff)));
}

export function decodeHandoff(encoded: string): Handoff | null {
  const bytes = fromBase64Url(encoded);
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { tabs, activeTabId } = parsed as { tabs?: unknown; activeTabId?: unknown };
  if (!Array.isArray(tabs)) return null;
  if (!tabs.every((t) => typeof t === "object" && t !== null && typeof (t as Tab).id === "string")) return null;
  return { tabs: tabs as Tab[], activeTabId: typeof activeTabId === "string" ? activeTabId : null };
}

// Reads and strips the #handoff=<encoded> fragment the opener put on this
// window's URL, so a reload restores from storage instead of re-seeding.
export function consumeHandoff(): Handoff | null {
  if (typeof location === "undefined") return null;
  const match = /(?:^#|&)handoff=([^&]+)/.exec(location.hash);
  if (!match) return null;
  const handoff = decodeHandoff(match[1]);
  const url = new URL(location.href);
  url.hash = "";
  history.replaceState(null, "", url);
  return handoff;
}

// The id of the app's first editor group - must equal useTabs.ts's
// DEFAULT_GROUP_ID, since the handed-off tabs land in a fresh single-leaf
// tree under that id.
export const ROOT_GROUP_ID = "root";

// Writes the handed-off tabs into `storage` in exactly the shape useTabs /
// useTabGroups restore from: every tab re-stamped into the root leaf, the
// root leaf active with the handed-off active tab, no chip state yet (the
// chip effect assigns colors on first render).
export function seedDetachedStorage(handoff: Handoff, storage: Storage): void {
  const tabs = handoff.tabs.map((t) => ({ ...t, groupId: ROOT_GROUP_ID }));
  const activeTabId = tabs.some((t) => t.id === handoff.activeTabId) ? handoff.activeTabId : (tabs[0]?.id ?? null);
  storage.setItem("tabs", JSON.stringify(tabs));
  storage.setItem(
    "splitLayout",
    JSON.stringify({
      tree: { type: "leaf", groupId: ROOT_GROUP_ID },
      groupActive: { [ROOT_GROUP_ID]: activeTabId },
      activeGroupId: ROOT_GROUP_ID,
    }),
  );
  storage.setItem("tabGroupState", JSON.stringify({}));
}

// ---- Dragging tabs between windows -----------------------------------------

// The drag's own payload type. Two more, data-less types let a window branch
// during dragover, where only the type list is readable: the dirty marker
// (an unsaved tab must not leave its window) and the chip marker (chips
// only land on a strip, never on a pane zone).
export const TAB_DRAG_TYPE = "application/x-perch-tabs";
export const TAB_DRAG_DIRTY_TYPE = "application/x-perch-dirty";
export const TAB_DRAG_CHIP_TYPE = "application/x-perch-chip";

export interface TabDragPayload {
  dragId: string;
  windowId: string;
  kind: "tab" | "chip";
  tabs: Tab[];
  // The chip's group key (a chip drag only), so the target can position the
  // chip once the tabs are in.
  groupKey?: string;
  // The source pane's content size, for a tear-off window.
  paneRect: { width: number; height: number };
}

export function encodeDragPayload(payload: TabDragPayload): string {
  return JSON.stringify(payload);
}

export function decodeDragPayload(text: string): TabDragPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const p = parsed as Partial<TabDragPayload>;
  if (typeof p.dragId !== "string" || typeof p.windowId !== "string") return null;
  if (p.kind !== "tab" && p.kind !== "chip") return null;
  if (!Array.isArray(p.tabs) || !p.tabs.every((t) => typeof t === "object" && t !== null && typeof t.id === "string")) {
    return null;
  }
  const rect = p.paneRect;
  const paneRect =
    rect && typeof rect.width === "number" && typeof rect.height === "number"
      ? { width: rect.width, height: rect.height }
      : { width: 0, height: 0 };
  return {
    dragId: p.dragId,
    windowId: p.windowId,
    kind: p.kind,
    tabs: p.tabs,
    groupKey: typeof p.groupKey === "string" ? p.groupKey : undefined,
    paneRect,
  };
}

// Whether a screen point lies within a window's outer frame.
export function pointInWindow(
  screenX: number,
  screenY: number,
  w: { screenX: number; screenY: number; outerWidth: number; outerHeight: number },
): boolean {
  return screenX >= w.screenX && screenX < w.screenX + w.outerWidth && screenY >= w.screenY && screenY < w.screenY + w.outerHeight;
}

// ---- Cross-window messages --------------------------------------------------

export const CHANNEL_NAME = "perch-windows";

export type DetachedMessage =
  // main -> all: every detached window replies with window-tabs (after a
  // main-window reload, which loses the registry).
  | { type: "hello" }
  // detached -> all: on load, on every tabs/active change, and in reply to hello.
  | { type: "window-tabs"; windowId: string; tabs: Tab[]; activeTabId: string | null }
  // detached -> all: from pagehide; a reload sends window-tabs again shortly after.
  | { type: "window-closing"; windowId: string }
  // main -> one detached window: activate and raise.
  | { type: "focus-tab"; windowId: string; tabId: string }
  | { type: "focus-result"; windowId: string; tabId: string; ok: boolean }
  // Drag protocol (plans/cross-window-tab-drag.md). target -> all: it
  // adopted these tabs from the drag; the source removes exactly those.
  | { type: "tab-taken"; dragId: string; tabIds: string[] }
  // source -> all, from dragend: where the drag was released.
  | { type: "drag-ended"; dragId: string; screenX: number; screenY: number }
  // any window -> all: the release point lies within my frame (so the
  // source treats an unaccepted release there as a cancel, not a tear-off).
  | { type: "drag-ended-here"; dragId: string };

export function openChannel(): BroadcastChannel | null {
  return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL_NAME);
}

export interface DetachedEntry {
  tabs: Tab[];
  activeTabId: string | null;
}

export type DetachedRegistry = Record<string, DetachedEntry>;

export function applyWindowTabs(
  registry: DetachedRegistry,
  msg: { windowId: string; tabs: Tab[]; activeTabId: string | null },
): DetachedRegistry {
  return { ...registry, [msg.windowId]: { tabs: msg.tabs, activeTabId: msg.activeTabId } };
}

export function removeWindow(registry: DetachedRegistry, windowId: string): DetachedRegistry {
  if (!(windowId in registry)) return registry;
  const next = { ...registry };
  delete next[windowId];
  return next;
}

// The first detached window holding a tab the matcher accepts.
export function holderOf(
  registry: DetachedRegistry,
  match: (tab: Tab) => boolean,
): { windowId: string; tabId: string } | null {
  for (const [windowId, entry] of Object.entries(registry)) {
    const tab = entry.tabs.find(match);
    if (tab) return { windowId, tabId: tab.id };
  }
  return null;
}

// ---- Finding the main window from a detached one -----------------------------

// The main window keeps a WindowProxy per detached window so it can read
// `closed` (the one exact close signal) and call focus(). Those handles are
// plain JS variables and die when the main window reloads, so a detached
// window hands its own handle back by calling straight into its opener -
// same origin, so a direct call is allowed - whenever the main window says
// hello. A detached window opened from another detached window walks the
// opener chain up to the main one.
export interface DetachedRegistrar {
  register(windowId: string, handle: Window): void;
}

declare global {
  interface Window {
    __perchDetached?: DetachedRegistrar;
  }
}

export function findMainWindow(from: Window): Window | null {
  let w: Window | null = from.opener as Window | null;
  for (let hops = 0; w && hops < 8; hops++) {
    try {
      if (w.closed) return null;
      const detached = new URLSearchParams(w.location.search).get("detached");
      if (!detached) return w;
      w = w.opener as Window | null;
    } catch {
      return null;
    }
  }
  return null;
}

// ---- Opening the window -----------------------------------------------------

export function detachedWindowUrl(windowId: string, handoff: Handoff): string {
  return `${location.pathname}?detached=${windowId}#${HANDOFF_PARAM}=${encodeHandoff(handoff)}`;
}

export interface WindowGeometry {
  width: number;
  height: number;
  left: number;
  top: number;
}

const MIN_WIDTH = 640;
const MIN_HEIGHT = 400;
const OFFSET = 40;

// Sized like the source editor group's content area, never smaller than a
// usable terminal, and offset from it so the two windows don't stack exactly.
export function detachedWindowGeometry(
  rect: { width: number; height: number; left: number; top: number } | null,
  screen: { x: number; y: number } = { x: 0, y: 0 },
): WindowGeometry {
  return {
    width: Math.max(MIN_WIDTH, Math.round(rect?.width ?? 0)),
    height: Math.max(MIN_HEIGHT, Math.round(rect?.height ?? 0)),
    left: Math.round(screen.x + (rect?.left ?? 0) + OFFSET),
    top: Math.round(screen.y + (rect?.top ?? 0) + OFFSET),
  };
}

// A tear-off window at a release point: sized like the source pane, placed
// so the dropped tab sits roughly under the pointer.
export function detachedWindowGeometryAt(
  point: { screenX: number; screenY: number },
  size: { width: number; height: number },
): WindowGeometry {
  return {
    width: Math.max(MIN_WIDTH, Math.round(size.width)),
    height: Math.max(MIN_HEIGHT, Math.round(size.height)),
    left: Math.max(0, Math.round(point.screenX - OFFSET)),
    top: Math.max(0, Math.round(point.screenY - OFFSET)),
  };
}

export function detachedWindowFeatures(g: WindowGeometry): string {
  return `popup=yes,width=${g.width},height=${g.height},left=${g.left},top=${g.top}`;
}

import { describe, expect, it } from "vitest";
import type { Tab } from "../types";
import {
  applyWindowTabs,
  decodeDragPayload,
  decodeHandoff,
  detachedWindowGeometry,
  detachedWindowGeometryAt,
  encodeDragPayload,
  encodeHandoff,
  holderOf,
  pointInWindow,
  removeWindow,
  seedDetachedStorage,
} from "./detachedWindows";

const terminal: Tab = { id: "t1", sessionName: "perch", attachName: "@w1", windowIndex: 1, groupId: "g9" };
const viewer: Tab = {
  id: "t2",
  sessionName: "",
  attachName: "",
  groupId: "g9",
  extViewerId: "markdown",
  extViewerPath: "/works/perch/docs/ghi chú.md",
};

function memoryStorage(): Storage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    get length() {
      return Object.keys(data).length;
    },
    clear: () => {
      for (const k of Object.keys(data)) delete data[k];
    },
    getItem: (k) => (k in data ? data[k] : null),
    key: (i) => Object.keys(data)[i] ?? null,
    removeItem: (k) => {
      delete data[k];
    },
    setItem: (k, v) => {
      data[k] = String(v);
    },
  };
}

describe("handoff encoding", () => {
  it("round-trips tabs with non-ASCII paths", () => {
    const encoded = encodeHandoff({ tabs: [terminal, viewer], activeTabId: "t2" });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeHandoff(encoded)).toEqual({ tabs: [terminal, viewer], activeTabId: "t2" });
  });

  it("rejects garbage and wrong shapes", () => {
    expect(decodeHandoff("not base64 ***")).toBeNull();
    expect(decodeHandoff(btoa("42"))).toBeNull();
    expect(decodeHandoff(btoa(JSON.stringify({ tabs: "nope" })))).toBeNull();
    expect(decodeHandoff(btoa(JSON.stringify({ tabs: [{ noId: true }] })))).toBeNull();
    expect(decodeHandoff(btoa(JSON.stringify({ tabs: [] })))).toEqual({ tabs: [], activeTabId: null });
  });
});

describe("seedDetachedStorage", () => {
  it("writes the three tab keys with every tab in the root leaf", () => {
    const storage = memoryStorage();
    seedDetachedStorage({ tabs: [terminal, viewer], activeTabId: "t2" }, storage);
    const tabs = JSON.parse(storage.data.tabs) as Tab[];
    expect(tabs.map((t) => t.groupId)).toEqual(["root", "root"]);
    expect(tabs.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(JSON.parse(storage.data.splitLayout)).toEqual({
      tree: { type: "leaf", groupId: "root" },
      groupActive: { root: "t2" },
      activeGroupId: "root",
    });
    expect(JSON.parse(storage.data.tabGroupState)).toEqual({});
  });

  it("falls back to the first tab when the active id is not among the tabs", () => {
    const storage = memoryStorage();
    seedDetachedStorage({ tabs: [terminal], activeTabId: "missing" }, storage);
    expect(JSON.parse(storage.data.splitLayout).groupActive).toEqual({ root: "t1" });
  });
});

describe("registry", () => {
  it("upserts, removes and finds holders", () => {
    let reg = applyWindowTabs({}, { windowId: "w1", tabs: [terminal], activeTabId: "t1" });
    reg = applyWindowTabs(reg, { windowId: "w2", tabs: [viewer], activeTabId: "t2" });
    reg = applyWindowTabs(reg, { windowId: "w1", tabs: [terminal, viewer], activeTabId: "t2" });
    expect(Object.keys(reg)).toEqual(["w1", "w2"]);
    expect(reg.w1.tabs).toHaveLength(2);
    expect(holderOf(reg, (t) => t.extViewerPath === viewer.extViewerPath)).toEqual({ windowId: "w1", tabId: "t2" });
    expect(holderOf(reg, (t) => t.sessionName === "other")).toBeNull();
    const removed = removeWindow(reg, "w1");
    expect(Object.keys(removed)).toEqual(["w2"]);
    expect(removeWindow(removed, "nope")).toBe(removed);
  });
});

describe("detachedWindowGeometry", () => {
  it("clamps to the minimum size and offsets from the source pane", () => {
    expect(detachedWindowGeometry({ width: 300, height: 200, left: 10, top: 20 }, { x: 100, y: 50 })).toEqual({
      width: 640,
      height: 400,
      left: 150,
      top: 110,
    });
    expect(detachedWindowGeometry({ width: 1000.4, height: 700.6, left: 0, top: 0 })).toEqual({
      width: 1000,
      height: 701,
      left: 40,
      top: 40,
    });
    expect(detachedWindowGeometry(null)).toEqual({ width: 640, height: 400, left: 40, top: 40 });
  });
});

describe("drag payload", () => {
  it("round-trips and rejects wrong shapes", () => {
    const payload = {
      dragId: "d1",
      windowId: "w1",
      kind: "chip" as const,
      tabs: [terminal, viewer],
      groupKey: "/works/perch",
      paneRect: { width: 800, height: 500 },
    };
    expect(decodeDragPayload(encodeDragPayload(payload))).toEqual(payload);
    expect(decodeDragPayload("nope")).toBeNull();
    expect(decodeDragPayload(JSON.stringify({ dragId: "d", windowId: "w", kind: "tab", tabs: "x" }))).toBeNull();
    expect(decodeDragPayload(JSON.stringify({ dragId: "d", windowId: "w", kind: "pane", tabs: [] }))).toBeNull();
    expect(decodeDragPayload(JSON.stringify({ dragId: "d", windowId: "w", kind: "tab", tabs: [terminal] }))).toEqual({
      dragId: "d",
      windowId: "w",
      kind: "tab",
      tabs: [terminal],
      groupKey: undefined,
      paneRect: { width: 0, height: 0 },
    });
  });
});

describe("pointInWindow", () => {
  it("is inclusive at the origin and exclusive at the far edges", () => {
    const w = { screenX: 100, screenY: 50, outerWidth: 600, outerHeight: 400 };
    expect(pointInWindow(100, 50, w)).toBe(true);
    expect(pointInWindow(699, 449, w)).toBe(true);
    expect(pointInWindow(700, 449, w)).toBe(false);
    expect(pointInWindow(99, 100, w)).toBe(false);
  });
});

describe("detachedWindowGeometryAt", () => {
  it("clamps the size and offsets the point, never off-screen", () => {
    expect(detachedWindowGeometryAt({ screenX: 1000, screenY: 300 }, { width: 300, height: 200 })).toEqual({
      width: 640,
      height: 400,
      left: 960,
      top: 260,
    });
    expect(detachedWindowGeometryAt({ screenX: 10, screenY: 10 }, { width: 900, height: 600 })).toEqual({
      width: 900,
      height: 600,
      left: 0,
      top: 0,
    });
  });
});

import { describe, expect, it } from "vitest";
import type { Tab, TerminalSession } from "../types";
import {
  groupKeyForTab,
  moveGroup,
  moveGroupWithin,
  moveId,
  normalizeTabGroups,
  normalizeWithinGroups,
  orderedGroupKeys,
  reconcileTabs,
  tabsAreDuplicates,
} from "./tabs";

function makeTab(overrides: Partial<Tab>): Tab {
  return { id: "id", sessionName: "session", attachName: "session", ...overrides };
}

function makeSession(overrides: Partial<TerminalSession>): TerminalSession {
  return { id: "$1", name: "session", created: 0, attached: 0, path: "~", windows: [], ...overrides };
}

describe("groupKeyForTab", () => {
  it("returns sessionName for a real (whole-session) tab", () => {
    expect(groupKeyForTab(makeTab({ sessionName: "blog" }))).toBe("blog");
  });

  it("returns sessionName for a real window-tab", () => {
    expect(groupKeyForTab(makeTab({ sessionName: "blog", windowIndex: 1 }))).toBe("blog");
  });

  it("returns originSessionName for a viewer tab with an origin", () => {
    const tab = makeTab({
      sessionName: "",
      attachName: "",
      extViewerId: "image",
      extViewerPath: "/a.png",
      originSessionName: "blog",
    });
    expect(groupKeyForTab(tab)).toBe("blog");
  });

  it("returns null for a viewer tab with no origin", () => {
    const tab = makeTab({
      sessionName: "",
      attachName: "",
      extViewerId: "image",
      extViewerPath: "/a.png",
    });
    expect(groupKeyForTab(tab)).toBeNull();
  });

  it("returns null for the settings tab", () => {
    const tab = makeTab({ sessionName: "", attachName: "", settingsView: true });
    expect(groupKeyForTab(tab)).toBeNull();
  });

  it("maps through a session-key resolver (project-path grouping)", () => {
    const key = (name: string) => (name.startsWith("app") ? "~/works/app" : name);
    expect(groupKeyForTab(makeTab({ sessionName: "app" }), key)).toBe("~/works/app");
    expect(groupKeyForTab(makeTab({ sessionName: "app-2", windowIndex: 0 }), key)).toBe("~/works/app");
    const viewer = makeTab({
      sessionName: "",
      attachName: "",
      extViewerId: "image",
      extViewerPath: "/a.png",
      originSessionName: "app",
    });
    expect(groupKeyForTab(viewer, key)).toBe("~/works/app");
  });
});

describe("normalizeTabGroups with a session-key resolver", () => {
  it("collapses two sessions sharing a path into one contiguous block", () => {
    const key = (name: string) => (name.startsWith("app") ? "~/works/app" : name);
    const tabs = [
      makeTab({ id: "a1", sessionName: "app" }),
      makeTab({ id: "o1", sessionName: "other" }),
      makeTab({ id: "a2", sessionName: "app-2" }),
    ];
    const normalized = normalizeTabGroups(tabs, key);
    expect(normalized.map((t) => t.id)).toEqual(["a1", "a2", "o1"]);
    expect(orderedGroupKeys(normalized, key)).toEqual(["~/works/app", "other"]);
  });
});

describe("normalizeTabGroups", () => {
  it("keeps an already-normalized order unchanged (same reference)", () => {
    const tabs = [
      makeTab({ id: "1", sessionName: "a" }),
      makeTab({ id: "2", sessionName: "a", windowIndex: 0 }),
      makeTab({ id: "3", sessionName: "b" }),
      makeTab({ id: "4", sessionName: "", attachName: "", settingsView: true }),
    ];
    expect(normalizeTabGroups(tabs)).toBe(tabs);
  });

  it("makes interleaved same-session tabs contiguous, anchored at the first occurrence", () => {
    const tabs = [
      makeTab({ id: "1", sessionName: "a" }),
      makeTab({ id: "2", sessionName: "b" }),
      makeTab({ id: "3", sessionName: "a", windowIndex: 0 }),
    ];
    const next = normalizeTabGroups(tabs);
    expect(next.map((t) => t.id)).toEqual(["1", "3", "2"]);
  });

  it("pushes every ungrouped tab after all groups, preserving their relative order", () => {
    const tabs = [
      makeTab({ id: "settings", sessionName: "", attachName: "", settingsView: true }),
      makeTab({ id: "a1", sessionName: "a" }),
      makeTab({ id: "orphan", sessionName: "", attachName: "", extViewerId: "image", extViewerPath: "/x.png" }),
      makeTab({ id: "b1", sessionName: "b" }),
      makeTab({ id: "a2", sessionName: "a", windowIndex: 0 }),
    ];
    const next = normalizeTabGroups(tabs);
    expect(next.map((t) => t.id)).toEqual(["a1", "a2", "b1", "settings", "orphan"]);
  });
});

describe("orderedGroupKeys", () => {
  it("returns distinct group keys in first-appearance order, excluding singletons", () => {
    const tabs = [
      makeTab({ id: "settings", sessionName: "", attachName: "", settingsView: true }),
      makeTab({ id: "b1", sessionName: "b" }),
      makeTab({ id: "a1", sessionName: "a" }),
      makeTab({ id: "b2", sessionName: "b", windowIndex: 0 }),
    ];
    expect(orderedGroupKeys(tabs)).toEqual(["b", "a"]);
  });

  it("returns an empty array when every tab is ungrouped", () => {
    const tabs = [makeTab({ id: "settings", sessionName: "", attachName: "", settingsView: true })];
    expect(orderedGroupKeys(tabs)).toEqual([]);
  });
});

describe("moveGroup", () => {
  function groupedTabs() {
    return [
      makeTab({ id: "a1", sessionName: "a" }),
      makeTab({ id: "a2", sessionName: "a", windowIndex: 0 }),
      makeTab({ id: "b1", sessionName: "b" }),
      makeTab({ id: "c1", sessionName: "c" }),
      makeTab({ id: "settings", sessionName: "", attachName: "", settingsView: true }),
    ];
  }

  it("moves a group earlier, keeping its own tabs' relative order and singletons trailing", () => {
    const next = moveGroup(groupedTabs(), "c", 0);
    expect(next.map((t) => t.id)).toEqual(["c1", "a1", "a2", "b1", "settings"]);
  });

  it("moves a group later", () => {
    const next = moveGroup(groupedTabs(), "a", 2);
    expect(next.map((t) => t.id)).toEqual(["b1", "c1", "a1", "a2", "settings"]);
  });

  it("clamps an out-of-range target index to the end", () => {
    const next = moveGroup(groupedTabs(), "a", 99);
    expect(next.map((t) => t.id)).toEqual(["b1", "c1", "a1", "a2", "settings"]);
  });

  it("returns the same reference for an unknown group key", () => {
    const tabs = groupedTabs();
    expect(moveGroup(tabs, "nonexistent", 0)).toBe(tabs);
  });

  it("returns the same reference when the target index doesn't change anything", () => {
    const tabs = groupedTabs();
    expect(moveGroup(tabs, "a", 0)).toBe(tabs);
  });

  it("reorders a collapsed group identically to an expanded one — moveGroup never reads collapse state", () => {
    // tabGroupState (color/collapsed) lives in useTabGroups, entirely
    // separate from the Tab[] moveGroup operates on — collapsing a group
    // has no representation here at all, so this just re-asserts the
    // "moves earlier" case with a differently-named group standing in for
    // "the one that happens to be collapsed" to document that intent.
    const next = moveGroup(groupedTabs(), "b", 0);
    expect(next.map((t) => t.id)).toEqual(["b1", "a1", "a2", "c1", "settings"]);
  });
});

describe("moveId", () => {
  it("moves an id earlier", () => {
    expect(moveId(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
  });

  it("moves an id later", () => {
    expect(moveId(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
  });

  it("clamps an out-of-range target index to the end", () => {
    expect(moveId(["a", "b", "c"], "a", 99)).toEqual(["b", "c", "a"]);
  });

  it("returns the same reference for an unknown id", () => {
    const order = ["a", "b", "c"];
    expect(moveId(order, "nonexistent", 0)).toBe(order);
  });

  it("returns the same reference when the target index doesn't change anything", () => {
    const order = ["a", "b", "c"];
    expect(moveId(order, "a", 0)).toBe(order);
  });
});

describe("normalizeWithinGroups", () => {
  it("normalizes each editor group's session contiguity independently, leaving other groups untouched", () => {
    const tabs = [
      makeTab({ id: "g1-a1", sessionName: "a", groupId: "g1" }),
      makeTab({ id: "g2-b1", sessionName: "b", groupId: "g2" }),
      makeTab({ id: "g1-c1", sessionName: "c", groupId: "g1" }),
      makeTab({ id: "g1-a2", sessionName: "a", windowIndex: 0, groupId: "g1" }),
      makeTab({ id: "g2-a1", sessionName: "a", groupId: "g2" }),
    ];
    const next = normalizeWithinGroups(tabs);
    // g1's subsequence (a1, c1, a2) becomes contiguous by session (a1, a2, c1);
    // g2's subsequence (b1, a1) is already contiguous and untouched — and no
    // tab ever crosses from one groupId to another.
    expect(next.map((t) => t.id)).toEqual(["g1-a1", "g2-b1", "g1-a2", "g1-c1", "g2-a1"]);
    expect(next.every((t) => tabs.find((o) => o.id === t.id)!.groupId === t.groupId)).toBe(true);
  });

  it("returns the same reference when every group is already normalized", () => {
    const tabs = [
      makeTab({ id: "1", sessionName: "a", groupId: "g1" }),
      makeTab({ id: "2", sessionName: "b", groupId: "g2" }),
    ];
    expect(normalizeWithinGroups(tabs)).toBe(tabs);
  });
});

describe("moveGroupWithin", () => {
  it("reorders a session chip only within its own editor group", () => {
    const tabs = [
      makeTab({ id: "g1-a1", sessionName: "a", groupId: "g1" }),
      makeTab({ id: "g1-b1", sessionName: "b", groupId: "g1" }),
      makeTab({ id: "g2-a1", sessionName: "a", groupId: "g2" }),
      makeTab({ id: "g2-b1", sessionName: "b", groupId: "g2" }),
    ];
    const next = moveGroupWithin(tabs, "g1", "b", 0);
    expect(next.map((t) => t.id)).toEqual(["g1-b1", "g1-a1", "g2-a1", "g2-b1"]);
  });

  it("returns the same reference for a no-op move", () => {
    const tabs = [
      makeTab({ id: "1", sessionName: "a", groupId: "g1" }),
      makeTab({ id: "2", sessionName: "b", groupId: "g1" }),
    ];
    expect(moveGroupWithin(tabs, "g1", "a", 0)).toBe(tabs);
  });
});

describe("reconcileTabs", () => {
  it("returns the same reference when nothing changed", () => {
    const tabs = [makeTab({ id: "1", sessionId: "$1", sessionName: "blog" })];
    const sessions = [makeSession({ id: "$1", name: "blog" })];
    expect(reconcileTabs(tabs, sessions)).toBe(tabs);
  });

  it("adopts a rename detected via stable session id", () => {
    const tabs = [makeTab({ id: "1", sessionId: "$1", sessionName: "blog", attachName: "blog" })];
    const sessions = [makeSession({ id: "$1", name: "blog-renamed" })];
    const next = reconcileTabs(tabs, sessions);
    expect(next[0].sessionName).toBe("blog-renamed");
    expect(next[0].attachName).toBe("blog-renamed");
  });

  it("does not follow a base-session rename for a window-tab's synthetic attachName", () => {
    const tabs = [
      makeTab({
        id: "1",
        sessionId: "$1",
        sessionName: "blog",
        attachName: "blog__win1",
        windowIndex: 1,
        windowId: "@1",
      }),
    ];
    const sessions = [
      makeSession({
        id: "$1",
        name: "blog-renamed",
        windows: [{ id: "@1", index: 1, name: "vim", active: true, cwd: "/tmp", activity: false, command: "vim" }],
      }),
    ];
    const next = reconcileTabs(tabs, sessions);
    expect(next[0].sessionName).toBe("blog-renamed");
    expect(next[0].attachName).toBe("blog__win1");
  });

  it("adopts a window renumber via stable window id", () => {
    const tabs = [
      makeTab({ id: "1", sessionId: "$1", sessionName: "blog", windowIndex: 1, windowId: "@1" }),
    ];
    const sessions = [
      makeSession({
        id: "$1",
        name: "blog",
        windows: [{ id: "@1", index: 3, name: "vim", active: true, cwd: "/tmp", activity: false, command: "vim" }],
      }),
    ];
    const next = reconcileTabs(tabs, sessions);
    expect(next[0].windowIndex).toBe(3);
  });

  it("leaves a tab untouched when its session no longer exists", () => {
    const tabs = [makeTab({ id: "1", sessionId: "$1", sessionName: "blog" })];
    const next = reconcileTabs(tabs, []);
    expect(next).toBe(tabs);
  });
});

describe("tabsAreDuplicates", () => {
  it("matches two whole-session tabs for the same session", () => {
    const a = makeTab({ id: "1", sessionName: "blog" });
    const b = makeTab({ id: "2", sessionName: "blog" });
    expect(tabsAreDuplicates(a, b)).toBe(true);
  });

  it("does not match whole-session and window tabs for the same session", () => {
    const whole = makeTab({ id: "1", sessionName: "blog" });
    const windowTab = makeTab({ id: "2", sessionName: "blog", windowIndex: 0 });
    expect(tabsAreDuplicates(whole, windowTab)).toBe(false);
  });

  it("matches two window tabs for the same session and window index", () => {
    const a = makeTab({ id: "1", sessionName: "blog", windowIndex: 2 });
    const b = makeTab({ id: "2", sessionName: "blog", windowIndex: 2 });
    expect(tabsAreDuplicates(a, b)).toBe(true);
  });

  it("does not match window tabs with different indices", () => {
    const a = makeTab({ id: "1", sessionName: "blog", windowIndex: 1 });
    const b = makeTab({ id: "2", sessionName: "blog", windowIndex: 2 });
    expect(tabsAreDuplicates(a, b)).toBe(false);
  });

  it("does not match real tabs for different sessions", () => {
    const a = makeTab({ id: "1", sessionName: "blog" });
    const b = makeTab({ id: "2", sessionName: "docs" });
    expect(tabsAreDuplicates(a, b)).toBe(false);
  });

  it("matches two viewer tabs for the same extension and path", () => {
    const a = makeTab({ id: "1", sessionName: "", attachName: "", extViewerId: "csv-preview", extViewerPath: "/a.csv" });
    const b = makeTab({ id: "2", sessionName: "", attachName: "", extViewerId: "csv-preview", extViewerPath: "/a.csv" });
    expect(tabsAreDuplicates(a, b)).toBe(true);
  });

  it("does not match viewer tabs for different paths or viewers", () => {
    const csvA = makeTab({ id: "1", sessionName: "", attachName: "", extViewerId: "csv-preview", extViewerPath: "/a.csv" });
    const csvB = makeTab({ id: "2", sessionName: "", attachName: "", extViewerId: "csv-preview", extViewerPath: "/b.csv" });
    expect(tabsAreDuplicates(csvA, csvB)).toBe(false);
    const jsonA = makeTab({ id: "3", sessionName: "", attachName: "", extViewerId: "json-viewer", extViewerPath: "/a.csv" });
    expect(tabsAreDuplicates(csvA, jsonA)).toBe(false);
  });

  it("matches two settings tabs regardless of other fields", () => {
    const a = makeTab({ id: "1", sessionName: "", attachName: "", settingsView: true });
    const b = makeTab({ id: "2", sessionName: "", attachName: "", settingsView: true });
    expect(tabsAreDuplicates(a, b)).toBe(true);
  });

  it("does not match a settings tab against a real or viewer tab", () => {
    const settings = makeTab({ id: "1", sessionName: "", attachName: "", settingsView: true });
    const real = makeTab({ id: "2", sessionName: "blog" });
    expect(tabsAreDuplicates(settings, real)).toBe(false);
  });
});

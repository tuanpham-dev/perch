import { describe, expect, it } from "vitest";
import {
  EMPTY_STATUS_BAR_LAYOUT,
  moveStatusBarItem,
  parseStatusBarLayout,
  resolveStatusBarLayout,
  sideOfItem,
  toggleStatusBarItemHidden,
  type StatusBarLayout,
  type StatusBarSlot,
} from "./statusBarLayout";

const slots: StatusBarSlot[] = [
  { id: "ext.ports", defaultSide: "right" },
  { id: "core.memory", defaultSide: "right" },
  { id: "core.terminals", defaultSide: "right" },
];

// A stored layout from the two groups, with nothing hidden.
const stored = (left: string[], right: string[], hidden: string[] = []): StatusBarLayout => ({
  left,
  right,
  hidden,
});

describe("resolveStatusBarLayout", () => {
  it("falls back to registration order in each item's default group", () => {
    expect(resolveStatusBarLayout(slots, EMPTY_STATUS_BAR_LAYOUT)).toEqual({
      left: [],
      right: ["ext.ports", "core.memory", "core.terminals"],
    });
  });

  it("honors a stored order and a stored group", () => {
    const resolved = resolveStatusBarLayout(slots, stored(["core.terminals"], ["core.memory", "ext.ports"]));
    expect(resolved).toEqual({ left: ["core.terminals"], right: ["core.memory", "ext.ports"] });
  });

  it("appends an item the user has never arranged", () => {
    const resolved = resolveStatusBarLayout(slots, stored([], ["core.terminals"]));
    expect(resolved.right).toEqual(["core.terminals", "ext.ports", "core.memory"]);
  });

  it("drops an id with no live item without touching storage", () => {
    const resolved = resolveStatusBarLayout(slots, stored(["ext.gone"], ["core.memory"]));
    expect(resolved.left).toEqual([]);
    expect(resolved.right[0]).toBe("core.memory");
  });

  it("keeps an id that appears twice only once", () => {
    const resolved = resolveStatusBarLayout(slots, stored(["core.memory"], ["core.memory", "core.terminals"]));
    expect(resolved.left).toEqual(["core.memory"]);
    expect(resolved.right).not.toContain("core.memory");
  });
});

describe("toggleStatusBarItemHidden", () => {
  it("switches an item off and back on", () => {
    const off = toggleStatusBarItemHidden(EMPTY_STATUS_BAR_LAYOUT, "ext.ports");
    expect(off.hidden).toEqual(["ext.ports"]);
    expect(toggleStatusBarItemHidden(off, "ext.ports").hidden).toEqual([]);
  });

  it("leaves both groups alone", () => {
    const layout = stored(["core.terminals"], ["ext.ports"]);
    const off = toggleStatusBarItemHidden(layout, "core.terminals");
    expect(off.left).toEqual(["core.terminals"]);
    expect(off.right).toEqual(["ext.ports"]);
  });
});

describe("sideOfItem", () => {
  it("reports the group holding an id, or null", () => {
    const layout = stored(["a"], ["b"]);
    expect(sideOfItem(layout, "a")).toBe("left");
    expect(sideOfItem(layout, "b")).toBe("right");
    expect(sideOfItem(layout, "c")).toBe(null);
  });
});

describe("moveStatusBarItem", () => {
  const resolved = { left: [], right: ["ext.ports", "core.memory", "core.terminals"] };

  it("reorders within a group", () => {
    const next = moveStatusBarItem(EMPTY_STATUS_BAR_LAYOUT, resolved, "core.terminals", "right", 0);
    expect(next.right).toEqual(["core.terminals", "ext.ports", "core.memory"]);
  });

  it("moves an item to the other group", () => {
    const next = moveStatusBarItem(EMPTY_STATUS_BAR_LAYOUT, resolved, "ext.ports", "left", 0);
    expect(next.left).toEqual(["ext.ports"]);
    expect(next.right).toEqual(["core.memory", "core.terminals"]);
  });

  it("clamps an out-of-range index", () => {
    const next = moveStatusBarItem(EMPTY_STATUS_BAR_LAYOUT, resolved, "ext.ports", "right", 99);
    expect(next.right).toEqual(["core.memory", "core.terminals", "ext.ports"]);
  });

  it("never duplicates the moved id", () => {
    const next = moveStatusBarItem(EMPTY_STATUS_BAR_LAYOUT, resolved, "core.memory", "right", 2);
    expect(next.right.filter((id) => id === "core.memory")).toHaveLength(1);
  });

  it("preserves a stored id that isn't rendered right now", () => {
    const layout = stored([], ["ext.disabled", "ext.ports", "core.memory", "core.terminals"]);
    const next = moveStatusBarItem(layout, resolved, "core.terminals", "right", 0);
    expect(next.right).toContain("ext.disabled");
    expect(next.right[next.right.length - 1]).not.toBe("ext.disabled");
  });

  it("carries the hidden set through a drag", () => {
    const layout = stored([], ["ext.ports", "core.memory", "core.terminals"], ["core.memory"]);
    expect(moveStatusBarItem(layout, resolved, "ext.ports", "left", 0).hidden).toEqual(["core.memory"]);
  });

  it("returns a hidden item to its own place once it comes back", () => {
    // core.memory is switched off, so the bar resolves without its slot.
    const live = slots.filter((s) => s.id !== "core.memory");
    const layout = stored([], ["ext.ports", "core.memory", "core.terminals"], ["core.memory"]);
    const shown = resolveStatusBarLayout(live, layout);
    expect(shown.right).toEqual(["ext.ports", "core.terminals"]);

    // A drag among what's left must not disturb the id sitting in storage:
    // it stays at the stored index it had, neither dropped nor pushed to the
    // end.
    const dragged = moveStatusBarItem(layout, shown, "ext.ports", "right", 1);
    expect(dragged.right).toEqual(["core.terminals", "core.memory", "ext.ports"]);

    // Switched back on, it renders in that same place.
    const back = toggleStatusBarItemHidden(dragged, "core.memory");
    expect(back.hidden).toEqual([]);
    expect(resolveStatusBarLayout(slots, back).right).toEqual([
      "core.terminals",
      "core.memory",
      "ext.ports",
    ]);
  });
});

describe("parseStatusBarLayout", () => {
  it("round-trips a stored layout", () => {
    const stored = { left: ["ext.git"], right: ["core.terminals"], hidden: ["ext.ports"] };
    expect(parseStatusBarLayout(stored)).toEqual(stored);
  });

  it("rejects anything that is not a plain object", () => {
    expect(parseStatusBarLayout(null)).toBeNull();
    expect(parseStatusBarLayout("left")).toBeNull();
    expect(parseStatusBarLayout(["ext.git"])).toBeNull();
    expect(parseStatusBarLayout(undefined)).toBeNull();
  });

  // Null, not an empty layout: the caller has to be able to tell "never
  // arranged" (keep my defaults) from "arranged into nothing".
  it("returns null when there is nothing to restore", () => {
    expect(parseStatusBarLayout({})).toBeNull();
    expect(parseStatusBarLayout({ left: [], right: [], hidden: [] })).toBeNull();
  });

  it("drops entries that are not non-empty strings", () => {
    const parsed = parseStatusBarLayout({
      left: ["ext.git", 7, null, "", { id: "x" }],
      right: "core.terminals",
      hidden: [true, "ext.ports"],
    });
    expect(parsed).toEqual({ left: ["ext.git"], right: [], hidden: ["ext.ports"] });
  });
});

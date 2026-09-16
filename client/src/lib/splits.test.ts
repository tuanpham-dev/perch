import { describe, expect, it } from "vitest";
import {
  leafRects,
  leaves,
  parseStoredTree,
  removeLeaf,
  setBranchSizes,
  splitLeaf,
  type SplitNode,
} from "./splits";

function leaf(groupId: string): SplitNode {
  return { type: "leaf", groupId };
}

describe("splitLeaf", () => {
  it("splits a lone root leaf right into a 2-child row branch, new leaf after", () => {
    const tree = splitLeaf(leaf("a"), "a", "right", "b");
    expect(tree).toEqual({
      type: "branch",
      orientation: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [1, 1],
    });
  });

  it("splits left, new leaf before", () => {
    const tree = splitLeaf(leaf("a"), "a", "left", "b");
    expect(tree).toEqual({
      type: "branch",
      orientation: "row",
      children: [leaf("b"), leaf("a")],
      sizes: [1, 1],
    });
  });

  it("splits down into a column branch, new leaf after", () => {
    const tree = splitLeaf(leaf("a"), "a", "down", "b");
    expect(tree).toEqual({
      type: "branch",
      orientation: "column",
      children: [leaf("a"), leaf("b")],
      sizes: [1, 1],
    });
  });

  it("splits up into a column branch, new leaf before", () => {
    const tree = splitLeaf(leaf("a"), "a", "up", "b");
    expect(tree).toEqual({
      type: "branch",
      orientation: "column",
      children: [leaf("b"), leaf("a")],
      sizes: [1, 1],
    });
  });

  it("inserts as a direct sibling when the parent already matches orientation", () => {
    const row: SplitNode = {
      type: "branch",
      orientation: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [2, 2],
    };
    const next = splitLeaf(row, "b", "right", "c");
    expect(next).toEqual({
      type: "branch",
      orientation: "row",
      children: [leaf("a"), leaf("b"), leaf("c")],
      sizes: [2, 1, 1],
    });
  });

  it("nests a new branch when the parent orientation doesn't match", () => {
    const row: SplitNode = {
      type: "branch",
      orientation: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [1, 1],
    };
    const next = splitLeaf(row, "b", "down", "c");
    expect(next).toEqual({
      type: "branch",
      orientation: "row",
      children: [
        leaf("a"),
        { type: "branch", orientation: "column", children: [leaf("b"), leaf("c")], sizes: [1, 1] },
      ],
      sizes: [1, 1],
    });
  });

  it("returns the same reference when groupId isn't found", () => {
    const tree = leaf("a");
    expect(splitLeaf(tree, "missing", "right", "b")).toBe(tree);
  });
});

describe("removeLeaf", () => {
  it("collapses a 2-child branch down to the remaining leaf", () => {
    const tree: SplitNode = {
      type: "branch",
      orientation: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [1, 1],
    };
    expect(removeLeaf(tree, "b")).toEqual(leaf("a"));
  });

  it("hands the freed weight to the following sibling in a 3-child branch", () => {
    const tree: SplitNode = {
      type: "branch",
      orientation: "row",
      children: [leaf("a"), leaf("b"), leaf("c")],
      sizes: [1, 2, 3],
    };
    const next = removeLeaf(tree, "a");
    expect(next).toEqual({
      type: "branch",
      orientation: "row",
      children: [leaf("b"), leaf("c")],
      sizes: [3, 3],
    });
  });

  it("hands the freed weight to the preceding sibling when the last child is removed", () => {
    const tree: SplitNode = {
      type: "branch",
      orientation: "row",
      children: [leaf("a"), leaf("b"), leaf("c")],
      sizes: [1, 2, 3],
    };
    const next = removeLeaf(tree, "c");
    expect(next).toEqual({
      type: "branch",
      orientation: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [1, 5],
    });
  });

  it("collapses a nested branch into its parent when it drops to one child", () => {
    const tree: SplitNode = {
      type: "branch",
      orientation: "row",
      children: [
        leaf("a"),
        { type: "branch", orientation: "column", children: [leaf("b"), leaf("c")], sizes: [1, 1] },
      ],
      sizes: [1, 1],
    };
    const next = removeLeaf(tree, "c");
    expect(next).toEqual({
      type: "branch",
      orientation: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [1, 1],
    });
  });

  it("is a no-op (same reference) for the tree's sole leaf", () => {
    const tree = leaf("a");
    expect(removeLeaf(tree, "a")).toBe(tree);
  });

  it("is a no-op (same reference) for an unknown groupId", () => {
    const tree: SplitNode = {
      type: "branch",
      orientation: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [1, 1],
    };
    expect(removeLeaf(tree, "missing")).toBe(tree);
  });
});

describe("leaves", () => {
  it("returns groupIds in document order for a nested tree", () => {
    const tree: SplitNode = {
      type: "branch",
      orientation: "row",
      children: [
        { type: "branch", orientation: "column", children: [leaf("a"), leaf("b")], sizes: [1, 1] },
        leaf("c"),
      ],
      sizes: [1, 1],
    };
    expect(leaves(tree)).toEqual(["a", "b", "c"]);
  });
});

describe("leafRects", () => {
  it("gives a lone leaf the full 0..1 rect", () => {
    expect(leafRects(leaf("a"))).toEqual({ a: { x: 0, y: 0, w: 1, h: 1 } });
  });

  it("splits an even row 50/50", () => {
    const tree: SplitNode = {
      type: "branch",
      orientation: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [1, 1],
    };
    const rects = leafRects(tree);
    expect(rects.a).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(rects.b).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  it("weights an uneven column split proportionally", () => {
    const tree: SplitNode = {
      type: "branch",
      orientation: "column",
      children: [leaf("a"), leaf("b")],
      sizes: [1, 3],
    };
    const rects = leafRects(tree);
    expect(rects.a).toEqual({ x: 0, y: 0, w: 1, h: 0.25 });
    expect(rects.b).toEqual({ x: 0, y: 0.25, w: 1, h: 0.75 });
  });

  it("covers the full area with no gaps or overlaps for a nested 2x2 grid", () => {
    const tree: SplitNode = {
      type: "branch",
      orientation: "row",
      children: [
        { type: "branch", orientation: "column", children: [leaf("a"), leaf("b")], sizes: [1, 1] },
        { type: "branch", orientation: "column", children: [leaf("c"), leaf("d")], sizes: [1, 1] },
      ],
      sizes: [1, 1],
    };
    const rects = leafRects(tree);
    const totalArea = Object.values(rects).reduce((sum, r) => sum + r.w * r.h, 0);
    expect(totalArea).toBeCloseTo(1);
    expect(rects.a).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(rects.b).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    expect(rects.c).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(rects.d).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });
});

describe("setBranchSizes", () => {
  it("overwrites the root branch's sizes", () => {
    const tree: SplitNode = {
      type: "branch",
      orientation: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [1, 1],
    };
    const next = setBranchSizes(tree, [], [3, 1]);
    expect(next).toEqual({ ...tree, sizes: [3, 1] });
  });

  it("overwrites a nested branch's sizes via its path", () => {
    const tree: SplitNode = {
      type: "branch",
      orientation: "row",
      children: [
        leaf("a"),
        { type: "branch", orientation: "column", children: [leaf("b"), leaf("c")], sizes: [1, 1] },
      ],
      sizes: [1, 1],
    };
    const next = setBranchSizes(tree, [1], [2, 5]);
    expect(next).toEqual({
      type: "branch",
      orientation: "row",
      children: [
        leaf("a"),
        { type: "branch", orientation: "column", children: [leaf("b"), leaf("c")], sizes: [2, 5] },
      ],
      sizes: [1, 1],
    });
  });

  it("returns the same reference for a sizes-length mismatch", () => {
    const tree: SplitNode = {
      type: "branch",
      orientation: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [1, 1],
    };
    expect(setBranchSizes(tree, [], [1, 2, 3])).toBe(tree);
  });

  it("returns the same reference for an out-of-range path", () => {
    const tree: SplitNode = {
      type: "branch",
      orientation: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [1, 1],
    };
    expect(setBranchSizes(tree, [5], [1, 1])).toBe(tree);
  });

  it("returns the same reference when the path runs into a leaf", () => {
    const tree = leaf("a");
    expect(setBranchSizes(tree, [0], [1, 1])).toBe(tree);
  });
});

describe("parseStoredTree", () => {
  it("accepts a valid lone leaf", () => {
    expect(parseStoredTree({ type: "leaf", groupId: "a" })).toEqual(leaf("a"));
  });

  it("accepts a valid nested branch", () => {
    const tree: SplitNode = {
      type: "branch",
      orientation: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [1, 1],
    };
    expect(parseStoredTree(tree)).toEqual(tree);
  });

  it("rejects null and non-objects", () => {
    expect(parseStoredTree(null)).toBeNull();
    expect(parseStoredTree("leaf")).toBeNull();
    expect(parseStoredTree(42)).toBeNull();
  });

  it("rejects a leaf with a missing or empty groupId", () => {
    expect(parseStoredTree({ type: "leaf" })).toBeNull();
    expect(parseStoredTree({ type: "leaf", groupId: "" })).toBeNull();
    expect(parseStoredTree({ type: "leaf", groupId: 5 })).toBeNull();
  });

  it("rejects a branch with an invalid orientation", () => {
    expect(
      parseStoredTree({
        type: "branch",
        orientation: "diagonal",
        children: [leaf("a"), leaf("b")],
        sizes: [1, 1],
      }),
    ).toBeNull();
  });

  it("rejects a branch with fewer than 2 children", () => {
    expect(
      parseStoredTree({ type: "branch", orientation: "row", children: [leaf("a")], sizes: [1] }),
    ).toBeNull();
  });

  it("rejects a sizes/children length mismatch", () => {
    expect(
      parseStoredTree({
        type: "branch",
        orientation: "row",
        children: [leaf("a"), leaf("b")],
        sizes: [1],
      }),
    ).toBeNull();
  });

  it("rejects a non-positive or non-finite size", () => {
    expect(
      parseStoredTree({
        type: "branch",
        orientation: "row",
        children: [leaf("a"), leaf("b")],
        sizes: [1, 0],
      }),
    ).toBeNull();
    expect(
      parseStoredTree({
        type: "branch",
        orientation: "row",
        children: [leaf("a"), leaf("b")],
        sizes: [1, Infinity],
      }),
    ).toBeNull();
  });

  it("rejects a malformed nested child", () => {
    expect(
      parseStoredTree({
        type: "branch",
        orientation: "row",
        children: [leaf("a"), { type: "leaf" }],
        sizes: [1, 1],
      }),
    ).toBeNull();
  });

  it("rejects an unknown type", () => {
    expect(parseStoredTree({ type: "grid" })).toBeNull();
  });
});

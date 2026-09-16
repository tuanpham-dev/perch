// Pure split-tree model for editor groups (plans/vscode-editor-group-splits.md).
// No React, no DOM — App/SplitLayout turn this into rects and event handlers.

export type Orientation = "row" | "column";
export type SplitDirection = "left" | "right" | "up" | "down";

export interface LeafNode {
  type: "leaf";
  groupId: string;
}

export interface BranchNode {
  type: "branch";
  orientation: Orientation;
  children: SplitNode[];
  // Flex weights, one per child — only their ratio matters, not the absolute
  // values (mirrors Sidebar.tsx's PanelState.sizes convention).
  sizes: number[];
}

export type SplitNode = LeafNode | BranchNode;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// A path of child indices from the root to a specific branch — how
// setBranchSizes below addresses a branch without nodes carrying their own
// identity.
export type SplitPath = number[];

function containsLeaf(node: SplitNode, groupId: string): boolean {
  if (node.type === "leaf") return node.groupId === groupId;
  return node.children.some((c) => containsLeaf(c, groupId));
}

function orientationForDirection(direction: SplitDirection): Orientation {
  return direction === "left" || direction === "right" ? "row" : "column";
}

function insertsBefore(direction: SplitDirection): boolean {
  return direction === "left" || direction === "up";
}

// Splits the leaf identified by `groupId`, inserting a new leaf for
// `newGroupId` on the side `direction` points to. If the leaf's immediate
// parent already has the matching orientation, the new leaf joins that
// branch directly as a sibling (taking half the split leaf's weight);
// otherwise the leaf is replaced by a fresh 2-child branch. Returns `tree`
// unchanged (same reference) if `groupId` isn't present anywhere in it.
export function splitLeaf(
  tree: SplitNode,
  groupId: string,
  direction: SplitDirection,
  newGroupId: string,
): SplitNode {
  const orientation = orientationForDirection(direction);
  const before = insertsBefore(direction);

  function insert(node: SplitNode): SplitNode {
    if (node.type === "leaf") {
      if (node.groupId !== groupId) return node;
      const newLeaf: LeafNode = { type: "leaf", groupId: newGroupId };
      const children = before ? [newLeaf, node] : [node, newLeaf];
      return { type: "branch", orientation, children, sizes: [1, 1] };
    }
    const idx = node.children.findIndex((c) => containsLeaf(c, groupId));
    if (idx === -1) return node;
    const child = node.children[idx];
    if (child.type === "leaf" && node.orientation === orientation) {
      const newLeaf: LeafNode = { type: "leaf", groupId: newGroupId };
      const half = node.sizes[idx] / 2;
      const insertAt = before ? idx : idx + 1;
      const children = [...node.children];
      const sizes = [...node.sizes];
      sizes[idx] = half;
      children.splice(insertAt, 0, newLeaf);
      sizes.splice(insertAt, 0, half);
      return { ...node, children, sizes };
    }
    const replacedChild = insert(child);
    const children = [...node.children];
    children[idx] = replacedChild;
    return { ...node, children };
  }

  return insert(tree);
}

// Removes the leaf identified by `groupId`. A branch left with one child
// collapses into that child directly; the freed weight is handed to the
// following sibling (or the preceding one, if the removed leaf was last).
// Removing the tree's sole leaf is a no-op (same reference) — callers must
// not call this for the last remaining group.
export function removeLeaf(tree: SplitNode, groupId: string): SplitNode {
  function remove(node: SplitNode): SplitNode | null {
    if (node.type === "leaf") {
      return node.groupId === groupId ? null : node;
    }
    const idx = node.children.findIndex((c) => containsLeaf(c, groupId));
    if (idx === -1) return node;
    const childResult = remove(node.children[idx]);
    if (childResult === null) {
      const remainingChildren = node.children.filter((_, i) => i !== idx);
      const remainingSizes = node.sizes.filter((_, i) => i !== idx);
      if (remainingChildren.length === 1) return remainingChildren[0];
      const freed = node.sizes[idx];
      const giveIdx = idx < remainingSizes.length ? idx : idx - 1;
      remainingSizes[giveIdx] += freed;
      return { ...node, children: remainingChildren, sizes: remainingSizes };
    }
    const children = [...node.children];
    children[idx] = childResult;
    return { ...node, children };
  }

  const result = remove(tree);
  return result ?? tree;
}

// Every leaf's groupId, in left-to-right / top-to-bottom document order.
export function leaves(node: SplitNode): string[] {
  if (node.type === "leaf") return [node.groupId];
  return node.children.flatMap(leaves);
}

// Every leaf's rectangle, in fractions (0..1) of the tree's overall bounds.
export function leafRects(tree: SplitNode): Record<string, Rect> {
  const result: Record<string, Rect> = {};

  function walk(node: SplitNode, rect: Rect) {
    if (node.type === "leaf") {
      result[node.groupId] = rect;
      return;
    }
    const total = node.sizes.reduce((a, b) => a + b, 0);
    let offset = 0;
    node.children.forEach((child, i) => {
      const fraction = total > 0 ? node.sizes[i] / total : 1 / node.children.length;
      const childRect: Rect =
        node.orientation === "row"
          ? { x: rect.x + offset * rect.w, y: rect.y, w: fraction * rect.w, h: rect.h }
          : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: fraction * rect.h };
      walk(child, childRect);
      offset += fraction;
    });
  }

  walk(tree, { x: 0, y: 0, w: 1, h: 1 });
  return result;
}

// Overwrites one branch's `sizes` (a sash drag), addressed by the sequence
// of child indices from the root. Returns `tree` unchanged (same reference)
// for an invalid path or a `sizes` length mismatch.
export function setBranchSizes(tree: SplitNode, path: SplitPath, sizes: number[]): SplitNode {
  if (path.length === 0) {
    if (tree.type !== "branch") return tree;
    if (sizes.length !== tree.children.length) return tree;
    return { ...tree, sizes };
  }
  if (tree.type === "leaf") return tree;
  const [head, ...rest] = path;
  if (head < 0 || head >= tree.children.length) return tree;
  const updatedChild = setBranchSizes(tree.children[head], rest, sizes);
  if (updatedChild === tree.children[head]) return tree;
  const children = [...tree.children];
  children[head] = updatedChild;
  return { ...tree, children };
}

function isValidNode(node: unknown): node is SplitNode {
  if (typeof node !== "object" || node === null) return false;
  const n = node as Record<string, unknown>;
  if (n.type === "leaf") {
    return typeof n.groupId === "string" && n.groupId.length > 0;
  }
  if (n.type === "branch") {
    if (n.orientation !== "row" && n.orientation !== "column") return false;
    if (!Array.isArray(n.children) || n.children.length < 2) return false;
    if (!Array.isArray(n.sizes) || n.sizes.length !== n.children.length) return false;
    if (!n.sizes.every((s) => typeof s === "number" && Number.isFinite(s) && s > 0)) return false;
    return n.children.every(isValidNode);
  }
  return false;
}

// Validates a JSON value restored from localStorage — returns null (never
// throws) for anything malformed, so callers can fall back to a fresh tree.
export function parseStoredTree(json: unknown): SplitNode | null {
  return isValidNode(json) ? (json as SplitNode) : null;
}

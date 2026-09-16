// Pure model for the status bar's arrangement: which items sit in the left
// group, which in the right, and in what order. No React, no DOM — StatusBar
// turns this into buttons and a drag.
//
// The bar mixes two kinds of item, core readouts (memory, terminals) and
// whatever extensions contribute, and the user can reorder either kind and
// move one between the groups. So the stored value is just ids per group;
// what an item IS stays the renderer's business.

export type StatusBarSide = "left" | "right";

export const STATUS_BAR_SIDES: readonly StatusBarSide[] = ["left", "right"];

// Core readouts are ids too, so a drag can reorder them alongside contributed
// ones. Namespaced away from "ext." so they can never collide.
export const TERMINALS_ITEM_ID = "core.terminals";
// Phone only: the sidebar's own gear sits behind a drawer that starts closed
// there, so the bar carries the Manage menu's entry point instead.
export const MANAGE_ITEM_ID = "core.manage";

// The two groups alone — what a render pass needs, and all that resolving
// produces. The stored layout below is this plus the user's hidden set.
export interface StatusBarGroups {
  left: string[];
  right: string[];
}

export interface StatusBarLayout extends StatusBarGroups {
  // Items the user switched off from the gear menu's Status Bar list. Kept
  // apart from left/right so hiding never disturbs an arrangement: the id
  // stays where it was, and the caller simply leaves it out of the slots it
  // resolves. Per device, like the rest of this layout. An item whose
  // extension owns a visibility setting of its own is never listed here —
  // that setting is its switch (see RegisteredStatusBarItem).
  hidden: string[];
}

export const EMPTY_STATUS_BAR_LAYOUT: StatusBarLayout = { left: [], right: [], hidden: [] };

// An item the bar can render right now: its id and the group it belongs to
// until the user says otherwise.
export interface StatusBarSlot {
  id: string;
  defaultSide: StatusBarSide;
}

export function sideOfItem(layout: StatusBarGroups, id: string): StatusBarSide | null {
  if (layout.left.includes(id)) return "left";
  if (layout.right.includes(id)) return "right";
  return null;
}

// The order each group actually renders. Stored ids come first, in their
// stored order; anything the user has never arranged is appended to its
// default group in registration order. Ids with no live slot (an extension
// that is disabled right now) drop out here rather than being pruned from
// storage, so disabling and re-enabling an extension keeps its position —
// the same never-prune rule the sidebar layout follows.
//
// A hidden item is not a slot: the caller filters it out of `slots`, and this
// function's never-prune rule is exactly what returns it to the place it had
// once it comes back.
export function resolveStatusBarLayout(
  slots: readonly StatusBarSlot[],
  layout: StatusBarGroups,
): StatusBarGroups {
  const byId = new Map(slots.map((s) => [s.id, s]));
  const placed = new Set<string>();
  const take = (ids: readonly string[]) =>
    ids.filter((id) => {
      if (placed.has(id) || !byId.has(id)) return false;
      placed.add(id);
      return true;
    });

  const left = take(layout.left);
  const right = take(layout.right);
  for (const slot of slots) {
    if (placed.has(slot.id)) continue;
    placed.add(slot.id);
    (slot.defaultSide === "left" ? left : right).push(slot.id);
  }
  return { left, right };
}

// Moves an item to `side` at `index`, counted among that side's items with
// the moved one removed. Ids the caller didn't pass in `resolved` (a
// disabled extension's, say) keep their stored slot: the returned layout is
// built from the stored one so nothing is lost by a drag.
export function moveStatusBarItem(
  stored: StatusBarLayout,
  resolved: StatusBarGroups,
  id: string,
  side: StatusBarSide,
  index: number,
): StatusBarLayout {
  const target = [...resolved[side].filter((other) => other !== id)];
  const at = Math.max(0, Math.min(index, target.length));
  target.splice(at, 0, id);
  const other = side === "left" ? "right" : "left";
  const otherIds = resolved[other].filter((o) => o !== id);

  // Fold back any stored id that isn't currently rendered, at the position
  // it had, so an arrangement made while an extension was enabled survives
  // that extension being turned off and on again.
  const merge = (rendered: string[], storedIds: readonly string[]): string[] => {
    const out = [...rendered];
    for (const storedId of storedIds) {
      if (storedId === id || out.includes(storedId)) continue;
      if (resolved.left.includes(storedId) || resolved.right.includes(storedId)) continue;
      const at2 = Math.min(storedIds.indexOf(storedId), out.length);
      out.splice(at2, 0, storedId);
    }
    return out;
  };

  return side === "left"
    ? { ...stored, left: merge(target, stored.left), right: merge(otherIds, stored.right) }
    : { ...stored, left: merge(otherIds, stored.left), right: merge(target, stored.right) };
}

// Switches one item off, or back on — the gear menu's Status Bar list and the
// bar's own right-click menu. Only the hidden set moves; the item's group and
// position are left exactly as they were, so showing it again puts it back.
export function toggleStatusBarItemHidden(layout: StatusBarLayout, id: string): StatusBarLayout {
  const hidden = layout.hidden.includes(id)
    ? layout.hidden.filter((other) => other !== id)
    : [...layout.hidden, id];
  return { ...layout, hidden };
}

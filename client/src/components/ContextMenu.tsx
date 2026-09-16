import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDismissOnOutsidePress } from "../hooks/useDismissOnOutsidePress";
import { formatBinding, type Keybinding } from "../keybindings";
import type { MenuItem, MenuState } from "../types";
import Icon from "./Icon";

interface Props {
  menu: MenuState;
  onClose: () => void;
  // Resolves each item's shortcutCommand to a live hint — a Settings rebind
  // re-renders App (this component's sole render site), so even a menu
  // already open when the rebind happens shows the new combo immediately.
  resolvedBindings: Record<string, Keybinding[]>;
}

// A submenu's own position, measured against its parent row.
const SUBMENU_GAP = 2;
const EDGE = 4;

interface ListProps {
  items: MenuItem[];
  resolvedBindings: Record<string, Keybinding[]>;
  onClose: () => void;
  // Where this list sits. The root gets viewport coordinates from the menu
  // state; a submenu gets them from its parent row's rect.
  x: number;
  y: number;
  // A submenu flips to the left of its parent when there is no room to the
  // right; the parent passes the rect so the child can decide.
  parentRect?: DOMRect;
}

function MenuList({ items, resolvedBindings, onClose, x, y, parentRect }: ListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  // Which row's submenu is open, and the rect to anchor it to. Only one at a
  // time: pointing at a different row moves the open child rather than
  // stacking a second one.
  const [openSub, setOpenSub] = useState<{ index: number; rect: DOMRect } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { innerWidth, innerHeight } = window;
    const rect = el.getBoundingClientRect();
    // A submenu prefers its parent's right edge and flips to the left side
    // when that would run off screen; a root menu just clamps.
    const nextX = parentRect
      ? x + rect.width > innerWidth - EDGE
        ? Math.max(EDGE, parentRect.left - rect.width - SUBMENU_GAP)
        : x
      : Math.min(x, innerWidth - rect.width - EDGE);
    setPos({ x: nextX, y: Math.max(EDGE, Math.min(y, innerHeight - rect.height - EDGE)) });
  }, [x, y, parentRect, items]);

  const shortcutHint = (commandId: string | undefined): string | undefined => {
    const key = commandId ? resolvedBindings[commandId]?.[0]?.key : undefined;
    return key ? formatBinding(key) : undefined;
  };

  const hasChecks = items.some((item) => item.checked !== undefined || item.icon !== undefined);

  const openSubmenuFor = (index: number, el: HTMLElement) => {
    setOpenSub({ index, rect: el.getBoundingClientRect() });
  };

  return (
    <div
      ref={ref}
      className={`context-menu${parentRect ? " context-submenu" : ""}`}
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="context-menu-separator" />
        ) : item.swatches ? (
          <div key={i} className="context-menu-swatches">
            {item.swatches.colors.map((c) => (
              <button
                key={c.key}
                className={`swatch${item.swatches!.selected === c.key ? " selected" : ""}`}
                title={c.key}
                style={{ background: c.hex }}
                onClick={() => {
                  onClose();
                  item.swatches!.onPick(c.key);
                }}
              />
            ))}
          </div>
        ) : (
          <button
            key={i}
            className={`context-menu-item${item.danger ? " danger" : ""}${item.disabled ? " disabled" : ""}${
              openSub?.index === i ? " submenu-open" : ""
            }`}
            disabled={item.disabled}
            aria-haspopup={item.submenu ? "menu" : undefined}
            aria-expanded={item.submenu ? openSub?.index === i : undefined}
            onMouseEnter={(e) => {
              if (item.submenu) openSubmenuFor(i, e.currentTarget);
              // Pointing at a plain row closes whatever child was open, so
              // the menu never shows a child belonging to another row.
              else if (openSub) setOpenSub(null);
            }}
            onClick={(e) => {
              if (item.disabled) return;
              // A submenu row has no action of its own. Clicking it opens
              // the child — which is also the only way in on touch, where
              // there is no hover to trigger it.
              if (item.submenu) {
                openSubmenuFor(i, e.currentTarget);
                return;
              }
              onClose();
              item.onClick();
            }}
            onKeyDown={(e) => {
              if (item.submenu && (e.key === "ArrowRight" || e.key === "Enter")) {
                e.preventDefault();
                openSubmenuFor(i, e.currentTarget);
                return;
              }
              // Delete on the focused row fires its trailing action — the
              // keyboard path to the little icon button below.
              if (item.trailing && e.key === "Delete") {
                e.preventDefault();
                e.stopPropagation();
                onClose();
                item.trailing.onClick();
              }
            }}
          >
            {hasChecks && (
              <span className="context-menu-item-check">
                {item.checked ? <Icon name="check" /> : item.icon ? <Icon name={item.icon} /> : null}
              </span>
            )}
            <span className="context-menu-item-label">{item.label}</span>
            {shortcutHint(item.shortcutCommand) && (
              <span className="context-menu-item-shortcut">{shortcutHint(item.shortcutCommand)}</span>
            )}
            {item.submenu && (
              <span className="context-menu-item-chevron">
                <Icon name="chevron-right" />
              </span>
            )}
            {item.trailing && (
              // A span, not a nested <button> (invalid inside the row
              // button). The menu closes on activation so the snapshot of
              // items it renders can never go stale against the state the
              // action just changed.
              <span
                role="button"
                className="context-menu-item-trailing"
                title={item.trailing.title}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                  item.trailing!.onClick();
                }}
              >
                <Icon name={item.trailing.icon} />
              </span>
            )}
          </button>
        ),
      )}
      {openSub && items[openSub.index]?.submenu && (
        <MenuList
          items={items[openSub.index].submenu!}
          resolvedBindings={resolvedBindings}
          onClose={onClose}
          x={openSub.rect.right + SUBMENU_GAP}
          y={openSub.rect.top - EDGE}
          parentRect={openSub.rect}
        />
      )}
    </div>
  );
}

export default function ContextMenu({ menu, onClose, resolvedBindings }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Submenus render inside the root's DOM subtree, so `ref` covers every
  // level. The dismissing press is swallowed rather than passed through —
  // see the hook. `[data-menu-trigger]` is exempt so a toggle-style trigger
  // (the tab-group chip's windows-dropdown arrow) can decide for itself
  // whether to open or close: closed here, its own click would immediately
  // reopen it and the toggle would look dead.
  useDismissOnOutsidePress({
    ref,
    onDismiss: onClose,
    ignoreSelector: "[data-menu-trigger]",
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu-root">
      <MenuList
        items={menu.items}
        resolvedBindings={resolvedBindings}
        onClose={onClose}
        x={menu.x}
        y={menu.y}
      />
    </div>
  );
}

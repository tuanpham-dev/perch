import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { TouchKey } from "./touchKeys";
import { TouchKeyButton, visibleKeys } from "./TouchKeyBar";

interface Props {
  visible: boolean;
  keys: TouchKey[];
  currentCommand: string;
  stickyCtrl: boolean;
  onToggleStickyCtrl: () => void;
  onSendInput: (data: string) => void;
  onSendVoiceText: (text: string) => void;
  onUploadImages: (files: File[]) => void;
  // TerminalView's .terminal-body — the toggle's position is clamped within
  // its bounds and re-clamped on resize (rotation, sidebar toggle).
  containerRef: RefObject<HTMLElement | null>;
}

const STORAGE_KEY = "touchKeyFabPos";
const TOGGLE_SIZE = 44;
const DRAG_THRESHOLD = 6;
const CLUSTER_GAP = 8;
// Left/right inset of the expanded cluster from the container's edges — it
// spans the full inner width rather than hugging the toggle, so keys get the
// same generous hit area regardless of where the toggle was parked.
const CLUSTER_INSET = 12;

interface FabPos {
  // Fraction (0-1) of container width/height, applied to the toggle's
  // center — resize-proportional so orientation changes don't strand it
  // off-screen. Device-specific by nature, so this lives in localStorage
  // only, never the synced settings doc.
  xFrac: number;
  yFrac: number;
}

const DEFAULT_POS: FabPos = { xFrac: 0.9, yFrac: 0.82 };

function loadPos(): FabPos {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "");
    if (typeof parsed.xFrac === "number" && typeof parsed.yFrac === "number") {
      return parsed as FabPos;
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_POS;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

// The toggle's center, in container coordinates — shared by the render and
// the layout effect so both read the same geometry from `pos`.
function toggleCenterY(yFrac: number, height: number): number {
  const half = TOGGLE_SIZE / 2;
  return height ? clamp(yFrac * height, half, height - half) : 0;
}

// Which side the cluster opens on, given where it currently is. Sticky by
// design: it stays put for as long as it still fits on its current side, so
// dragging the toggle doesn't make the keys hop across the moment the other
// side becomes viable — a cluster that opened upward keeps opening upward
// while the toggle travels up, right until the room above runs out. Only
// when the current side can no longer hold it does it move, and if neither
// side fits it takes the roomier one.
function nextOpenUp(openUp: boolean, clusterHeight: number, spaceAbove: number, spaceBelow: number): boolean {
  const fitsAbove = spaceAbove >= clusterHeight;
  const fitsBelow = spaceBelow >= clusterHeight;
  if (openUp) return fitsAbove || (!fitsBelow && spaceAbove >= spaceBelow);
  return !fitsBelow && (fitsAbove || spaceAbove > spaceBelow);
}

// A movable AssistiveTouch-style toggle: tap expands the same when-filtered
// key set TouchKeyBar would show, positioned in a cluster next to the
// toggle instead of a fixed bottom strip; drag moves the toggle anywhere
// over the terminal. Alternative to TouchKeyBar for touchKeyBarStyle
// "floating" — see settings.ts.
export default function FloatingTouchKeys({
  visible,
  keys,
  currentCommand,
  stickyCtrl,
  onToggleStickyCtrl,
  onSendInput,
  onSendVoiceText,
  onUploadImages,
  containerRef,
}: Props) {
  const [pos, setPos] = useState<FabPos>(loadPos);
  const [expanded, setExpanded] = useState(false);
  const dragState = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);
  // Bumped by the ResizeObserver below so a container resize (rotation,
  // sidebar toggle) re-derives centerX/centerY from the live rect — the
  // fractional pos itself never needs adjusting, only the render does.
  const [, bumpForResize] = useState(0);
  // The cluster's measured height decides whether it still fits on its
  // current side (see nextOpenUp) and, when it opens upward, where its top
  // edge goes. Measured rather than estimated because it depends on how many
  // keys the current `when` filter leaves and how many rows they wrap into at
  // the container's width. `openUp` is state rather than a derived value
  // precisely because the choice is sticky: it depends on which side the
  // cluster was already on. The two are always written together, so a fresh
  // mount (0 / false) can't render a stale pairing.
  const clusterRef = useRef<HTMLDivElement>(null);
  const [clusterHeight, setClusterHeight] = useState(0);
  const [openUp, setOpenUp] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => bumpForResize((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  // Deliberately dependency-free and layout-phase: it must re-measure after
  // any render that can change the cluster's height or the space around it
  // (key set, drag, container resize, wrap count), and the setState lands
  // before paint, so a frame is never visibly on the wrong side. Returning
  // the previous side when nothing changed stops it from looping. While
  // collapsed there's no element to measure, so the last side stays cached
  // for the next open.
  useLayoutEffect(() => {
    const el = clusterRef.current;
    const container = containerRef.current;
    if (!el || !container) return;
    const h = el.offsetHeight;
    setClusterHeight((prev) => (prev === h ? prev : h));
    const height = container.getBoundingClientRect().height;
    const centerY = toggleCenterY(pos.yFrac, height);
    const half = TOGGLE_SIZE / 2;
    setOpenUp((up) =>
      nextOpenUp(up, h, centerY - half - CLUSTER_GAP, height - (centerY + half) - CLUSTER_GAP),
    );
  });

  if (!visible) return null;

  const shown = visibleKeys(keys, currentCommand);
  const rect = containerRef.current?.getBoundingClientRect();
  // Nothing to anchor to yet (first render, before the terminal body has laid
  // out). Bailing matters more now that this portals to <body>: without the
  // container's origin, a stray toggle would flash in the viewport's corner
  // instead of harmlessly at the container's own.
  if (!rect) return null;
  const width = rect.width;
  const height = rect.height;
  const half = TOGGLE_SIZE / 2;
  const centerX = width ? clamp(pos.xFrac * width, half, width - half) : 0;
  const centerY = toggleCenterY(pos.yFrac, height);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragState.current = { startX: e.clientX, startY: e.clientY, moved: false };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragState.current;
    if (!drag || !rect) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD) drag.moved = true;
    if (!drag.moved) return;
    const nx = clamp(e.clientX - rect.left, half, width - half);
    const ny = clamp(e.clientY - rect.top, half, height - half);
    setPos({ xFrac: width ? nx / width : DEFAULT_POS.xFrac, yFrac: height ? ny / height : DEFAULT_POS.yFrac });
  };

  const handlePointerUp = () => {
    const drag = dragState.current;
    dragState.current = null;
    if (!drag) return;
    if (drag.moved) {
      setPos((p) => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
        return p;
      });
    } else {
      setExpanded((v) => !v);
    }
  };

  // Rendered into <body> rather than the terminal body, and therefore in
  // viewport coordinates (the container's own origin plus the container-
  // relative geometry above). The terminal lives in a .split-content-host,
  // which is position:fixed with z-index 0 — a stacking context, so nothing
  // inside it can be raised above the app overlay layer (z-index 40) no
  // matter how large a z-index it takes. That layer holds extensions'
  // full-width overlays, e.g. one-hand's bottom gesture strip, which would
  // otherwise swallow taps meant for a toggle or key parked over it.
  // Escaping to <body> is what lets the CSS z-index below actually apply.
  // Safe because only the focused terminal renders this at all (client.tsx's
  // isVisible), so it never outlives the tab it belongs to the way a portal
  // gated only by DOM containment would.
  //
  // The cluster spans the full inner width, so only the vertical side can
  // move, and `openUp` (maintained by the layout effect above) decides it on
  // fit rather than on which half the toggle sits in. Both sides are placed
  // with `top` — deriving the upward case from the measured height rather
  // than a viewport-relative `bottom`, which would drift from the container
  // whenever a mobile keyboard makes the visual and layout viewports differ.
  const clusterTop = openUp
    ? rect.top + centerY - half - CLUSTER_GAP - clusterHeight
    : rect.top + centerY + half + CLUSTER_GAP;

  return createPortal(
    <>
      {expanded && shown.length > 0 && (
        <div
          ref={clusterRef}
          className="touch-key-fab-cluster"
          // Keeps a flick across the keys from reaching the host's
          // swipe-to-toggle-sidebar gesture — same reason as the toggle below.
          data-no-sidebar-swipe=""
          style={{
            left: `${rect.left + CLUSTER_INSET}px`,
            width: `${Math.max(width - CLUSTER_INSET * 2, 0)}px`,
            top: `${clusterTop}px`,
          }}
        >
          {shown.map(({ key, data }, i) => (
            <TouchKeyButton
              key={i}
              touchKey={key}
              data={data}
              stickyCtrl={stickyCtrl}
              onToggleStickyCtrl={onToggleStickyCtrl}
              onSendInput={onSendInput}
              onSendVoiceText={onSendVoiceText}
              onUploadImages={onUploadImages}
            />
          ))}
        </div>
      )}
      <button
        className={`touch-key-fab${expanded ? " active" : ""}`}
        // Dragging the toggle is a free horizontal motion the host's
        // flick-to-toggle-sidebar gesture would otherwise also read as a
        // sidebar swipe (it only skips horizontal *scrollers*).
        data-no-sidebar-swipe=""
        style={{ left: `${rect.left + centerX - half}px`, top: `${rect.top + centerY - half}px` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        ⌨
      </button>
    </>,
    document.body,
  );
}

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { downloadUrl } from "../../_shared/fileApi";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"];

interface Props {
  filePath: string;
  active: boolean;
  // The tab bar's actions container (TabBar's .tab-bar-actions), or null
  // before it's mounted. Controls are only portaled in while this tab is
  // active, so switching tabs swaps which viewer's toolbar is showing.
  toolbarTarget?: HTMLDivElement | null;
}

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 32;
const ZOOM_BUTTON_STEP = 1.25;
// factor = exp(-deltaY * SENSITIVITY): a continuous curve rather than fixed
// per-notch steps, so trackpad and wheel both feel proportionate to however
// much the user actually scrolled.
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
// "Fit" caps to the tab's width minus this much breathing room — it never
// scales an image up past 100% (a small icon opening at 300%+ reads as
// broken, not helpful), only down when the image is wider than the tab.
const FIT_WIDTH_MARGIN_PX = 32;

function clampScale(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

function ImageView({ filePath, active, toolbarTarget }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const basename = filePath.slice(filePath.lastIndexOf("/") + 1);

  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState(false);
  // "fit" is recomputed continuously from container/natural size (effect
  // below); "custom" is a user-picked scale/offset that sticks until they
  // zoom/pan again or explicitly hit Fit.
  const [mode, setMode] = useState<"fit" | "custom">("fit");
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  // Synchronous mirrors of the latest committed scale/offset, read from the
  // wheel listener and drag handlers below so neither needs to be
  // resubscribed on every render (same pattern as TerminalView's lastState).
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  // Fires on mount, on window/sidebar resizes, and when this tab goes from
  // display:none back to visible (a 0,0 → real-size transition still counts
  // as a resize) — so a hidden viewer refits as soon as it can measure.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setContainerSize({ width: el.clientWidth, height: el.clientHeight });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (mode !== "fit" || !natural || containerSize.width === 0 || containerSize.height === 0) return;
    const fitScale = clampScale(
      Math.min(1, (containerSize.width - FIT_WIDTH_MARGIN_PX) / natural.width),
    );
    setScale(fitScale);
    setOffset({
      x: (containerSize.width - natural.width * fitScale) / 2,
      y: (containerSize.height - natural.height * fitScale) / 2,
    });
  }, [mode, natural, containerSize]);

  const zoomAt = (px: number, py: number, factor: number) => {
    const prevScale = scaleRef.current;
    const prevOffset = offsetRef.current;
    const newScale = clampScale(prevScale * factor);
    setMode("custom");
    setScale(newScale);
    setOffset({
      x: px - ((px - prevOffset.x) / prevScale) * newScale,
      y: py - ((py - prevOffset.y) / prevScale) * newScale,
    });
  };

  // Native (non-passive) listener: React's onWheel can't preventDefault a
  // scroll/zoom gesture reliably across browsers. Reads zoomAt fresh each
  // call via closures over refs, so this never needs to be resubscribed.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY);
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; startOffset: { x: number; y: number } } | null>(null);

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startOffset: offsetRef.current,
    };
    setMode("custom");
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    setOffset({
      x: drag.startOffset.x + (e.clientX - drag.startX),
      y: drag.startOffset.y + (e.clientY - drag.startY),
    });
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  };

  const goFit = () => setMode("fit");

  const goActualSize = () => {
    if (!natural) return;
    setMode("custom");
    setScale(1);
    setOffset({
      x: (containerSize.width - natural.width) / 2,
      y: (containerSize.height - natural.height) / 2,
    });
  };

  const zoomOut = () => zoomAt(containerSize.width / 2, containerSize.height / 2, 1 / ZOOM_BUTTON_STEP);
  const zoomIn = () => zoomAt(containerSize.width / 2, containerSize.height / 2, ZOOM_BUTTON_STEP);

  const onDoubleClick = () => {
    if (mode === "fit") goActualSize();
    else goFit();
  };

  const controls = (
    <>
      {natural && (
        <span className="image-toolbar-readout">
          {natural.width}×{natural.height} · {Math.round(scale * 100)}%
        </span>
      )}
      <button className="icon-button" title="Zoom out" disabled={!natural} onClick={zoomOut}>
        <Icon name="zoom-out" />
      </button>
      <button className="icon-button" title="Zoom in" disabled={!natural} onClick={zoomIn}>
        <Icon name="zoom-in" />
      </button>
      <button className="icon-button" title="Fit to window" disabled={!natural} onClick={goFit}>
        <Icon name="screen-full" />
      </button>
      <button className="icon-button" title="Actual size (100%)" disabled={!natural} onClick={goActualSize}>
        <Icon name="screen-normal" />
      </button>
    </>
  );

  return (
    <div className={`image-host${active ? "" : " hidden"}`}>
      <div
        className={`image-viewport${dragging ? " dragging" : ""}`}
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
      >
        {!error && (
          <img
            src={downloadUrl(filePath)}
            alt={basename}
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNatural({ width: img.naturalWidth, height: img.naturalHeight });
              setError(false);
            }}
            onError={() => setError(true)}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              transformOrigin: "0 0",
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              imageRendering: scale > 1 ? "pixelated" : "auto",
              visibility: natural ? "visible" : "hidden",
            }}
          />
        )}
        {!natural && !error && <div className="image-status">Loading…</div>}
        {error && <div className="image-status image-error">Couldn't load {basename}</div>}
      </div>
      {active && toolbarTarget && createPortal(controls, toolbarTarget)}
    </div>
  );
}

let removeStylesheet: (() => void) | null = null;

export function activate(ctx: {
  registerFileViewer: (v: {
    id: string;
    extensions: string[];
    mode: "default" | "preview";
    component: typeof ImageView;
  }) => void;
  assetUrl: (relPath: string) => string;
}) {
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerFileViewer({
    id: "imageViewer",
    extensions: IMAGE_EXTENSIONS,
    mode: "default",
    component: ImageView,
  });
}

export function deactivate() {
  removeStylesheet?.();
  removeStylesheet = null;
}

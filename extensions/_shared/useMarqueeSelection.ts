// Copied from client/src/hooks/useMarqueeSelection.ts — see extensions/
// _shared's module comment on why this is a copy, not a shared runtime
// import.
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, RefObject } from "react";

export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MarqueeRow {
  id: string;
  el: HTMLElement;
}

export interface UseMarqueeSelectionOptions {
  containerRef: RefObject<HTMLElement | null>;
  // Called fresh on every intersection pass — cheap to recompute since
  // callers already hold their row list in state/refs; this hook never
  // caches it across frames (rows can appear/disappear mid-drag, e.g. a
  // status refresh pruning a group).
  getRows: () => MarqueeRow[];
  // Fires once, the instant the drag crosses the arm threshold — the
  // consumer snapshots whatever "pre-drag selection" it needs for an
  // additive (Ctrl/Cmd-held) drag. Never fires for a plain click (a press
  // that never crosses the threshold produces no callbacks at all, and the
  // resulting native click event is left completely untouched).
  onStart: () => void;
  // Fires on every intersection recompute (at most once per animation
  // frame) with the ids of rows the marquee currently overlaps.
  onMarquee: (ids: string[], additive: boolean) => void;
  // Fires once, when an armed drag ends. `canceled` is true on Escape (the
  // consumer should restore whatever it snapshotted in onStart); otherwise
  // `nearestId` is the last-intersected row closest to the release point
  // (null if the marquee ended over no rows), for the consumer to use as
  // the next Shift+click anchor / keyboard focus target.
  onEnd: (canceled: boolean, nearestId: string | null) => void;
}

const DRAG_THRESHOLD_PX = 4;
const AUTOSCROLL_EDGE_PX = 24;
const AUTOSCROLL_MAX_PX_PER_FRAME = 14;

// Rubber-band marquee selection shared by FileTree.tsx and the git-scm
// extension's GitPanel (via extensions/_shared's verbatim copy — extension
// code can't import client/src, see that file's header comment). Owns the
// gesture mechanics only — arm threshold, content-space rect math (so edge
// autoscroll can't slide the anchored corner), rAF-throttled intersection,
// edge autoscroll, Escape-cancel, and a one-shot click suppressor so the
// drag's terminal mouseup doesn't also fire as a "click on empty space
// clears selection" handler. Consumers own row enumeration and what
// "select these ids" means (see FileTree.tsx / GitPanel for the two call
// sites).
export function useMarqueeSelection({
  containerRef,
  getRows,
  onStart,
  onMarquee,
  onEnd,
}: UseMarqueeSelectionOptions): {
  marqueeRect: MarqueeRect | null;
  onMarqueeMouseDown: (e: ReactMouseEvent) => void;
} {
  const [marqueeRect, setMarqueeRect] = useState<MarqueeRect | null>(null);

  // Cleared on unmount so a drag started right before navigating away
  // doesn't leak document listeners or a pending rAF callback.
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const onMarqueeMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      if (e.button !== 0) return;
      const container = containerRef.current;
      if (!container) return;
      // Stops the press from moving DOM focus to <body> — which would
      // otherwise silently break a consumer's own keyboard nav (e.g.
      // FileTree's roving tabindex expects focus to stay on whatever row
      // last called focusRow() until another focusRow() call moves it) —
      // and from starting a native image drag on an SVG icon inside the
      // container.
      e.preventDefault();

      const additive = e.ctrlKey || e.metaKey;
      const startClientX = e.clientX;
      const startClientY = e.clientY;
      let armed = false;
      let rafId: number | null = null;
      let pointerClientX = startClientX;
      let pointerClientY = startClientY;
      // Anchor in content-space (scrollLeft/scrollTop-relative), set once
      // arming completes below, from the *original* press point — not
      // wherever the pointer happened to be when the threshold was
      // crossed — so autoscroll keeps that corner pinned to the content it
      // started on.
      let anchorContentX = 0;
      let anchorContentY = 0;
      // Rows intersected on the most recent frame, cached so finish() can
      // pick the nearest one without a second full getRows() + rect pass.
      let lastIntersected: { id: string; centerX: number; centerY: number }[] = [];

      const toContentSpace = (clientX: number, clientY: number) => {
        const rect = container.getBoundingClientRect();
        return {
          x: clientX - rect.left + container.scrollLeft,
          y: clientY - rect.top + container.scrollTop,
        };
      };

      const computeFrame = () => {
        rafId = null;
        if (!armed) return;

        // Edge autoscroll: proportional to how far past the edge the
        // pointer is, clamped so one frame can't jump too far.
        const rect = container.getBoundingClientRect();
        let scrolled = false;
        if (pointerClientY < rect.top + AUTOSCROLL_EDGE_PX && container.scrollTop > 0) {
          const overshoot = rect.top + AUTOSCROLL_EDGE_PX - pointerClientY;
          container.scrollTop -= Math.min(AUTOSCROLL_MAX_PX_PER_FRAME, overshoot);
          scrolled = true;
        } else if (
          pointerClientY > rect.bottom - AUTOSCROLL_EDGE_PX &&
          container.scrollTop < container.scrollHeight - container.clientHeight
        ) {
          const overshoot = pointerClientY - (rect.bottom - AUTOSCROLL_EDGE_PX);
          container.scrollTop += Math.min(AUTOSCROLL_MAX_PX_PER_FRAME, overshoot);
          scrolled = true;
        }

        const pointerContent = toContentSpace(pointerClientX, pointerClientY);
        const left = Math.min(anchorContentX, pointerContent.x);
        const top = Math.min(anchorContentY, pointerContent.y);
        const width = Math.abs(pointerContent.x - anchorContentX);
        const height = Math.abs(pointerContent.y - anchorContentY);
        setMarqueeRect({ left, top, width, height });

        // Recomputed every frame, not cached across frames — rows can
        // scroll under a stationary pointer during autoscroll.
        const marqueeRight = left + width;
        const marqueeBottom = top + height;
        const ids: string[] = [];
        const intersected: { id: string; centerX: number; centerY: number }[] = [];
        for (const row of getRows()) {
          const rowRect = row.el.getBoundingClientRect();
          const rowContent = toContentSpace(rowRect.left, rowRect.top);
          const rowRight = rowContent.x + rowRect.width;
          const rowBottom = rowContent.y + rowRect.height;
          if (rowContent.x < marqueeRight && rowRight > left && rowContent.y < marqueeBottom && rowBottom > top) {
            ids.push(row.id);
            intersected.push({
              id: row.id,
              centerX: rowContent.x + rowRect.width / 2,
              centerY: rowContent.y + rowRect.height / 2,
            });
          }
        }
        lastIntersected = intersected;
        onMarquee(ids, additive);

        if (scrolled) rafId = requestAnimationFrame(computeFrame);
      };

      const scheduleFrame = () => {
        if (rafId === null) rafId = requestAnimationFrame(computeFrame);
      };

      const onMouseMove = (ev: MouseEvent) => {
        pointerClientX = ev.clientX;
        pointerClientY = ev.clientY;
        if (!armed) {
          const dx = ev.clientX - startClientX;
          const dy = ev.clientY - startClientY;
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          armed = true;
          const anchor = toContentSpace(startClientX, startClientY);
          anchorContentX = anchor.x;
          anchorContentY = anchor.y;
          document.body.style.userSelect = "none";
          onStart();
        }
        scheduleFrame();
      };

      const finish = (canceled: boolean) => {
        cleanup();
        if (!armed) return;
        document.body.style.userSelect = "";
        if (canceled) {
          onEnd(true, null);
          return;
        }
        const pointerContent = toContentSpace(pointerClientX, pointerClientY);
        let nearestId: string | null = null;
        let nearestDist = Infinity;
        for (const row of lastIntersected) {
          const dist = Math.hypot(row.centerX - pointerContent.x, row.centerY - pointerContent.y);
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestId = row.id;
          }
        }
        onEnd(false, nearestId);

        // The mouseup that just fired is about to generate a native click
        // event (a real drag doesn't suppress it — the browser only
        // suppresses click when the press and release targets differ,
        // which isn't guaranteed here). Swallow exactly that one click so
        // a consumer's "click on empty space clears selection" handler
        // doesn't immediately undo the drag. Capture-phase so it runs
        // before the consumer's own bubble-phase handler; removed on the
        // click itself or a 0ms timeout fallback in case it never fires
        // (e.g. the mouseup landed outside the document).
        const suppressClick = (ev: MouseEvent) => {
          ev.stopPropagation();
          document.removeEventListener("click", suppressClick, true);
        };
        document.addEventListener("click", suppressClick, true);
        window.setTimeout(() => document.removeEventListener("click", suppressClick, true), 0);
      };

      const onMouseUp = () => finish(false);
      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") finish(true);
      };

      function cleanup() {
        if (rafId !== null) cancelAnimationFrame(rafId);
        rafId = null;
        document.removeEventListener("mousemove", onMouseMove, true);
        document.removeEventListener("mouseup", onMouseUp, true);
        document.removeEventListener("keydown", onKeyDown, true);
        setMarqueeRect(null);
        cleanupRef.current = null;
      }

      document.addEventListener("mousemove", onMouseMove, true);
      document.addEventListener("mouseup", onMouseUp, true);
      document.addEventListener("keydown", onKeyDown, true);
      cleanupRef.current = () => finish(true);
    },
    [containerRef, getRows, onStart, onMarquee, onEnd],
  );

  return { marqueeRect, onMarqueeMouseDown };
}

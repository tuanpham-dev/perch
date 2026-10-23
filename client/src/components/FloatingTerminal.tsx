import { useEffect, useRef, useState } from "react";
import type { TerminalTheme } from "../engines/types";
import type { FloatingState } from "../hooks/useFloatingTerminal";
import type { Keybinding } from "../keybindings";
import type { AppSettings } from "../settings";
import type { MenuItem } from "../types";
import Icon from "./Icon";
import TerminalView from "./TerminalView";

// The floating terminal's UI (useFloatingTerminal holds what floats). Two
// shapes over the whole app:
//   window  a drag bar, the terminal, and resize handles on every edge and
//           corner;
//   bubble  a round handle like the floating touch-keys toggle: drag it
//           anywhere, tap it to open the window again.
// The terminal stays mounted while collapsed (hidden, not unrendered), so its
// scrollback and attach survive minimizing, as a hidden tab's do.
//
// Where both sit is per device (localStorage only, never the synced settings
// doc): the window as a pixel rect, the bubble as a fraction of the viewport
// so a rotation can't strand it. Both are clamped to the viewport at render
// time, so a smaller window or a phone never loses them off-screen.

const RECT_KEY = "perch.floatingTerminalRect";
const BUBBLE_KEY = "perch.floatingTerminalBubble";
const MIN_W = 280;
const MIN_H = 140;
// How much of the drag bar must stay on screen, so the window can always be
// grabbed back.
const KEEP_VISIBLE = 48;
const BUBBLE_SIZE = 44;
const DRAG_THRESHOLD = 6;
const EDGE_GAP = 8;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface BubblePos {
  xFrac: number;
  yFrac: number;
}

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const RESIZE_DIRS: ResizeDir[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), Math.max(min, max));
}

function viewport(): { vw: number; vh: number } {
  return { vw: window.innerWidth, vh: window.innerHeight };
}

// Bottom-right on a desktop; on a phone, full width and the lower half, where
// a thumb reaches the drag bar.
function defaultRect(mobile: boolean): Rect {
  const { vw, vh } = viewport();
  if (mobile) {
    const h = Math.round(vh * 0.45);
    return { x: EDGE_GAP, y: vh - h - 72, w: vw - EDGE_GAP * 2, h };
  }
  const w = Math.min(720, vw - 2 * EDGE_GAP);
  const h = Math.min(420, vh - 2 * EDGE_GAP);
  return { x: vw - w - 24, y: vh - h - 56, w, h };
}

function fitRect(r: Rect): Rect {
  const { vw, vh } = viewport();
  const w = clamp(r.w, Math.min(MIN_W, vw), vw);
  const h = clamp(r.h, Math.min(MIN_H, vh), vh);
  return {
    w,
    h,
    x: clamp(r.x, KEEP_VISIBLE - w, vw - KEEP_VISIBLE),
    y: clamp(r.y, 0, vh - KEEP_VISIBLE),
  };
}

function loadJson<T>(key: string, valid: (v: unknown) => v is T): T | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return valid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked: the position lasts for this page only
  }
}

const isRect = (v: unknown): v is Rect =>
  !!v && typeof v === "object" && ["x", "y", "w", "h"].every((k) => typeof (v as Record<string, unknown>)[k] === "number");
const isBubble = (v: unknown): v is BubblePos =>
  !!v && typeof v === "object" && typeof (v as BubblePos).xFrac === "number" && typeof (v as BubblePos).yFrac === "number";

// The window rect after dragging edge(s) `dir` by (dx, dy) from `start`. The
// opposite edge stays put, and a size that would go below the minimum stops
// there rather than pushing the window along.
function resized(start: Rect, dir: ResizeDir, dx: number, dy: number): Rect {
  let { x, y, w, h } = start;
  if (dir.includes("e")) w = Math.max(MIN_W, start.w + dx);
  if (dir.includes("s")) h = Math.max(MIN_H, start.h + dy);
  if (dir.includes("w")) {
    w = Math.max(MIN_W, start.w - dx);
    x = start.x + start.w - w;
  }
  if (dir.includes("n")) {
    h = Math.max(MIN_H, start.h - dy);
    y = start.y + start.h - h;
  }
  return { x, y, w, h };
}

interface Props {
  floating: FloatingState;
  focused: boolean;
  mobilePointer: boolean;
  // Settings → UI → Show floating terminal bubble. Off, a minimized terminal
  // has no handle on screen; the status bar item or the shortcut reopens it.
  showBubble: boolean;
  // "project · window", resolved by App from the live sessions list.
  label: string;
  // The window printed output since it was last looked at.
  activity: boolean;
  onFocus: () => void;
  onExpand: () => void;
  onCollapse: () => void;
  onDock: () => void;
  onClose: () => void;
  onExit: () => void;
  terminal: {
    settings: AppSettings;
    theme: TerminalTheme | null;
    fontsVersion: number;
    bindings: Record<string, Keybinding[]>;
    onError: (err: unknown) => void;
    showMenu: (x: number, y: number, items: MenuItem[]) => void;
    onOpenFile: (path: string, line?: number) => void;
    onOpenFileSecondary: (path: string, line?: number) => void;
    onPreviewFile: (path: string) => void;
    isPreviewable: (path: string) => boolean;
    onWindowSwitch: (session: string, windowIndex: number) => void;
    onSessionSwitch: (session: string, windowIndex: number) => void;
  };
}

export default function FloatingTerminal({
  floating,
  focused,
  mobilePointer,
  showBubble,
  label,
  activity,
  onFocus,
  onExpand,
  onCollapse,
  onDock,
  onClose,
  onExit,
  terminal,
}: Props) {
  const [rect, setRect] = useState<Rect>(() => loadJson(RECT_KEY, isRect) ?? defaultRect(mobilePointer));
  const [bubble, setBubble] = useState<BubblePos>(() => loadJson(BUBBLE_KEY, isBubble) ?? { xFrac: 0.94, yFrac: 0.82 });
  // Re-render on a viewport change so the clamps below re-apply; the stored
  // geometry itself is only rewritten by the user's own drags.
  const [, bumpForResize] = useState(0);
  const drag = useRef<
    | { kind: "move"; startX: number; startY: number; start: Rect }
    | { kind: "resize"; dir: ResizeDir; startX: number; startY: number; start: Rect }
    | { kind: "bubble"; startX: number; startY: number; moved: boolean }
    | null
  >(null);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const bubbleRef = useRef(bubble);
  bubbleRef.current = bubble;

  useEffect(() => {
    const onResize = () => bumpForResize((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const shown = fitRect(rect);
  const { tab, expanded } = floating;

  const startDrag = (e: React.PointerEvent, state: NonNullable<typeof drag.current>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = state;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.kind === "move") setRect({ ...d.start, x: d.start.x + dx, y: d.start.y + dy });
    else if (d.kind === "resize") setRect(resized(d.start, d.dir, dx, dy));
    else {
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) d.moved = true;
      if (!d.moved) return;
      const { vw, vh } = viewport();
      const half = BUBBLE_SIZE / 2;
      setBubble({ xFrac: clamp(e.clientX, half, vw - half) / vw, yFrac: clamp(e.clientY, half, vh - half) / vh });
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "bubble") {
      if (d.moved) saveJson(BUBBLE_KEY, bubbleRef.current);
      else onExpand();
      return;
    }
    // Stored as shown, so a window dragged half off-screen comes back where
    // the clamp left it rather than jumping on the next viewport change.
    const fitted = fitRect(rectRef.current);
    setRect(fitted);
    saveJson(RECT_KEY, fitted);
  };

  const { vw, vh } = viewport();
  const half = BUBBLE_SIZE / 2;
  const bubbleLeft = clamp(bubble.xFrac * vw, half, vw - half) - half;
  const bubbleTop = clamp(bubble.yFrac * vh, half, vh - half) - half;

  return (
    <>
      <div
        className={`floating-terminal${focused ? " focused" : ""}${mobilePointer ? " coarse" : ""}`}
        style={{ left: shown.x, top: shown.y, width: shown.w, height: shown.h, display: expanded ? undefined : "none" }}
        onPointerDownCapture={onFocus}
        role="dialog"
        aria-label={`Floating terminal: ${label}`}
      >
        <div
          className="floating-terminal-bar"
          onPointerDown={(e) => {
            if ((e.target as Element).closest("button")) return;
            startDrag(e, { kind: "move", startX: e.clientX, startY: e.clientY, start: shown });
          }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={(e) => {
            if (!(e.target as Element).closest("button")) onCollapse();
          }}
        >
          <Icon name="terminal" className="floating-terminal-icon" />
          <span className="floating-terminal-title" title={label}>
            {label}
          </span>
          <div className="floating-terminal-actions">
            <button type="button" className="floating-terminal-button" title="Dock as Tab" aria-label="Dock as Tab" onClick={onDock}>
              <Icon name="window" />
            </button>
            <button type="button" className="floating-terminal-button" title="Minimize" aria-label="Minimize" onClick={onCollapse}>
              <Icon name="chrome-minimize" />
            </button>
            <button
              type="button"
              className="floating-terminal-button"
              title="Close (the terminal keeps running)"
              aria-label="Close"
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          </div>
        </div>
        <div className="floating-terminal-body">
          <TerminalView
            key={tab.attachName}
            attachName={tab.attachName}
            visible={expanded}
            focused={focused}
            settings={terminal.settings}
            theme={terminal.theme}
            fontsVersion={terminal.fontsVersion}
            bindings={terminal.bindings}
            onExit={onExit}
            onError={terminal.onError}
            showMenu={terminal.showMenu}
            onOpenFile={terminal.onOpenFile}
            onOpenFileSecondary={terminal.onOpenFileSecondary}
            onPreviewFile={terminal.onPreviewFile}
            isPreviewable={terminal.isPreviewable}
            onWindowSwitch={(windowIndex) => terminal.onWindowSwitch(tab.sessionName, windowIndex)}
            onSessionSwitch={terminal.onSessionSwitch}
            terminalWindow={
              tab.windowIndex !== undefined
                ? { sessionName: tab.sessionName, windowIndex: tab.windowIndex, windowId: tab.windowId }
                : undefined
            }
          />
        </div>
        {RESIZE_DIRS.map((dir) => (
          <div
            key={dir}
            className={`floating-terminal-resize floating-terminal-resize-${dir}`}
            onPointerDown={(e) => startDrag(e, { kind: "resize", dir, startX: e.clientX, startY: e.clientY, start: shown })}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        ))}
      </div>
      {!expanded && showBubble && (
        <button
          type="button"
          className={`floating-terminal-bubble${activity ? " activity" : ""}`}
          style={{ left: bubbleLeft, top: bubbleTop }}
          title={`${label} - tap to open, drag to move`}
          aria-label={`Open floating terminal: ${label}`}
          onPointerDown={(e) => startDrag(e, { kind: "bubble", startX: e.clientX, startY: e.clientY, moved: false })}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onExpand();
            }
          }}
        >
          <Icon name="terminal" />
        </button>
      )}
    </>
  );
}

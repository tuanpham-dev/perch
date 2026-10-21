// Preview viewports: the device sizes a preview frame can take (the HTML
// preview, the ports extension's dev-server and web tabs). The frame gets
// the device's real CSS width and height, so the page's own media queries
// answer to it; a device bigger than the tab is scaled down to fit, the way
// a browser's device toolbar does it.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import Icon from "./Icon";
import type { MenuItem } from "./types";

export interface ViewportPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  kind: "phone" | "tablet" | "desktop";
}

export const VIEWPORT_PRESETS: readonly ViewportPreset[] = [
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667, kind: "phone" },
  { id: "iphone-15", label: "iPhone 15", width: 393, height: 852, kind: "phone" },
  { id: "pixel-8", label: "Pixel 8", width: 412, height: 915, kind: "phone" },
  { id: "ipad-mini", label: "iPad Mini", width: 768, height: 1024, kind: "tablet" },
  { id: "ipad-pro-11", label: "iPad Pro 11\"", width: 834, height: 1194, kind: "tablet" },
  { id: "laptop", label: "Laptop", width: 1366, height: 768, kind: "desktop" },
  { id: "desktop", label: "Desktop", width: 1440, height: 900, kind: "desktop" },
  { id: "full-hd", label: "Full HD", width: 1920, height: 1080, kind: "desktop" },
];

export const FIT_VIEWPORT = "fit";

export const CUSTOM_VIEWPORT = "custom";

// What a preview shows: "fit" (the frame fills the tab), a preset or a
// custom size, optionally turned to landscape; and optionally a second,
// view-only frame beside it at another preset (`compare`).
export interface ViewportChoice {
  id: string;
  rotated: boolean;
  width?: number;
  height?: number;
  compare?: string | null;
}

// Asks for a custom size; each extension hands in its app's prompt dialog.
let promptForSize: ((message: string, defaultValue?: string) => Promise<string | null>) | null = null;

export function setViewportPrompt(fn: typeof promptForSize): void {
  promptForSize = fn;
}

function kindForWidth(width: number): ViewportPreset["kind"] {
  return width < 600 ? "phone" : width < 1024 ? "tablet" : "desktop";
}

const MIN_SIZE = 200;
const MAX_SIZE = 4000;

function validSize(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= MIN_SIZE && n <= MAX_SIZE;
}

const STORAGE_KEY = "perch.preview.viewport";

export function loadViewportChoice(): ViewportChoice {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<ViewportChoice> | null;
    const compare =
      typeof parsed?.compare === "string" && VIEWPORT_PRESETS.some((p) => p.id === parsed.compare) ? parsed.compare : null;
    if (parsed?.id === CUSTOM_VIEWPORT && validSize(parsed.width) && validSize(parsed.height)) {
      return { id: CUSTOM_VIEWPORT, rotated: false, width: parsed.width, height: parsed.height, compare };
    }
    if (parsed && typeof parsed.id === "string" && (parsed.id === FIT_VIEWPORT || VIEWPORT_PRESETS.some((p) => p.id === parsed.id))) {
      return { id: parsed.id, rotated: parsed.rotated === true, compare };
    }
  } catch {
    // storage blocked or corrupt: the default below
  }
  return { id: FIT_VIEWPORT, rotated: false };
}

function saveViewportChoice(choice: ViewportChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // remembered for this tab only
  }
}

// Where the side-by-side divider was dragged to, per pair of viewports
// (pairKey), so it stays put across reloads and in every preview. A pair
// with no entry splits by the two widths (autoSplit); double-clicking the
// divider goes back to that.
const SPLIT_KEY = "perch.preview.split";
const splitListeners = new Set<(ratios: Record<string, number>) => void>();

function loadSplitRatios(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SPLIT_KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [pair, ratio] of Object.entries(parsed)) {
      if (typeof ratio === "number" && ratio >= SPLIT_MIN && ratio <= SPLIT_MAX) out[pair] = ratio;
    }
    return out;
  } catch {
    return {};
  }
}

function saveSplitRatio(pair: string, ratio: number | null): void {
  const ratios = loadSplitRatios();
  if (ratio === null) delete ratios[pair];
  else ratios[pair] = ratio;
  try {
    localStorage.setItem(SPLIT_KEY, JSON.stringify(ratios));
  } catch {
    // kept until the preview closes
  }
  for (const listener of splitListeners) listener(ratios);
}

function useSplitRatios(): Record<string, number> {
  const [ratios, setRatios] = useState(loadSplitRatios);
  useEffect(() => {
    splitListeners.add(setRatios);
    return () => {
      splitListeners.delete(setRatios);
    };
  }, []);
  return ratios;
}

export function presetFor(choice: ViewportChoice): ViewportPreset | null {
  if (choice.id === CUSTOM_VIEWPORT && validSize(choice.width) && validSize(choice.height)) {
    return { id: CUSTOM_VIEWPORT, label: "Custom", width: choice.width, height: choice.height, kind: kindForWidth(choice.width) };
  }
  return VIEWPORT_PRESETS.find((p) => p.id === choice.id) ?? null;
}

// The view-only frame beside the main one, when comparing.
export function compareChoice(choice: ViewportChoice): ViewportChoice | null {
  return choice.compare ? { id: choice.compare, rotated: false } : null;
}

// What to compare against by default: the other end of the size range.
function counterpart(choice: ViewportChoice): string {
  const preset = presetFor(choice);
  return preset && preset.kind !== "desktop" ? "desktop" : "iphone-15";
}

async function askCustomSize(choice: ViewportChoice, onPick: (next: ViewportChoice) => void): Promise<void> {
  if (!promptForSize) return;
  const current = presetFor(choice);
  const answer = await promptForSize(
    "Viewport size, width × height in CSS pixels (200–4000)",
    current ? `${current.width}×${current.height}` : "1024×768",
  );
  if (!answer) return;
  const match = /^\s*(\d{3,4})\s*[x×*, ]\s*(\d{3,4})\s*$/i.exec(answer);
  if (!match) return;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!validSize(width) || !validSize(height)) return;
  onPick({ id: CUSTOM_VIEWPORT, rotated: false, width, height, compare: choice.compare ?? null });
}

// A viewport as a person (and an agent) reads it: "iPhone 15, 393×852".
export function describeViewport(label: string, width: number, height: number): string {
  return `${label}, ${Math.round(width)}×${Math.round(height)}`;
}

// The viewport choice every preview tab shares: picking one in a tab makes
// it the default for the next, and the tabs already open follow along.
const listeners = new Set<(choice: ViewportChoice) => void>();

export function useViewportChoice(): [ViewportChoice, (next: ViewportChoice) => void] {
  const [choice, setChoice] = useState(loadViewportChoice);
  useEffect(() => {
    listeners.add(setChoice);
    return () => {
      listeners.delete(setChoice);
    };
  }, []);
  const update = (next: ViewportChoice) => {
    saveViewportChoice(next);
    for (const listener of listeners) listener(next);
  };
  return [choice, update];
}

export function viewportMenuItems(choice: ViewportChoice, onPick: (next: ViewportChoice) => void): MenuItem[] {
  const keep = { compare: choice.compare ?? null };
  const items: MenuItem[] = [
    { label: "Fit to Tab", checked: choice.id === FIT_VIEWPORT, onClick: () => onPick({ id: FIT_VIEWPORT, rotated: false, ...keep }) },
    { separator: true, label: "", onClick: () => {} },
  ];
  let lastKind: ViewportPreset["kind"] | null = null;
  for (const preset of VIEWPORT_PRESETS) {
    if (lastKind && preset.kind !== lastKind) items.push({ separator: true, label: "", onClick: () => {} });
    lastKind = preset.kind;
    items.push({
      // No-break spaces: the menu wraps at a space, splitting name and size.
      label: `${preset.label} · ${preset.width}×${preset.height}`.replace(/ /g, "\u00a0"),
      checked: choice.id === preset.id,
      onClick: () => onPick({ id: preset.id, rotated: choice.id === preset.id ? choice.rotated : false, ...keep }),
    });
  }
  const custom = choice.id === CUSTOM_VIEWPORT ? presetFor(choice) : null;
  items.push({ separator: true, label: "", onClick: () => {} });
  items.push({
    label: custom ? `Custom · ${custom.width}×${custom.height}…`.replace(/ /g, "\u00a0") : "Custom Size…",
    checked: choice.id === CUSTOM_VIEWPORT,
    disabled: !promptForSize,
    onClick: () => void askCustomSize(choice, onPick),
  });
  items.push({
    label: choice.rotated ? "Portrait" : "Landscape",
    disabled: choice.id === FIT_VIEWPORT,
    onClick: () => onPick({ ...choice, rotated: !choice.rotated }),
  });
  items.push({ separator: true, label: "", onClick: () => {} });
  if (choice.compare) {
    items.push({ label: "Stop Comparing", onClick: () => onPick({ ...choice, compare: null }) });
  }
  for (const id of ["iphone-15", "ipad-mini", "desktop"]) {
    const preset = VIEWPORT_PRESETS.find((p) => p.id === id)!;
    items.push({
      label: `Compare with ${preset.label}`.replace(/ /g, "\u00a0"),
      checked: choice.compare === id,
      onClick: () => onPick({ ...choice, compare: choice.compare === id ? null : id }),
    });
  }
  return items;
}

// The tab-bar button that opens the viewport menu.
export function ViewportButton({
  choice,
  onPick,
  showMenu,
}: {
  choice: ViewportChoice;
  onPick: (next: ViewportChoice) => void;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
}) {
  const preset = presetFor(choice);
  const icon = !preset ? "screen-full" : preset.kind === "desktop" ? "device-desktop" : "device-mobile";
  const width = preset ? (choice.rotated ? preset.height : preset.width) : 0;
  const height = preset ? (choice.rotated ? preset.width : preset.height) : 0;
  return (
    <button
      className={`icon-button${preset ? " active" : ""}`}
      title={preset ? `Viewport: ${describeViewport(preset.label, width, height)}` : "Viewport: fit to tab"}
      disabled={!showMenu}
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        showMenu?.(rect.left, rect.bottom, viewportMenuItems(choice, onPick));
      }}
    >
      <Icon name={icon} />
    </button>
  );
}

// Shows a second, view-only frame beside the preview, at the other end of
// the size range (phone beside desktop), or hides it.
export function CompareButton({ choice, onPick }: { choice: ViewportChoice; onPick: (next: ViewportChoice) => void }) {
  const other = choice.compare ? VIEWPORT_PRESETS.find((p) => p.id === choice.compare) : null;
  return (
    <button
      className={`icon-button${choice.compare ? " active" : ""}`}
      title={other ? `Comparing with ${other.label} (click to stop)` : "Compare side by side"}
      onClick={() => onPick({ ...choice, compare: choice.compare ? null : counterpart(choice) })}
    >
      <Icon name="split-horizontal" />
    </button>
  );
}

// Where the frame sits inside the stage, and at what scale: the coordinate
// mapping ElementComments needs to put a badge on a picked element.
export interface FrameGeometry {
  left: number;
  top: number;
  scale: number;
  // The frame's own CSS size, which is the page's viewport.
  width: number;
  height: number;
  label: string;
}

const STAGE_PAD = 16;
const CAPTION = 22;

// Lays a preview frame out at the chosen viewport inside a positioned box
// that fills its parent. `children` is the frame itself, which fills the
// device box.
export function ViewportStage({
  choice,
  onGeometry,
  caption,
  children,
}: {
  choice: ViewportChoice;
  // Words before the size in the caption ("View only").
  caption?: string;
  onGeometry?: (geometry: FrameGeometry) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  const preset = presetFor(choice);
  let geometry: FrameGeometry;
  if (!preset || !size) {
    geometry = {
      left: 0,
      top: 0,
      scale: 1,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      label: "Fit to tab",
    };
  } else {
    const width = choice.rotated ? preset.height : preset.width;
    const height = choice.rotated ? preset.width : preset.height;
    const availW = Math.max(1, size.width - STAGE_PAD * 2);
    const availH = Math.max(1, size.height - STAGE_PAD * 2 - CAPTION);
    const scale = Math.min(1, availW / width, availH / height);
    geometry = {
      left: Math.max(STAGE_PAD, (size.width - width * scale) / 2),
      top: STAGE_PAD + CAPTION,
      scale,
      width,
      height,
      label: preset.label,
    };
  }

  const key = `${geometry.left}|${geometry.top}|${geometry.scale}|${geometry.width}|${geometry.height}|${geometry.label}`;
  const lastKey = useRef("");
  useEffect(() => {
    if (key === lastKey.current) return;
    lastKey.current = key;
    onGeometry?.(geometry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div ref={ref} className={`pc-stage${preset ? " device" : ""}`}>
      {preset && (
        <div className="pc-stage-caption" style={{ top: STAGE_PAD }}>
          {caption ? `${caption} · ` : ""}
          {describeViewport(preset.label, geometry.width, geometry.height)}
          {geometry.scale < 1 ? ` · ${Math.round(geometry.scale * 100)}%` : ""}
        </div>
      )}
      <div
        className="pc-device"
        style={
          preset
            ? {
                left: geometry.left,
                top: geometry.top,
                width: geometry.width,
                height: geometry.height,
                transform: geometry.scale < 1 ? `scale(${geometry.scale})` : undefined,
              }
            : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}

// ---- Side by side ----
// The main frame and a second one at another viewport, split by a divider
// you can drag. Until you drag it, the split follows the two widths, so a
// phone beside a desktop gets a narrow pane and both scale about the same;
// a drag holds until either viewport changes, and a double-click on the
// divider goes back to following the widths.

const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.85;

function widthOf(choice: ViewportChoice): number | null {
  const preset = presetFor(choice);
  if (!preset) return null;
  return choice.rotated ? preset.height : preset.width;
}

function autoSplit(main: ViewportChoice, compare: ViewportChoice): number {
  const a = widthOf(main);
  const b = widthOf(compare);
  // "Fit to tab" has no width of its own: give it the larger share.
  if (a === null || b === null) return a === null ? 0.62 : 0.38;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, a / (a + b)));
}

function pairKey(main: ViewportChoice, compare: ViewportChoice): string {
  return `${main.id}:${widthOf(main) ?? "fit"}|${compare.id}:${widthOf(compare) ?? "fit"}`;
}

export function CompareSplit({
  choice,
  main,
  compare,
  onMainGeometry,
  onCompareGeometry,
}: {
  choice: ViewportChoice;
  main: ReactNode;
  // The second frame, or null when not comparing.
  compare: ReactNode | null;
  onMainGeometry?: (geometry: FrameGeometry) => void;
  // In the coordinates of the whole split, like the main one's.
  onCompareGeometry?: (geometry: FrameGeometry | null) => void;
}) {
  const other = compareChoice(choice);
  const rootRef = useRef<HTMLDivElement>(null);
  const comparePaneRef = useRef<HTMLDivElement>(null);
  const pair = other ? pairKey(choice, other) : "";
  // While dragging, the live position; the saved one otherwise.
  const [manual, setManual] = useState<{ pair: string; ratio: number } | null>(null);
  const saved = useSplitRatios();
  const ratio = other
    ? manual && manual.pair === pair
      ? manual.ratio
      : (saved[pair] ?? autoSplit(choice, other))
    : 1;
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!other) onCompareGeometry?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!other]);

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root) return;
    e.preventDefault();
    const rect = root.getBoundingClientRect();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    let last: number | null = null;
    const move = (ev: PointerEvent) => {
      last = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, (ev.clientX - rect.left) / rect.width));
      setManual({ pair, ratio: last });
    };
    const up = () => {
      setDragging(false);
      if (last !== null) saveSplitRatio(pair, last);
      setManual(null);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  return (
    <div ref={rootRef} className={`pc-split${dragging ? " dragging" : ""}`}>
      <div className="pc-split-pane" style={{ flexBasis: `${ratio * 100}%` }}>
        <ViewportStage choice={choice} onGeometry={onMainGeometry}>
          {main}
        </ViewportStage>
      </div>
      {other && compare && (
        <>
          <div
            className="pc-split-divider"
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize; double-click to fit the two widths"
            onPointerDown={startDrag}
            onDoubleClick={() => {
              setManual(null);
              saveSplitRatio(pair, null);
            }}
          />
          <div ref={comparePaneRef} className="pc-split-pane" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
            <ViewportStage
              choice={other}
              caption="Compare"
              onGeometry={(g) => {
                const offset = comparePaneRef.current?.offsetLeft ?? 0;
                onCompareGeometry?.({ ...g, left: g.left + offset });
              }}
            >
              {compare}
            </ViewportStage>
          </div>
        </>
      )}
    </div>
  );
}

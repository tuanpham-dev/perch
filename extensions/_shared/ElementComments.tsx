// The pick -> comment -> queue -> send flow every page preview shares
// (live-preview's HTML files, the ports extension's dev-server and web
// tabs). A viewer produces picks (through the page agent, pageAgent.js) and
// hands each one in as `activePick`; this owns the comment popover, the
// numbered badges, the pending and sent lists, and delivery to an agent pane.
// With a page agent it also keeps badges on their elements as the page
// scrolls, attaches a screenshot to each comment, offers the page's errors,
// and re-checks sent comments once the agent has worked on them. Mirrors
// git-scm's DiffView.tsx pending-comment flow. Styled from the colour theme's
// own button/input tokens (elementComments.css).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import "./elementComments.css";
import Icon from "./Icon";
import { agentWindows, fetchSessions, resolveAgentTargets, sendToAgent } from "./agentTarget";
import { copyText } from "./clipboard";
import { usePageErrors, type PageAgentLink, type PageError, type TrackItem } from "./pageAgentHost";
import { VIEWPORT_PRESETS, describeViewport, type FrameGeometry } from "./viewports";

export interface ElementRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// One element, several (Shift+click), an area (drag) or a run of text.
export type PickKind = "element" | "elements" | "area" | "text";

// Which frame of a side-by-side preview something is in.
export type FrameId = "main" | "compare";

export interface PickedElement {
  kind?: PickKind;
  // The frame it was picked in (side by side); the main one when unset.
  frameId?: FrameId;
  // The page agent's handle on what was picked, while that page lives.
  pickId?: string;
  selector: string;
  selectors?: string[];
  outerHTML: string;
  styles: Record<string, string>;
  rect: ElementRect;
  // The selected words, for a text pick.
  quote?: string;
  // Where in `rect` the user clicked, as fractions of its size: where the
  // comment's badge sits, moving with the element.
  anchor?: { fx: number; fy: number };
}

// A screenshot saved on the server: `path` is what the agent opens, `url`
// what the tab shows.
export interface Screenshot {
  path: string;
  url: string;
}

// A drafted-but-not-yet-sent comment, queued via "Add Comment" and delivered
// together by "Send to Agent" rather than one message per pick.
export interface PendingElementComment extends PickedElement {
  id: string;
  text: string;
  // Which viewport the comment is about, as the agent reads it ("iPhone 15,
  // 393×852", "All viewports"), and the menu value that produced it.
  viewport: string;
  viewportKey: string;
  // The frame the element was picked in. Without a page agent to follow
  // the element, its badge shows only while the preview is at that size.
  frame: FrameGeometry | null;
  shot?: Screenshot | null;
  // The frames it's about: the one picked in, or both when compared side
  // by side; `frame2` is the other frame, and `shot2` its screenshot.
  frames?: FrameId[];
  frame2?: FrameGeometry | null;
  shot2?: Screenshot | null;
  // Why a screenshot couldn't be taken, or why a simpler one stood in, for
  // the list's camera icon.
  shotError?: string;
  shotNote?: string;
  // Added with the popover's screenshot toggle off: none was taken.
  noShot?: boolean;
  // The page it was made on and how the message names it ("on https://…"),
  // for a preview that moves between pages and keeps its comments.
  page?: string;
  where?: string;
}

// A comment the agent has been sent, kept so the fix can be checked.
interface SentComment extends PendingElementComment {
  sentAt: number;
  after?: Screenshot | null;
  check?: "checking" | "done" | "missing" | "failed";
}

const ERRORS_IN_MESSAGE = 30;

function subjectLine(where: string, pc: PendingElementComment): string {
  const viewport = `(viewport: ${pc.viewport})`;
  switch (pc.kind) {
    case "elements":
      return `Elements ${pc.selector} ${where} ${viewport}:`;
    case "area":
      return `An area ${where} containing ${pc.selectors?.length ? pc.selectors.join(", ") : pc.selector} ${viewport}:`;
    case "text":
      return `The text "${pc.quote ?? ""}" in ${pc.selector} ${where} ${viewport}:`;
    default:
      return `Element ${pc.selector} ${where} ${viewport}:`;
  }
}

// `where` reads after the selector: "in index.html", "on https://…".
function buildElementContextBlock(fallbackWhere: string, pc: PendingElementComment): string {
  const where = pc.where ?? fallbackWhere;
  const styleLines = Object.entries(pc.styles)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  const shots = [
    pc.shot ? { at: frameText(pc.frame), path: pc.shot.path } : null,
    pc.shot2 ? { at: frameText(pc.frame2), path: pc.shot2.path } : null,
  ].filter((x): x is { at: string; path: string } => x !== null);
  const shot =
    shots.length === 1
      ? `\nScreenshot at ${shots[0].at}, the subject outlined in pink: ${shots[0].path}`
      : shots.length > 1
        ? `\nScreenshots, the subject outlined in pink:\n${shots.map((x) => `- at ${x.at}: ${x.path}`).join("\n")}`
        : "";
  return `${subjectLine(where, pc)}\n\`\`\`html\n${pc.outerHTML}\n\`\`\`\nComputed styles:\n${styleLines}${shot}\n\n${pc.text}`;
}

// The page's error log as the agent reads it: newest last, repeats folded.
function buildErrorsBlock(where: string, errors: PageError[]): string {
  const folded: { line: string; count: number }[] = [];
  for (const e of errors) {
    const line = `[${e.kind}] ${e.message}${e.source ? ` (${e.source})` : ""}`;
    const last = folded[folded.length - 1];
    if (last && last.line === line) last.count++;
    else folded.push({ line, count: 1 });
  }
  const lines = folded.slice(-ERRORS_IN_MESSAGE).map((f) => `- ${f.line}${f.count > 1 ? ` ×${f.count}` : ""}`);
  return `Errors the page logged ${where}:\n${lines.join("\n")}`;
}

// Joins every pending comment's context block into one message — sent as a
// single review, not one send-keys call per comment (same combining scheme as
// git-scm's DiffView.tsx buildCombinedText).
export function buildCombinedElementText(where: string, pending: PendingElementComment[], errors: PageError[] = []): string {
  const blocks = pending.map((pc) => buildElementContextBlock(where, pc));
  if (errors.length) blocks.push(buildErrorsBlock(where, errors));
  return blocks.join("\n\n---\n\n");
}

// Clamps a popover anchored to a picked element's rect so it stays fully
// inside the container and clear of the comments panel — falls back to
// placing it above the element when there isn't room below.
function clampPopoverPosition(
  container: HTMLElement,
  popover: HTMLElement,
  anchor: ElementRect,
): { left: number; top: number } {
  const gap = 4;
  const edge = 8;
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const pw = popover.offsetWidth;
  const ph = popover.offsetHeight;
  const footer = container.querySelector<HTMLElement>(":scope > .pc-panel");
  const reservedBottom = footer ? footer.offsetHeight : 0;
  const below = anchor.top + anchor.height + gap;
  const above = anchor.top - ph - gap;
  const maxTop = ch - reservedBottom - ph - edge;
  const top = below <= maxTop ? Math.max(edge, below) : Math.max(edge, Math.min(above, maxTop));
  const left = Math.min(Math.max(anchor.left, edge), Math.max(edge, cw - pw - edge));
  return { left, top };
}

// Renders the popover once at its naive "below the element" position (so it
// has a real size to measure), then corrects it before paint.
function usePopoverPosition(containerRef: RefObject<HTMLElement | null>, anchor: ElementRect | null) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [corrected, setCorrected] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const popover = popoverRef.current;
    if (!anchor || !container || !popover) {
      setCorrected(null);
      return;
    }
    const clamp = () => setCorrected(clampPopoverPosition(container, popover, anchor));
    clamp();
    // Re-clamp when the popover's own size changes (typing wraps a line, the
    // textarea's resize handle is dragged), not only once at open time.
    const observer = new ResizeObserver(clamp);
    observer.observe(popover);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor?.left, anchor?.top, anchor?.width, anchor?.height]);

  const fallback = anchor ? { left: anchor.left, top: anchor.top + anchor.height + 4 } : { left: 0, top: 0 };
  return { popoverRef, pos: corrected ?? fallback };
}

function CommentTextarea({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  placeholder?: string;
}) {
  return (
    <textarea
      autoFocus
      className="pc-textarea"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onSubmit();
        }
      }}
    />
  );
}

// The viewport choices a comment offers: the size it was picked at, every
// size, or one preset (a problem seen at desktop width that's about phones).
const PICKED = "picked";
const ALL = "all";
// The default: a person often can't tell whether what they see is a phone
// problem or an everywhere problem, and the agent can check both.
const UNSURE = "unsure";
// Side by side: about both frames at once.
const BOTH = "both";

function viewportText(key: string, picked: string): string {
  if (key === ALL) return "All viewports";
  if (key === UNSURE) return `seen at ${picked}; may apply to other viewports too`;
  const preset = VIEWPORT_PRESETS.find((p) => p.id === key);
  return preset ? describeViewport(preset.label, preset.width, preset.height) : picked;
}

function ViewportSelect({
  value,
  picked,
  both,
  onChange,
}: {
  value: string;
  picked: string;
  // "iPhone 15, 393×852 and Desktop, 1440×900", when two frames are shown.
  both?: string | null;
  onChange: (key: string) => void;
}) {
  return (
    <div className="pc-viewport">
      <span className="pc-viewport-label">Viewport</span>
      <select className="pc-select" aria-label="Viewport" value={value} onChange={(e) => onChange(e.target.value)}>
        {both && <option value={BOTH}>Both side by side</option>}
        <option value={UNSURE}>Not sure (this one or all)</option>
        <option value={PICKED}>{picked} (current)</option>
        <option value={ALL}>All viewports</option>
        {VIEWPORT_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {describeViewport(p.label, p.width, p.height)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="icon-button pc-viewport-current"
        title={`Use the current viewport: ${picked}`}
        aria-label="Use the current viewport"
        disabled={value === PICKED}
        onClick={() => onChange(PICKED)}
      >
        <Icon name="target" />
      </button>
    </div>
  );
}

function frameKey(frame: FrameGeometry | null | undefined): string {
  return frame ? `${frame.label}|${frame.width}|${frame.height}` : "";
}

function frameText(frame: FrameGeometry | null | undefined): string {
  return frame ? describeViewport(frame.label, frame.width, frame.height) : "As previewed";
}

// A rect in the frame's own viewport, in the container's coordinates.
function toContainer(rect: ElementRect, frame: FrameGeometry | null | undefined): ElementRect {
  if (!frame) return rect;
  return {
    left: frame.left + rect.left * frame.scale,
    top: frame.top + rect.top * frame.scale,
    width: rect.width * frame.scale,
    height: rect.height * frame.scale,
  };
}

// The badge's spot in a subject's rect (container coordinates): where the
// user clicked, or for older comments near the top middle.
function badgePoint(rect: ElementRect, anchor: PickedElement["anchor"]): { x: number; y: number } {
  if (anchor) return { x: rect.left + anchor.fx * rect.width, y: rect.top + anchor.fy * rect.height };
  return { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 12) };
}

const BADGE = 20;

// A badge-sized box around a point: what popovers hang under.
function badgeBox(p: { x: number; y: number }): ElementRect {
  return { left: p.x - BADGE / 2, top: p.y - BADGE / 2, width: BADGE, height: BADGE };
}

// The label above a comment: what kind of thing it's about.
function pickLabel(p: PickedElement): string {
  switch (p.kind) {
    case "elements":
      return `${p.selectors?.length ?? 0} elements: ${p.selector}`;
    case "area":
      return p.selectors?.length ? `Area · ${p.selectors.length} element${p.selectors.length === 1 ? "" : "s"}` : "Area";
    case "text":
      return `Text in ${p.selector}`;
    default:
      return p.selector;
  }
}

function framesOf(pc: PendingElementComment): FrameId[] {
  return pc.frames ?? [pc.frameId ?? "main"];
}

function trackItem(pc: PendingElementComment, withPick = true): TrackItem {
  return { id: pc.id, pickId: withPick ? pc.pickId : undefined, selector: pc.selector, selectors: pc.selectors };
}

function newId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// A popover's first line: what it's about, and a button that closes it.
function PopoverHead({ label, title, onClose }: { label: string; title: string; onClose: () => void }) {
  return (
    <div className="pc-popover-head">
      <div className="pc-selector" title={title}>
        {label}
      </div>
      <button type="button" className="pc-popover-close" title="Close" aria-label="Close" onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>
  );
}

// What a preview shows in place of its frame: loading, or why it couldn't
// load. Children are actions (a Retry, an Open in Browser).
export function PreviewStatus({
  title,
  detail,
  error,
  children,
}: {
  title: string;
  detail?: string;
  error?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`pc-status${error ? " error" : ""}`} role={error ? "alert" : "status"}>
      <div className="pc-status-title">{title}</div>
      {detail && <div className="pc-status-detail">{detail}</div>}
      {children && <div className="pc-buttons">{children}</div>}
    </div>
  );
}

// ---- Saved between visits ----
// Comments are kept per preview (a file, a site address) in this browser, so
// a reload, a closed tab or a restart doesn't lose a half-written review.

interface Stored {
  pending: PendingElementComment[];
  sent: SentComment[];
  // The last send: the agent window it went to, and the number of the last
  // agent event (agentStateRoutes.mjs) before it, so only what came after
  // counts. `submitted`: Enter was pressed for the user.
  agentRun?: AgentRun | null;
}

interface AgentRun {
  windowId: string;
  boot?: string;
  seq: number;
  submitted: boolean;
  at: number;
}

// What the agent a preview's comments went to is doing (agentStateRoutes.mjs).
export interface AgentStateReading {
  boot?: string;
  seq: number;
  last: { seq: number; event: string } | null;
  hooks: boolean;
}

type AgentStatus = "starting" | "typed" | "working" | "input" | "done";

// How long a send waits for a first hook event from a window that has never
// sent one, before deciding its agent doesn't report them and showing
// nothing rather than "waiting" forever.
const NO_HOOKS_AFTER_MS = 60_000;

const AGENT_STATUS: Record<AgentStatus, { icon: string; text: string; title: string }> = {
  typed: {
    icon: "keyboard",
    text: "Press Enter in the agent's pane",
    title: "The comments are typed into the agent's prompt; it starts once you press Enter there",
  },
  starting: { icon: "watch", text: "Waiting for the agent…", title: "Sent; the agent hasn't started on it yet" },
  working: { icon: "loading", text: "Agent working…", title: "The agent is working on the comments" },
  input: {
    icon: "bell",
    text: "Agent needs your input",
    title: "The agent asked for permission or a choice; answer it in its pane",
  },
  done: { icon: "pass", text: "Agent finished — check the fixes", title: "The agent's turn ended: Check Fixes to compare" },
};

const STORE_PREFIX = "perch.previewComments:";

// Whether Send to Agent also presses Enter: the panel's own checkbox,
// remembered across previews; until it's first used, the extension's
// sendAutoSubmit setting decides.
const SUBMIT_KEY = "perch.previewComments.submit";

function loadSubmitChoice(): boolean | null {
  try {
    const v = localStorage.getItem(SUBMIT_KEY);
    return v === "true" ? true : v === "false" ? false : null;
  } catch {
    return null;
  }
}

function saveSubmitChoice(value: boolean): void {
  try {
    localStorage.setItem(SUBMIT_KEY, String(value));
  } catch {
    // remembered for this page only
  }
}

// Whether Add Comment takes a screenshot: the popover's toggle, remembered
// across previews, on until it's first turned off.
const SHOT_KEY = "perch.previewComments.screenshot";

function loadShotChoice(): boolean {
  try {
    return localStorage.getItem(SHOT_KEY) !== "false";
  } catch {
    return true;
  }
}

// Told to every open preview (each extension bundles its own copy of this
// module, so a window event rather than module state), so they all follow.
const SHOT_EVENT = "perch-preview-screenshot";

function saveShotChoice(value: boolean): void {
  try {
    localStorage.setItem(SHOT_KEY, String(value));
  } catch {
    // remembered for this page only
  }
  window.dispatchEvent(new CustomEvent(SHOT_EVENT, { detail: value }));
}

function loadStored(key: string | undefined): Stored {
  if (!key) return { pending: [], sent: [] };
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_PREFIX + key) ?? "null") as Partial<Stored> | null;
    const run = parsed?.agentRun;
    return {
      pending: Array.isArray(parsed?.pending) ? parsed.pending : [],
      sent: Array.isArray(parsed?.sent) ? parsed.sent.map((s) => ({ ...s, check: s.check === "checking" ? undefined : s.check })) : [],
      agentRun: run && typeof run.windowId === "string" && typeof run.seq === "number" ? run : null,
    };
  } catch {
    return { pending: [], sent: [] };
  }
}

function saveStored(key: string | undefined, stored: Stored): void {
  if (!key) return;
  try {
    if (!stored.pending.length && !stored.sent.length) localStorage.removeItem(STORE_PREFIX + key);
    else localStorage.setItem(STORE_PREFIX + key, JSON.stringify(stored));
  } catch {
    // storage full or blocked: the comments last for this page
  }
}

// Send, as one split button: the action, and beside it a menu choosing
// whether it also presses Enter in the agent's input.
function SendButton({
  submit,
  busy,
  disabled,
  onSend,
  onChoose,
}: {
  submit: boolean;
  busy: boolean;
  disabled: boolean;
  onSend: () => void;
  onChoose: (submit: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close, true);
    document.addEventListener("keydown", close, true);
    return () => {
      document.removeEventListener("mousedown", close, true);
      document.removeEventListener("keydown", close, true);
    };
  }, [open]);

  const options: { value: boolean; label: string; detail: string }[] = [
    { value: true, label: "Send & Submit", detail: "Press Enter too, so the agent starts right away" },
    { value: false, label: "Send Only", detail: "Leave the comments in its input to review first" },
  ];

  return (
    <div ref={rootRef} className="pc-split-btn">
      <button type="button" className="pc-btn pc-btn-primary pc-split-main" disabled={disabled} onClick={onSend}>
        <Icon name="send" /> {busy ? "Sending…" : submit ? "Send & Submit" : "Send Only"}
      </button>
      <button
        type="button"
        className="pc-btn pc-btn-primary pc-split-arrow"
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose how to send"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="chevron-down" />
      </button>
      {open && (
        <div className="pc-split-menu" role="menu">
          {options.map((o) => (
            <button
              key={o.label}
              type="button"
              role="menuitemradio"
              aria-checked={submit === o.value}
              className={`pc-split-item${submit === o.value ? " checked" : ""}`}
              onClick={() => {
                onChoose(o.value);
                setOpen(false);
              }}
            >
              <span className="pc-split-check">{submit === o.value && <Icon name="check" />}</span>
              <span className="pc-split-text">
                <span className="pc-split-label">{o.label}</span>
                <span className="pc-split-detail">{o.detail}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface ElementCommentsProps {
  // The box the previewed frame fills, positioned: badges and popovers are
  // placed in its coordinates.
  containerRef: RefObject<HTMLElement | null>;
  activePick: PickedElement | null;
  // The pick was turned into a comment or dismissed.
  onPickDone: () => void;
  // Reads after each selector in the agent message: "in index.html".
  where: string;
  readAutoSubmit: () => boolean;
  // The project whose agent receives the comments; null means none is open.
  resolveCwd: () => string | null;
  // Comments are kept per key (a file, a tab) and switch with it.
  storageKey?: string;
  // The page on screen, when the preview moves between pages: a comment's
  // badge shows only on the page it was made on.
  page?: string;
  // Where the frame sits in the container, and the viewport it shows
  // (viewports.tsx's ViewportStage). Without it the frame fills the
  // container 1:1.
  frame?: FrameGeometry | null;
  // The page agent in the frame: live badge positions, screenshots, errors.
  agent?: PageAgentLink | null;
  // Saves a screenshot where the agent can open it (screenshotRoutes.mjs).
  uploadScreenshot?: (dataUrl: string) => Promise<Screenshot>;
  // Reloads the page, for checking fixes against a fresh copy.
  reloadPage?: () => void;
  // Opens another address in the preview (a web preview tab, whose comments
  // can be on several pages), so Check Fixes can visit each page that has
  // sent comments.
  openPage?: (url: string) => void;
  // Reads what agents are doing (agentStateRoutes.mjs), for the panel's
  // "Agent working… / finished" line after a send.
  readAgentState?: (windowId?: string) => Promise<AgentStateReading>;
  // The second frame of a side-by-side preview: its page agent and where it
  // sits, in the container's coordinates like `frame`.
  compare?: { agent: PageAgentLink | null; frame: FrameGeometry | null } | null;
}

export function ElementComments({
  containerRef,
  activePick,
  onPickDone,
  where,
  readAutoSubmit,
  resolveCwd,
  storageKey,
  frame,
  agent,
  uploadScreenshot,
  reloadPage,
  openPage,
  readAgentState,
  page,
  compare,
}: ElementCommentsProps) {
  const [pickComment, setPickComment] = useState("");
  const [pickViewport, setPickViewport] = useState(UNSURE);
  const [editViewport, setEditViewport] = useState(UNSURE);
  // The viewport a pick happened at, fixed when it arrives.
  const [pickFrame, setPickFrame] = useState<FrameGeometry | null>(null);
  const [stored, setStored] = useState<Stored>(() => loadStored(storageKey));
  const { pending, sent } = stored;
  // The latest comments, for work that outlives a render (a send waiting on
  // a screenshot).
  const storedRef = useRef(stored);
  storedRef.current = stored;
  const [view, setView] = useState<"pending" | "sent">("pending");
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [includeErrors, setIncludeErrors] = useState(true);
  const [submit, setSubmit] = useState<boolean>(() => loadSubmitChoice() ?? readAutoSubmit());
  const [withShot, setWithShot] = useState<boolean>(loadShotChoice);
  const toggleShot = useCallback(() => saveShotChoice(!withShot), [withShot]);
  useEffect(() => {
    const onChange = (e: Event) => setWithShot((e as CustomEvent<boolean>).detail);
    window.addEventListener(SHOT_EVENT, onChange);
    return () => window.removeEventListener(SHOT_EVENT, onChange);
  }, []);
  const [showErrors, setShowErrors] = useState(false);
  const [checking, setChecking] = useState(false);
  // Where each pending comment's subject is on the page right now, in the
  // frame's own viewport (from the page agent). null: not on the page.
  const [live, setLive] = useState<Record<FrameId, Record<string, ElementRect | null>>>({ main: {}, compare: {} });
  // Screenshots still being taken, which a send waits for.
  const shots = useRef(new Map<string, Promise<void>>());
  // Clicking a badge toggles a popover with the comment's text and an edit
  // option, mirroring DiffView.tsx's comment-badge treatment (git-scm).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const errors = usePageErrors(agent ?? null);

  // A different preview (another file or site): its own comments.
  const loadedKey = useRef(storageKey);
  useEffect(() => {
    if (loadedKey.current === storageKey) return;
    loadedKey.current = storageKey;
    setStored(loadStored(storageKey));
    setExpandedId(null);
    setEditingId(null);
    setSendError(null);
    setLive({ main: {}, compare: {} });
  }, [storageKey]);

  useEffect(() => {
    if (loadedKey.current === storageKey) saveStored(storageKey, stored);
  }, [stored, storageKey]);

  const setPending = useCallback((fn: (prev: PendingElementComment[]) => PendingElementComment[]) => {
    setStored((prev) => ({ ...prev, pending: fn(prev.pending) }));
  }, []);
  const setSent = useCallback((fn: (prev: SentComment[]) => SentComment[]) => {
    setStored((prev) => ({ ...prev, sent: fn(prev.sent) }));
  }, []);

  // ---- Following the page ----
  const onThisPage = useCallback((pc: PendingElementComment) => !page || !pc.page || pc.page === page, [page]);
  const compareAgent = compare?.agent ?? null;
  const compareFrame = compare?.frame ?? null;
  const agentFor = useCallback((f: FrameId) => (f === "main" ? (agent ?? null) : compareAgent), [agent, compareAgent]);
  const frameFor = useCallback((f: FrameId) => (f === "main" ? (frame ?? null) : compareFrame), [frame, compareFrame]);

  // What a frame's agent follows: the comments it shows, by the pick's own
  // handle where it was picked there, else by selector.
  const itemsFor = useCallback(
    (f: FrameId, list: PendingElementComment[]): TrackItem[] =>
      list
        .filter((pc) => onThisPage(pc) && framesOf(pc).includes(f))
        .map((pc) => trackItem(pc, (pc.frameId ?? "main") === f)),
    [onThisPage],
  );
  const trackKey = pending
    .filter(onThisPage)
    .map((pc) => `${pc.id}:${pc.pickId ?? ""}:${framesOf(pc).join("+")}`)
    .join(",");
  useEffect(() => {
    const offs: (() => void)[] = [];
    for (const f of ["main", "compare"] as FrameId[]) {
      const a = agentFor(f);
      if (!a) continue;
      const send = () => a.track(itemsFor(f, storedRef.current.pending));
      if (a.isReady()) send();
      offs.push(a.on("ready", send));
      offs.push(a.on("reset", () => setLive((prev) => ({ ...prev, [f]: {} }))));
      offs.push(
        a.on("rects", (data) =>
          setLive((prev) => ({ ...prev, [f]: (data.rects as Record<string, ElementRect | null>) ?? {} })),
        ),
      );
    }
    return () => offs.forEach((off) => off());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, compareAgent, trackKey]);

  // A fresh pick starts with an empty comment box.
  // The other frame, as it was when the element was picked (side by side).
  const [otherFrame, setOtherFrame] = useState<FrameGeometry | null>(null);
  useEffect(() => {
    setPickComment("");
    const pickedIn = activePick?.frameId ?? "main";
    const here = frameFor(pickedIn);
    const there = compare ? frameFor(pickedIn === "main" ? "compare" : "main") : null;
    setPickFrame(activePick && here ? { ...here } : null);
    setOtherFrame(activePick && there ? { ...there } : null);
    setPickViewport(activePick && there ? BOTH : UNSURE);
    if (activePick) setSendError(null);
    // The frame as it was when the element was picked, not as it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePick]);

  const pickedText = frameText(pickFrame);
  const bothText = otherFrame ? `${pickedText} and ${frameText(otherFrame)}` : null;

  const cancelPick = useCallback(() => {
    setPickComment("");
    onPickDone();
  }, [onPickDone]);

  // Takes and saves a screenshot for a comment in each frame it's about,
  // then attaches them.
  const takeShot = useCallback(
    (pc: PendingElementComment) => {
      if (!uploadScreenshot) return;
      const pickedIn = pc.frameId ?? "main";
      const jobs = framesOf(pc).map((f) => {
        const a = agentFor(f);
        const key = f === pickedIn ? "shot" : "shot2";
        if (!a) return Promise.resolve();
        return a
          .capture(trackItem(pc, f === pickedIn))
          .then(async ({ dataUrl, note }) => {
            const shot = await uploadScreenshot(dataUrl);
            setPending((prev) =>
              prev.map((p) => (p.id === pc.id ? { ...p, [key]: shot, shotNote: note || p.shotNote } : p)),
            );
          })
          .catch((err: unknown) => {
            const reason = err instanceof Error ? err.message : String(err);
            console.warn(`Perch: couldn't take a screenshot for "${pc.text}":`, reason);
            setPending((prev) => prev.map((p) => (p.id === pc.id ? { ...p, [key]: null, shotError: reason } : p)));
          });
      });
      const job = Promise.all(jobs)
        .then(() => undefined)
        .finally(() => shots.current.delete(pc.id));
      shots.current.set(pc.id, job);
    },
    [agentFor, uploadScreenshot, setPending],
  );

  const addPickComment = useCallback(() => {
    const text = pickComment.trim();
    if (!activePick || !text) return;
    const both = pickViewport === BOTH && !!otherFrame;
    const pickedIn = activePick.frameId ?? "main";
    const comment: PendingElementComment = {
      ...activePick,
      id: newId(),
      text,
      viewport: both && bothText ? bothText : viewportText(pickViewport, pickedText),
      viewportKey: pickViewport,
      frame: pickFrame,
      frames: both ? ["main", "compare"] : [pickedIn],
      frame2: both ? otherFrame : null,
      shot: withShot ? undefined : null,
      shot2: both && withShot ? undefined : null,
      noShot: !withShot || undefined,
      page,
      where,
    };
    setPending((prev) => [...prev, comment]);
    if (withShot) takeShot(comment);
    setPickComment("");
    setView("pending");
    onPickDone();
  }, [activePick, pickComment, pickViewport, pickedText, bothText, pickFrame, otherFrame, onPickDone, setPending, takeShot, withShot, page, where]);

  const removeComment = useCallback(
    (id: string) => {
      setPending((prev) => prev.filter((pc) => pc.id !== id));
      setExpandedId((prev) => (prev === id ? null : prev));
      setEditingId((prev) => (prev === id ? null : prev));
    },
    [setPending],
  );

  // From the list: scroll the page to the comment's subject and open it.
  const reveal = useCallback(
    (pc: PendingElementComment) => {
      if (onThisPage(pc)) {
        const pickedIn = pc.frameId ?? "main";
        for (const f of framesOf(pc)) agentFor(f)?.send("reveal", { item: trackItem(pc, f === pickedIn) });
      }
      setExpandedId(pc.id);
      setEditingId(null);
    },
    [agentFor, onThisPage],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
    setEditingId(null);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditText("");
  }, []);

  const closeExpanded = useCallback(() => {
    cancelEdit();
    setExpandedId(null);
  }, [cancelEdit]);

  // A comment with its viewport choice changed: to or from "both" adds or
  // drops the other frame.
  const withViewport = useCallback(
    (pc: PendingElementComment, key: string): PendingElementComment => {
      const pickedIn = pc.frameId ?? "main";
      if (key === BOTH) {
        const other = pc.frame2 ?? (compare ? frameFor(pickedIn === "main" ? "compare" : "main") : null);
        if (!other) return pc;
        return {
          ...pc,
          viewportKey: BOTH,
          viewport: `${frameText(pc.frame)} and ${frameText(other)}`,
          frames: ["main", "compare"],
          frame2: other,
        };
      }
      return { ...pc, viewportKey: key, viewport: viewportText(key, frameText(pc.frame)), frames: [pickedIn], frame2: null, shot2: null };
    },
    [compare, frameFor],
  );

  const saveEdit = useCallback(() => {
    const text = editText.trim();
    if (editingId === null || !text) return;
    setPending((prev) =>
      prev.map((pc) =>
        pc.id === editingId ? withViewport({ ...pc, text }, editViewport) : pc,
      ),
    );
    setEditingId(null);
    setEditText("");
  }, [editingId, editText, editViewport, setPending, withViewport]);

  const clearPending = useCallback(() => {
    setPending(() => []);
    setExpandedId(null);
    setEditingId(null);
    setEditText("");
  }, [setPending]);

  // The message, once any screenshot still being taken has landed.
  const buildMessage = useCallback(async (): Promise<string> => {
    await Promise.race([
      Promise.all([...shots.current.values()]),
      new Promise((resolve) => window.setTimeout(resolve, 45000)),
    ]);
    return buildCombinedElementText(where, storedRef.current.pending, includeErrors ? errors : []);
  }, [where, includeErrors, errors]);

  // Resolves an agent pane in the active project and delivers every queued
  // comment as one combined message. Several candidates target the first.
  const sendAll = useCallback(async () => {
    if (pending.length === 0) return;
    setSendBusy(true);
    setSendError(null);
    try {
      const cwd = resolveCwd();
      if (!cwd) {
        setSendError("No active project - open a project first.");
        return;
      }
      const text = await buildMessage();
      const [sessions, agents] = await Promise.all([fetchSessions(), resolveAgentTargets()]);
      const targets = agentWindows(sessions, cwd, agents);
      if (targets.length === 0) {
        setSendError("No agent is running in this project - start one first.");
        return;
      }
      const target = targets[0];
      // The last agent event before this send: only what comes after it is
      // the agent working on these comments.
      const baseline =
        readAgentState && target.windowId ? await readAgentState().then((r) => r, () => null) : null;
      await sendToAgent(target.sessionName, text, submit, { windowIndex: target.windowIndex });
      const now = Date.now();
      setStored((prev) => ({
        pending: [],
        sent: [...prev.sent, ...prev.pending.map((pc) => ({ ...pc, sentAt: now }))],
        agentRun:
          target.windowId && baseline
            ? { windowId: target.windowId, boot: baseline.boot, seq: baseline.seq, submitted: submit, at: now }
            : null,
      }));
      setExpandedId(null);
      setEditingId(null);
      setView("sent");
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendBusy(false);
    }
  }, [pending.length, resolveCwd, buildMessage, submit, readAgentState]);

  // ---- The agent's progress ----
  // Polled while there are sent comments, so the panel can say when the
  // agent is done and Check Fixes is worth pressing.
  const agentRun = stored.agentRun ?? null;
  const hasSent = sent.length > 0;
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  useEffect(() => {
    if (!agentRun || !readAgentState || !hasSent) {
      setAgentStatus(null);
      return;
    }
    let cancelled = false;
    const poll = () => {
      if (document.hidden) return;
      readAgentState(agentRun.windowId).then(
        (r) => {
          if (cancelled) return;
          // A server restarted since the send numbers its events afresh.
          const since = r.boot === agentRun.boot ? agentRun.seq : 0;
          const event = r.last && r.last.seq > since ? r.last.event : null;
          if (!r.hooks || (!r.last && Date.now() - agentRun.at > NO_HOOKS_AFTER_MS)) setAgentStatus(null);
          else if (event === "prompt-submit") setAgentStatus("working");
          else if (event === "permission") setAgentStatus("input");
          else if (event === "stop") setAgentStatus("done");
          else setAgentStatus(agentRun.submitted ? "starting" : "typed");
        },
        () => {
          // the server didn't answer this time; the next poll tries again
        },
      );
    };
    poll();
    const id = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [agentRun, readAgentState, hasSent]);

  // With no project open there's no agent to send to; the comments are
  // copied instead, to paste wherever they're wanted.
  const copyAll = useCallback(async () => {
    if (pending.length === 0) return;
    setSendError(null);
    try {
      await copyText(await buildMessage());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setSendError(`Couldn't copy: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [pending.length, buildMessage]);

  // ---- Checking fixes ----
  // Reloads the page and photographs each sent comment's subject again, so
  // the before and after sit side by side. Comments sent from other pages
  // are checked by visiting each in turn, then the preview returns to the
  // page it was on.
  const checkFixes = useCallback(async () => {
    if (!agent || !uploadScreenshot || !reloadPage || sent.length === 0) return;
    const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const startPage = page;
    // The pages to visit, the one in view first. A comment from before pages
    // were recorded belongs to whichever page is in view.
    const groups = new Map<string | undefined, SentComment[]>();
    for (const s of sent) {
      const key = !s.page || !page || s.page === page || !openPage ? startPage : s.page;
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    const order = [...groups.keys()].sort((x, y) => (x === startPage ? -1 : y === startPage ? 1 : 0));
    setChecking(true);
    setSent((prev) => prev.map((s) => ({ ...s, check: "checking" as const, after: undefined })));

    // Loads a page (or reloads this one) and waits until its agent is
    // ready: the old page's agent says "reset" when the new one replaces it.
    const loadThen = async (go: () => void) => {
      const replaced = new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          off();
          reject(new Error("the page didn't load"));
        }, 20000);
        const off = agent.on("reset", () => {
          window.clearTimeout(timer);
          off();
          resolve();
        });
      });
      go();
      await replaced;
      await agent.whenReady();
      // Let the page settle (fonts, late layout) before photographing it.
      await sleep(800);
    };

    const checkGroup = async (list: SentComment[]) => {
      const items = list.filter((s) => framesOf(s).includes("main")).map((s) => trackItem(s, false));
      const onPage = await new Promise<Record<string, ElementRect | null>>((resolve) => {
        const timer = window.setTimeout(() => {
          off();
          resolve({});
        }, 3000);
        const off = agent.on("rects", (data) => {
          window.clearTimeout(timer);
          off();
          resolve((data.rects as Record<string, ElementRect | null>) ?? {});
        });
        agent.track(items);
      });
      for (const item of items) {
        if (!onPage[item.id]) {
          setSent((prev) => prev.map((s) => (s.id === item.id ? { ...s, check: "missing" as const } : s)));
          continue;
        }
        try {
          const after = await uploadScreenshot((await agent.capture(item)).dataUrl);
          setSent((prev) => prev.map((s) => (s.id === item.id ? { ...s, after, check: "done" as const } : s)));
        } catch {
          setSent((prev) => prev.map((s) => (s.id === item.id ? { ...s, check: "failed" as const } : s)));
        }
      }
    };

    let moved = false;
    try {
      for (const key of order) {
        const list = groups.get(key) ?? [];
        try {
          if (key === startPage || !key || !openPage) {
            await loadThen(reloadPage);
          } else {
            moved = true;
            await loadThen(() => openPage(key));
          }
          await checkGroup(list);
        } catch {
          const ids = new Set(list.map((s) => s.id));
          setSent((prev) => prev.map((s) => (ids.has(s.id) && s.check === "checking" ? { ...s, check: "failed" as const } : s)));
        }
      }
    } finally {
      setChecking(false);
      if (moved && startPage && openPage) {
        // Back where the check started; its pending comments are followed
        // again once that page's agent is ready.
        openPage(startPage);
      } else {
        agent.track(itemsFor("main", storedRef.current.pending));
      }
    }
  }, [agent, uploadScreenshot, reloadPage, openPage, page, sent, setSent, itemsFor]);

  const markFixed = useCallback((id: string) => setSent((prev) => prev.filter((s) => s.id !== id)), [setSent]);

  // Still wrong: back to the pending list, to say what's still off.
  const reopen = useCallback(
    (s: SentComment) => {
      const { sentAt: _sentAt, after, check: _check, ...rest } = s;
      const reopened: PendingElementComment = { ...rest, id: newId(), pickId: undefined, shot: after ?? rest.shot };
      setStored((prev) => ({ pending: [...prev.pending, reopened], sent: prev.sent.filter((x) => x.id !== s.id) }));
      setView("pending");
      setExpandedId(reopened.id);
      setEditingId(reopened.id);
      setEditText(`Still not right: ${rest.text}`);
      setEditViewport(rest.viewportKey);
    },
    [],
  );

  const hasProject = resolveCwd() !== null;
  const expanded = pending.find((pc) => pc.id === expandedId) ?? null;

  // Where a pending comment's badges go now, one per frame it's about, in
  // container coordinates; frames where its subject isn't in view have none.
  const badgeRects = useCallback(
    (pc: PendingElementComment): { f: FrameId; rect: ElementRect }[] => {
      if (!onThisPage(pc)) return [];
      const out: { f: FrameId; rect: ElementRect }[] = [];
      for (const f of framesOf(pc)) {
        const fr = frameFor(f);
        if (agentFor(f)) {
          const r = live[f][pc.id];
          if (!r) continue;
          if (fr && (r.top + r.height < 0 || r.top > fr.height || r.left + r.width < 0 || r.left > fr.width)) continue;
          out.push({ f, rect: toContainer(r, fr) });
        } else if (f === (pc.frameId ?? "main") && frameKey(pc.frame) === frameKey(fr)) {
          // Without an agent the rect from pick time is all there is, and
          // it's only right at the size it was taken at.
          out.push({ f, rect: toContainer(pc.rect, pc.frame) });
        }
      }
      return out;
    },
    [agentFor, frameFor, live, onThisPage],
  );

  // Popovers hang under the badge (or where the badge will be), not under
  // the whole element.
  const pickAnchor = activePick
    ? badgeBox(badgePoint(toContainer(activePick.rect, pickFrame ?? frame), activePick.anchor))
    : null;
  const expandedRect = expanded ? badgeRects(expanded)[0]?.rect ?? toContainer(expanded.rect, expanded.frame) : null;
  const expandedAnchor = expanded && expandedRect ? badgeBox(badgePoint(expandedRect, expanded.anchor)) : null;
  const pickPopover = usePopoverPosition(containerRef, pickAnchor);
  const commentPopover = usePopoverPosition(containerRef, expandedAnchor);
  const errorCount = errors.length;
  const canCheck = !!(agent && uploadScreenshot && reloadPage);
  const shownErrors = useMemo(() => errors.slice(-8).reverse(), [errors]);

  return (
    <>
      {activePick && (
        <div
          ref={pickPopover.popoverRef}
          className="pc-popover"
          style={{ left: pickPopover.pos.left, top: pickPopover.pos.top }}
        >
          <PopoverHead label={pickLabel(activePick)} title={activePick.selector} onClose={cancelPick} />
          {activePick.kind === "text" && activePick.quote && <div className="pc-quote">“{activePick.quote}”</div>}
          <CommentTextarea
            placeholder={
              activePick.kind === "text"
                ? "What should change about this text?"
                : activePick.kind === "area"
                  ? "What should the agent do with this area?"
                  : "What should the agent do with this element?"
            }
            value={pickComment}
            onChange={setPickComment}
            onSubmit={addPickComment}
            onCancel={cancelPick}
          />
          <ViewportSelect value={pickViewport} picked={pickedText} both={bothText} onChange={setPickViewport} />
          <div className="pc-buttons">
            <button type="button" className="pc-btn pc-btn-primary" disabled={!pickComment.trim()} onClick={addPickComment}>
              Add Comment
            </button>
            <button type="button" className="pc-btn pc-btn-secondary" onClick={cancelPick}>
              Cancel
            </button>
            {agent && uploadScreenshot && (
              <button
                type="button"
                className={`pc-hint pc-shot-toggle${withShot ? " on" : ""}`}
                aria-pressed={withShot}
                title={
                  withShot
                    ? "A screenshot of the page is attached to the comment (click to leave it out)"
                    : "No screenshot is attached (click to attach one)"
                }
                onClick={toggleShot}
              >
                <Icon name={withShot ? "device-camera" : "circle-slash"} />
                <span className="pc-hint-text">Screenshot</span>
              </button>
            )}
          </div>
        </div>
      )}
      {pending.flatMap((pc, index) =>
        badgeRects(pc).map(({ f, rect: r }) => {
          const p = badgePoint(r, pc.anchor);
          return (
            <button
              key={`${pc.id}-${f}`}
              type="button"
              className={`pc-badge pc-marker${expandedId === pc.id ? " open" : ""}`}
              style={{ left: p.x, top: p.y }}
              title={pc.text}
              onClick={() => toggleExpanded(pc.id)}
            >
              {index + 1}
            </button>
          );
        }),
      )}
      {expanded && (
        <div
          ref={commentPopover.popoverRef}
          className="pc-popover"
          style={{ left: commentPopover.pos.left, top: commentPopover.pos.top }}
        >
          <PopoverHead label={pickLabel(expanded)} title={expanded.selector} onClose={closeExpanded} />
          {editingId === expanded.id ? (
            <>
              <CommentTextarea value={editText} onChange={setEditText} onSubmit={saveEdit} onCancel={cancelEdit} />
              <ViewportSelect
                value={editViewport}
                picked={frameText(expanded.frame)}
                both={
                  expanded.frame2 || compare
                    ? `${frameText(expanded.frame)} and ${frameText(
                        expanded.frame2 ?? frameFor((expanded.frameId ?? "main") === "main" ? "compare" : "main"),
                      )}`
                    : null
                }
                onChange={setEditViewport}
              />
              <div className="pc-buttons">
                <button type="button" className="pc-btn pc-btn-primary" disabled={!editText.trim()} onClick={saveEdit}>
                  Save
                </button>
                <button type="button" className="pc-btn pc-btn-secondary" onClick={cancelEdit}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              {expanded.kind === "text" && expanded.quote && <div className="pc-quote">“{expanded.quote}”</div>}
              <div className="pc-text">{expanded.text}</div>
              <div className="pc-viewport-note">{expanded.viewport}</div>
              {(expanded.shot || expanded.shot2) && (
                <div className="pc-shots">
                  {[expanded.shot, expanded.shot2].map((shot, i) =>
                    shot ? (
                      <a key={i} className="pc-shot" href={shot.url} target="_blank" rel="noreferrer" title="Open the screenshot">
                        <img src={shot.url} alt="Screenshot of the subject" />
                      </a>
                    ) : null,
                  )}
                </div>
              )}
              <div className="pc-buttons">
                <button
                  type="button"
                  className="pc-btn pc-btn-secondary"
                  onClick={() => {
                    setEditingId(expanded.id);
                    setEditText(expanded.text);
                    setEditViewport(expanded.viewportKey);
                  }}
                >
                  <Icon name="edit" /> Edit
                </button>
                <button type="button" className="pc-btn pc-btn-secondary" onClick={() => removeComment(expanded.id)}>
                  <Icon name="trash" /> Remove
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {(pending.length > 0 || sent.length > 0) && (
        <div className="pc-panel">
          <div className="pc-panel-summary">
            <div className="pc-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={view === "pending"}
                className={`pc-tab${view === "pending" ? " active" : ""}`}
                onClick={() => setView("pending")}
              >
                Pending <span className="pc-count">{pending.length}</span>
              </button>
              {sent.length > 0 && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === "sent"}
                  className={`pc-tab${view === "sent" ? " active" : ""}`}
                  onClick={() => setView("sent")}
                >
                  Sent <span className="pc-count">{sent.length}</span>
                </button>
              )}
            </div>
            {agentStatus && (
              <span className={`pc-agent-status ${agentStatus}`} role="status" title={AGENT_STATUS[agentStatus].title}>
                <Icon
                  name={AGENT_STATUS[agentStatus].icon}
                  className={agentStatus === "working" ? "codicon-modifier-spin" : undefined}
                />
                <span className="pc-agent-status-text">{AGENT_STATUS[agentStatus].text}</span>
              </span>
            )}
            <span className="pc-spacer" />
            {view === "pending" ? (
              <>
                {hasProject ? (
                  <SendButton
                    submit={submit}
                    busy={sendBusy}
                    disabled={sendBusy || pending.length === 0}
                    onSend={() => void sendAll()}
                    onChoose={(value) => {
                      setSubmit(value);
                      saveSubmitChoice(value);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="pc-btn pc-btn-primary"
                    disabled={pending.length === 0}
                    title="No project is open, so there's no agent to send to. Copies the comments to paste anywhere."
                    onClick={() => void copyAll()}
                  >
                    <Icon name={copied ? "check" : "copy"} /> {copied ? "Copied" : "Copy"}
                  </button>
                )}
                <button
                  type="button"
                  className="pc-btn pc-btn-secondary"
                  disabled={sendBusy || pending.length === 0}
                  onClick={clearPending}
                >
                  Clear
                </button>
              </>
            ) : (
              <>
                {canCheck && (
                  <button
                    type="button"
                    className={`pc-btn pc-btn-primary${agentStatus === "done" && !checking ? " pc-ready" : ""}`}
                    disabled={checking}
                    title="Reload the page and photograph each comment's subject again"
                    onClick={() => void checkFixes()}
                  >
                    <Icon name={checking ? "loading" : "eye"} className={checking ? "codicon-modifier-spin" : undefined} />{" "}
                    {checking ? "Checking…" : "Check Fixes"}
                  </button>
                )}
                <button type="button" className="pc-btn pc-btn-secondary" disabled={checking} onClick={() => setSent(() => [])}>
                  Clear
                </button>
              </>
            )}
          </div>
          {sendError && <div className="pc-panel-error">{sendError}</div>}
          {view === "pending" && errorCount > 0 && (
            <div className="pc-errors">
              <label className="pc-errors-toggle">
                <input type="checkbox" checked={includeErrors} onChange={(e) => setIncludeErrors(e.target.checked)} />
                Include {errorCount} page error{errorCount === 1 ? "" : "s"}
              </label>
              <button type="button" className="pc-link" onClick={() => setShowErrors((v) => !v)}>
                {showErrors ? "Hide" : "Show"}
              </button>
              {showErrors && (
                <ul className="pc-errors-list">
                  {shownErrors.map((e, i) => (
                    <li key={`${e.time}-${i}`} title={e.source}>
                      <span className={`pc-error-kind ${e.kind}`}>{e.kind}</span> {e.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {view === "pending" ? (
            <ul className="pc-panel-list">
              {pending.map((pc, index) => (
                <li
                  key={pc.id}
                  className={`pc-panel-item${expandedId === pc.id ? " selected" : ""}`}
                  title={onThisPage(pc) ? "Show on the page" : `Made on ${pc.page ?? "another page"}`}
                  onClick={() => reveal(pc)}
                >
                  <button type="button" className="pc-badge" onClick={() => reveal(pc)}>
                    {index + 1}
                  </button>
                  <span className="pc-panel-selector" title={pc.selector}>
                    {pickLabel(pc)}
                  </span>
                  <span className="pc-panel-text" title={pc.text}>
                    {pc.text}
                  </span>
                  <span className="pc-panel-viewport" title={pc.viewport}>
                    {pc.viewport}
                  </span>
                  {agent && uploadScreenshot && !pc.noShot && (() => {
                    const both = framesOf(pc).length > 1;
                    const taking = pc.shot === undefined || (both && pc.shot2 === undefined);
                    const got = [pc.shot, both ? pc.shot2 : undefined].filter(Boolean).length;
                    return (
                      <span
                        className="pc-shot-state"
                        title={
                          taking
                            ? "Taking a screenshot…"
                            : got === 0
                              ? `Couldn't take a screenshot: ${pc.shotError ?? "unknown reason"}`
                              : `${got === 2 ? "Screenshots of both viewports attached" : "Screenshot attached"}${
                                  pc.shotNote ? ` (${pc.shotNote})` : ""
                                }`
                        }
                      >
                        <Icon
                          name={taking ? "loading" : got === 0 ? "warning" : "device-camera"}
                          className={taking ? "codicon-modifier-spin" : undefined}
                        />
                        {got === 2 && <span className="pc-shot-count">2</span>}
                      </span>
                    );
                  })()}
                  <button
                    type="button"
                    className="icon-button"
                    title="Remove this comment"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeComment(pc.id);
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="pc-panel-list">
              {sent.map((s) => (
                <li key={s.id} className="pc-sent-item">
                  <div className="pc-sent-head">
                    <span className="pc-panel-selector" title={s.selector}>
                      {pickLabel(s)}
                    </span>
                    <span className="pc-panel-text" title={s.text}>
                      {s.text}
                    </span>
                    <button type="button" className="pc-btn pc-btn-secondary" onClick={() => markFixed(s.id)}>
                      <Icon name="check" /> Fixed
                    </button>
                    <button type="button" className="pc-btn pc-btn-secondary" onClick={() => reopen(s)}>
                      <Icon name="comment" /> Still Wrong
                    </button>
                  </div>
                  {(s.shot || s.after || s.check) && (
                    <div className="pc-compare-shots">
                      <figure>
                        <figcaption>Before</figcaption>
                        {s.shot ? (
                          <a href={s.shot.url} target="_blank" rel="noreferrer">
                            <img src={s.shot.url} alt="Before" />
                          </a>
                        ) : (
                          <div className="pc-shot-empty">No screenshot</div>
                        )}
                      </figure>
                      <figure>
                        <figcaption>After</figcaption>
                        {s.after ? (
                          <a href={s.after.url} target="_blank" rel="noreferrer">
                            <img src={s.after.url} alt="After" />
                          </a>
                        ) : (
                          <div className="pc-shot-empty">
                            {!onThisPage(s) && !openPage
                              ? "Made on another page; open it to check"
                              : s.check === "checking"
                              ? "Checking…"
                              : s.check === "missing"
                                ? "Not on the page any more"
                                : s.check === "failed"
                                  ? "Couldn't take a screenshot"
                                  : canCheck
                                    ? "Press Check Fixes"
                                    : "—"}
                          </div>
                        )}
                      </figure>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

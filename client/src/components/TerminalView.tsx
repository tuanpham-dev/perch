import { stripTerminalReplies } from "../lib/terminalReplies";
import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { createPathResolver } from "../pathResolver";
import { copyText } from "../clipboard";
import { getContextGetter } from "../contextKeys";
import { GHOSTTY_ENGINE_ID, loadEngine, XTERM_ENGINE_ID } from "../engines";
import {
  clearFocusActiveTerminalHandler,
  extensionTerminalAccessories,
  setFocusActiveTerminalHandler,
  useExtensionRegistryVersion,
  type TerminalAccessoryContext,
  type TerminalCommandEvent,
} from "../extensions";
import {
  isSyntheticSelectStart,
  type HoveredLink,
  type TerminalEngineHandle,
  type TerminalTheme,
} from "../engines/types";
import { bindingMatches, serializeEvent, type Keybinding } from "../keybindings";
import { resolveGitRootDir } from "../hooks/useGitRootDir";
import { LocalEcho, normalizeSpaces, wrapModeForCommand } from "../localEcho";
import { inputDebug } from "../inputDebug";
import type { AppSettings } from "../settings";
import { whenMatches } from "../lib/terminalInput";
import { jumpTarget } from "../lib/promptJump";
import { lineForThumbTop, thumbGeometry } from "../lib/scrollThumb";
import { findMatches, stepMatch, type Match } from "../lib/terminalSearch";
import { unwrapParagraphs } from "../selectionText";
import { rangeAt } from "../touchSelect";
import SearchBar from "./SearchBar";
import TouchSelection from "./TouchSelection";
import {
  encodeSgrMouse,
  focusReport,
  WheelLineAccumulator,
} from "../mouseReports";
import { isOpenGesture, openUrl } from "../terminalLinks";
import type { MenuItem } from "../types";
import { oversizeReason, uploadMaxBytes } from "../upload";

// localEchoWhen gates local echo and image paste/drop uploads. Unlike a touch
// key's `when` (whenMatches: empty = always), an empty value here turns both
// off: matching every program would put the echo overlay over vim/less and
// hijack image pastes in every pane.
function localEchoWhenMatches(when: string, command: string): boolean {
  return when.trim() !== "" && whenMatches(when, command);
}

// Expands the pasteDropUploadDir setting for one upload: {cwd} is the pane's
// working directory, {gitroot} the git repo root containing it (the repo-less
// fallback to cwd itself comes from the /api/fs/git-root endpoint). Brace
// syntax matches the touch-keys extension's {esc}/{ctrl} send tokens. Empty
// keeps the original behavior, {cwd}/uploads. The git lookup only runs when
// the token is actually present — a literal path stays a single sync step.
async function resolveUploadDir(setting: string, cwd: string): Promise<string> {
  if (!setting) return `${cwd}/uploads`;
  let dir = setting.replaceAll("{cwd}", cwd);
  if (dir.includes("{gitroot}")) {
    dir = dir.replaceAll("{gitroot}", await resolveGitRootDir(cwd));
  }
  return dir;
}

// A single onData call is either a plain-text/IME burst or one full control
// sequence (an escape code, a lone control byte) — never a mix — so this
// only needs to check "any control byte present", not tokenize per-key.
function isPrintableBurst(data: string): boolean {
  return data.length > 0 && !/[\x00-\x1f\x7f]/.test(data);
}

// Keys that can land the cursor mid-line, where local echo's append-at-end
// model stops holding (see routeLocalEcho's suspension): arrows and Home in
// both CSI and SS3 (application-mode) encodings, readline/Ink's Ctrl+A
// (line start) and Ctrl+B (back one), and Meta+B (back one word). End and
// Ctrl+E are deliberately absent — they land the cursor back at the end of
// the line, where appending is valid again.
const CURSOR_MOVEMENT_KEY = /^(?:\x1b(?:\[|O)[ABDH]|\x01|\x02|\x1b[bB])$/;

// Clipboard images have no filename; the ones dropped from a file manager
// (handled separately, via file.name) do.
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};
function extensionForImageMime(mime: string): string {
  return IMAGE_EXTENSIONS[mime] ?? "png";
}

// A camera/gallery-picked file's own name (e.g. "6996.jpg") is often just a
// short counter reused across photos, not actually unique — prefixing every
// upload with a timestamp (source-named or not) avoids collisions instead of
// relying solely on the server's conflict/rename handling.
function uniqueUploadName(originalName: string | undefined, mime: string, index?: number): string {
  const base = originalName || `image.${extensionForImageMime(mime)}`;
  // A batch upload passes its item index so two files picked/dropped in the
  // same millisecond (or sharing a name) still get distinct destinations.
  const prefix = index === undefined ? `${Date.now()}` : `${Date.now()}-${index}`;
  return `${prefix}-${base}`;
}

type SearchAction = "start" | "next" | "prev" | "cancel";

interface Props {
  attachName: string;
  // Shown at all (its editor group's own active tab) — drives the `hidden`
  // class and refit. A tab can be visible without being focused (a visible
  // tab in a split pane that doesn't currently have app/keyboard focus).
  visible: boolean;
  // Additionally its group has app focus — drives keyboard-focus grabbing
  // and the on-screen touch key bar. Every focused tab is visible, but not
  // every visible tab is focused (plans/vscode-editor-group-splits.md).
  focused: boolean;
  settings: AppSettings;
  // The active extension color theme's terminal palette, or the built-in
  // Plastic Legacy theme if none is selected/loaded — see theme.ts. null
  // while the initial resolution is still in flight on first load
  // (useThemeAssets' themeSettled): the mount effect below builds nothing
  // until it lands, since a theme change afterwards would tear down and
  // rebuild the whole terminal (ghostty can't swap themes at runtime) —
  // the "terminal loads twice on first load" flash.
  theme: TerminalTheme | null;
  // Bumped by utils/fonts.ts whenever an extension-contributed font finishes
  // (or stops) loading — triggers a re-measure below, since a font that
  // arrives after settings.fontFamily was already applied needs a nudge
  // the terminal wouldn't otherwise give it (see that effect's comment).
  fontsVersion: number;
  // Resolved command-id → binding list map (keybindings.ts); the terminal.*
  // entries drive the custom key handler below, so rebinds apply live via a
  // ref.
  bindings: Record<string, Keybinding[]>;
  onExit: () => void;
  onError: (err: unknown) => void;
  // The session this attach follows moved to another window (a session tab
  // follows its session's current window), reported by the server.
  onWindowSwitch?: (windowIndex: number) => void;
  onSessionSwitch?: (session: string, windowIndex: number) => void;
  // Ctrl+click / Ctrl+Shift+click (Cmd+click / Cmd+Shift+click on mac) on a
  // detected file-path link — same primary/secondary pair as QuickSwitcher's
  // Enter/Shift+Enter.
  onOpenFile?: (path: string, line?: number) => void;
  onOpenFileSecondary?: (path: string, line?: number) => void;
  // Opens the app's shared context menu at a screen position — used for the
  // touch long-press menu on a terminal file/URL link (Open / Preview / Copy).
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  // Opens a file in its "preview" viewer (markdown/json/yaml/csv) — the menu's
  // "Preview" item. Only offered when isPreviewable(path) is true.
  onPreviewFile?: (path: string) => void;
  isPreviewable?: (path: string) => boolean;
  // The pane's current working directory (App.tsx's sessions data), the basis
  // for image paste/drop upload destinations (plans/codeman-mobile-
  // features.md Phase 3): it backs the {cwd}/{gitroot} variables in
  // settings.pasteDropUploadDir and the {cwd}/uploads fallback when that
  // setting is empty — "" (window not found yet) just disables the feature
  // for this render, same as an empty localEchoWhen.
  cwd?: string;
}

export default function TerminalView({
  attachName,
  visible,
  focused,
  settings,
  theme,
  fontsVersion,
  bindings,
  onExit,
  onError,
  onWindowSwitch,
  onSessionSwitch,
  onOpenFile,
  onOpenFileSecondary,
  showMenu,
  onPreviewFile,
  isPreviewable,
  cwd,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The engine's open() takes over the element it's given: contenteditable,
  // role=textbox, a beforeinput preventDefault, and container-level key/paste
  // listeners. Those must never wrap the SearchBar/TouchKeyBar/scroll-track
  // (typing in the search box would be blocked by that beforeinput handler
  // and simultaneously leak into the PTY via the key listeners), so the
  // terminal gets this dedicated inner div and the widgets stay siblings.
  const screenRef = useRef<HTMLDivElement>(null);
  // Positioning context for FloatingTouchKeys (touchKeyBarStyle "floating")
  // — the toggle clamps its drag/expand geometry to this element's bounds.
  const terminalBodyRef = useRef<HTMLDivElement>(null);
  const scrollTrackRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<TerminalEngineHandle | null>(null);
  const refitRef = useRef<(() => void) | null>(null);
  // Read from inside the mount effect's long-lived closure (which only ever
  // sees the `visible` value it mounted with), so the scroll-query throttle
  // below can tell whether this terminal is actually on screen right now.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // requestScrollState, exposed so the [visible] effect can fire the one query
  // a revealed tab skipped while it was hidden.
  const scrollQueryRef = useRef<(() => void) | null>(null);
  // Force-repaints a terminal that was just revealed, catching it up on
  // everything that arrived while its paint was suppressed (see the engine's
  // reveal()).
  const revealRef = useRef<(() => void) | null>(null);
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onWindowSwitchRef = useRef(onWindowSwitch);
  onWindowSwitchRef.current = onWindowSwitch;
  const onSessionSwitchRef = useRef(onSessionSwitch);
  onSessionSwitchRef.current = onSessionSwitch;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const onOpenFileSecondaryRef = useRef(onOpenFileSecondary);
  onOpenFileSecondaryRef.current = onOpenFileSecondary;
  const showMenuRef = useRef(showMenu);
  showMenuRef.current = showMenu;
  const onPreviewFileRef = useRef(onPreviewFile);
  onPreviewFileRef.current = onPreviewFile;
  const isPreviewableRef = useRef(isPreviewable);
  isPreviewableRef.current = isPreviewable;
  // Set (by the link provider's onLinkHoverChange, wired in the mount
  // effect below) to the currently-hovered link's own activation call, or
  // null when nothing's hovered. Read from onCapture's mouse-mode
  // interception so a ctrl+click on a link is activated directly and never
  // reaches the program in the terminal (which would e.g. re-trigger nvim's
  // own <C-LeftMouse> tag-jump binding).
  const linkActivateRef = useRef<((e: MouseEvent) => void) | null>(null);
  // What that hovered link points at, when the engine reports it (optional
  // in the seam, so an engine built against the older contract leaves this
  // null and the right-click menu falls back to detecting a link from the
  // visible text under the pointer). Unlike linkActivateRef's opaque
  // callback, this carries the real target — an OSC 8 hyperlink's URI is
  // not its visible text — so a menu can label and copy it.
  const hoveredLinkRef = useRef<HoveredLink | null>(null);
  // True from a swallowed ctrl+mousedown on a hovered link until its
  // matching mouseup — see onCapture's link-interception branch below.
  const linkPressArmedRef = useRef(false);
  // Touch long-press selection (plans/mobile-touch-select-copy-open.md).
  // anchor/head are plain 0-based screen (col,row) cells (row 0 = top of the
  // visible viewport) — the same screen-row-major addressing
  // engine.selectCells/term.select() already use internally, so extending
  // between them needs no "stitching": it naturally spans any number of
  // terminal rows, wrapped-line or not, exactly like the existing desktop
  // drag-selection. Stitching only matters once, at gesture start, to detect
  // the word/link candidate under the initial press (beginTouchSelection).
  // `interacting` is true while the initiating touch is still down and
  // dragging to extend — the toolbar (TouchSelection below) only renders
  // once it settles, so it doesn't fight a live drag.
  const [touchSel, setTouchSel] = useState<{
    anchorCol: number;
    anchorRow: number;
    headCol: number;
    headRow: number;
    open: { kind: "url" | "path"; target: string; line?: number } | null;
    interacting: boolean;
  } | null>(null);
  // Set inside the mount effect (dismissTouchSelection there is the only
  // thing that can clear the engine's own selection alongside React state) —
  // called from the toolbar's Copy/Open button handlers below, which run
  // from a fresh render closure outside that effect. Same ref-forwarding
  // idiom as handleSearchCloseRef.
  const dismissTouchSelectionRef = useRef<() => void>(() => {});
  // Drag-handle bridges (Phase 3, T8) — same ref-forwarding idiom.
  // touchHandleBeginRef normalizes which end is "anchor" (fixed) vs "head"
  // (about to be dragged) once per drag gesture; touchHandleMoveRef is
  // extendTouchSelection itself — plain anchor-to-point range selection
  // needs no special handling for a handle drag, since (unlike the initial
  // candidate detection) it was never limited to one stitched line.
  const touchHandleBeginRef = useRef<(which: "start" | "end") => void>(() => {});
  const touchHandleMoveRef = useRef<(clientX: number, clientY: number) => void>(() => {});
  // Viewport coordinates of the last long-press point — anchors the link
  // context menu (below), which positions via App's showMenu in screen space,
  // not the .terminal-body-relative rects the selection toolbar uses.
  const lastLongPressPtRef = useRef<{ x: number; y: number } | null>(null);
  // True once the link context menu has been opened for the current settled
  // selection, so the effect below fires it exactly once (reset on dismiss).
  const linkMenuOpenedRef = useRef(false);
  // The WS attaches to the name the tab was opened with; a later rename only
  // changes the display title, the existing attachment survives it.
  const attachNameRef = useRef(attachName);
  // One cached path resolver per view, shared by hover links, touch Open and
  // right-click (see pathResolver.ts).
  const resolvePathsRef = useRef(createPathResolver(() => attachNameRef.current));
  const initialSettings = useRef(settings);

  // Scrollback search overlay. sendSearchRef is set inside the mount effect
  // below (where it has closure access to the live `ws`, which is replaced
  // on every reconnect) so these handlers always reach the current socket.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchOpenRef = useRef(false);
  searchOpenRef.current = searchOpen;
  // False whenever the query has changed since the last "start" — the next
  // Enter/Shift+Enter re-starts the search instead of stepping an existing
  // one, matching how most find boxes treat an edited query.
  const searchStartedRef = useRef(false);
  const sendSearchRef = useRef<(action: SearchAction, query?: string) => void>(() => {});

  const handleSearchQueryChange = (q: string) => {
    setSearchQuery(q);
    searchStartedRef.current = false;
  };
  const handleSearchNext = () => {
    if (!searchQuery) return;
    if (searchStartedRef.current) {
      sendSearchRef.current("next");
    } else {
      sendSearchRef.current("start", searchQuery);
      searchStartedRef.current = true;
    }
  };
  const handleSearchPrev = () => {
    if (!searchQuery) return;
    if (searchStartedRef.current) {
      sendSearchRef.current("prev");
    } else {
      sendSearchRef.current("start", searchQuery);
      searchStartedRef.current = true;
    }
  };
  const handleSearchClose = () => {
    sendSearchRef.current("cancel");
    setSearchOpen(false);
    setSearchQuery("");
    searchStartedRef.current = false;
    requestAnimationFrame(() => engineRef.current?.focus());
  };
  // Referenced from inside the mount effect's key handler (Ctrl+Shift+F
  // toggle-close), which only runs once and can't see this render's
  // closure directly — same ref-forwarding pattern as onExitRef above.
  const handleSearchCloseRef = useRef(handleSearchClose);
  handleSearchCloseRef.current = handleSearchClose;

  // Touch key bar: onscreen keys a mobile keyboard can't send (Esc, Tab,
  // arrows, Ctrl+C) plus sticky Ctrl for the next character typed. The
  // sendInput/stickyCtrl refs are read from inside the engine's onData in
  // the mount effect below, which needs the always-current values without
  // re-running.
  // "auto" requires hover: none on top of pointer: coarse so it means real
  // mobile devices (phones/tablets) — a touch-screen laptop's primary input
  // still hovers, and its hardware keyboard makes the bar pure noise there.
  // The bare pointer:coarse checks elsewhere in this file (focus-grab
  // suppression) intentionally keep the looser meaning.
  const MOBILE_MQ = "(pointer: coarse) and (hover: none)";
  const [mobilePointer, setMobilePointer] = useState(
    () => window.matchMedia(MOBILE_MQ).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const onChange = () => setMobilePointer(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  // "auto" reuses the same mobile predicate as the touch key bar — xterm on
  // real phones/tablets (mature native IME/soft-keyboard handling), ghostty
  // everywhere else. Any other value is a namespaced extension engine id
  // (see engines/index.ts), resolved against the registry after extensions
  // settle; unknown ids fall back to the required xterm engine there.
  const resolvedEngine: string =
    settings.terminalEngine === "auto"
      ? mobilePointer
        ? XTERM_ENGINE_ID
        : GHOSTTY_ENGINE_ID
      : settings.terminalEngine;
  // True when engine resolution came back empty (corrupt/incomplete
  // install — xterm-engine is a required builtin, so this is never a
  // reachable user configuration). Rendered as an explicit message rather
  // than a silent blank terminal.
  const [engineMissing, setEngineMissing] = useState(false);
  // Latest soft-keyboard-suppression request from a terminal accessory
  // (see TerminalAccessoryContext.setSoftKeyboardSuppressed) — held in a
  // ref so it survives engine remounts (engine-setting change, reconnect)
  // and is re-applied to each new engine instance below.
  const softKeyboardSuppressedRef = useRef(false);
  const [stickyCtrl, setStickyCtrl] = useState(false);
  const stickyCtrlRef = useRef(false);
  stickyCtrlRef.current = stickyCtrl;
  const sendInputRef = useRef<(data: string) => void>(() => {});
  // Backs the long-press "Paste" menu — set below to pasteFromClipboard so the
  // touch handler (created once in the mount effect) always calls the current
  // one.
  const pasteFromClipboardRef = useRef<() => void>(() => {});
  // Copies the current selection, optionally as one paragraph per block —
  // see copySelectionAs in the render body. Held in a ref so the mount-time
  // key handler and the (later-defined) context menu both reach the live
  // closure.
  const copySelectionAsRef = useRef<(mode: "default" | "paragraph") => void>(() => {});
  // Consulted at event time by the mouse capture layer (a setting read
  // through a mount-time listener must come from a ref, same pattern as
  // pasteDropUploadDirRef).
  const rightClickBehaviorRef = useRef(settings.rightClickBehavior);
  rightClickBehaviorRef.current = settings.rightClickBehavior;
  // Same mount-time-listener-needs-a-ref reason as rightClickBehavior above:
  // read at keystroke time by snapToBottomIfScrolled in the mount effect.
  const snapToBottomRef = useRef(settings.scrollbackSnapToBottom);
  snapToBottomRef.current = settings.scrollbackSnapToBottom;
  // Set by the swallowed right mousedown, consumed by the contextmenu
  // handler that follows it. Non-null means "this contextmenu belongs to a
  // press we kept" — a press that was forwarded to a mouse-aware program
  // leaves it null, so no menu opens on top of that program.
  const rightClickPendingRef = useRef<{ x: number; y: number } | null>(null);
  // Opens the terminal's context menu at a viewport point — see
  // openContextMenuAt in the render body.
  const openContextMenuAtRef = useRef<(clientX: number, clientY: number) => void>(() => {});
  // Voice transcripts (Phase 5) route through this instead — set to the
  // mount effect's sendTextOrEcho, the same local-echo-or-direct fork image
  // paste/drop already uses (Phase 3), so spoken text lands in the buffered
  // overlay when local echo is active instead of going straight to the PTY.
  const sendTextRef = useRef<(text: string) => void>(() => {});
  // A file picked via the `{image}` touch key (plans/mobile-image-upload-key.md)
  // routes through this — set to the mount effect's uploadAndType, the same
  // upload pipeline desktop paste/drop already use.
  const uploadImageRef = useRef<(file: File) => void>(() => {});
  // Multi-file counterpart (pasting several images, dropping several files of
  // any type, and the 📷 key's multi-select) — uploads all and inserts their
  // paths as one no-submit block. Set alongside uploadImageRef in the mount
  // effect.
  const uploadImagesRef = useRef<(files: File[]) => void>(() => {});
  // Pushed by the server's attach watcher (a "command" WS message) whenever
  // this attach's foreground program changes — drives touch keys' `when`
  // filter. "" until the first push arrives.
  const [currentCommand, setCurrentCommand] = useState("");
  // The latest shell-integration lifecycle event for this session (a
  // "commandEvent" WS frame, plans/warp-features.md) — null until one
  // arrives, i.e. forever when shell integration isn't sourced.
  const [lastCommandEvent, setLastCommandEvent] = useState<TerminalCommandEvent | null>(null);
  // Terminal accessories (the extracted touch-key bar & floating keys) —
  // re-render when one registers/unregisters.
  useExtensionRegistryVersion();
  // Read from inside the mount effect's long-lived forwardInput closure,
  // which only ever sees the values it mounted with — same ref-mirroring
  // pattern as bindingsRef/visibleRef above, gating zero-lag local echo.
  const mobilePointerRef = useRef(mobilePointer);
  mobilePointerRef.current = mobilePointer;
  const localEchoWhenRef = useRef(settings.localEchoWhen);
  localEchoWhenRef.current = settings.localEchoWhen;
  const localEchoRef = useRef<LocalEcho | null>(null);
  // Image paste/drop (plans/codeman-mobile-features.md Phase 3) reads these
  // live from inside the same long-lived mount-effect closure.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const uploadConflictRef = useRef(settings.uploadConflict);
  uploadConflictRef.current = settings.uploadConflict;
  const pasteDropUploadDirRef = useRef(settings.pasteDropUploadDir);
  pasteDropUploadDirRef.current = settings.pasteDropUploadDir;
  const uploadMaxSizeRef = useRef(settings.uploadMaxSizeMb);
  uploadMaxSizeRef.current = settings.uploadMaxSizeMb;

  useEffect(() => {
    // Theme still resolving (first load, extension theme JSON in flight) —
    // build nothing yet; the [theme] dep re-runs this once it settles.
    if (!theme) return;
    const container = containerRef.current!;
    const screen = screenRef.current!;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    // Defer setup one frame: StrictMode's dev double-mount disposes the first
    // instance within the same tick, and building a terminal (plus a WS
    // connection) only to dispose it in the same tick is wasted work either
    // way. The rAF is cancelled by that first cleanup, so only the surviving
    // mount ever builds a terminal (and WS connection) at all.
    const raf = requestAnimationFrame(async () => {
      // Belt-and-braces alongside the cancelAnimationFrame in the effect's
      // destructor: a tab opened and closed within the same tick (seen live
      // when the vanished-window sweep raced a just-created window) can
      // reach this frame after unmount already nulled the refs — building a
      // terminal (and a WS) then would throw mid-setup and leak both.
      if (disposed) return;

      // Registry resolution (extension engines load their own bundles) —
      // waits on the extensions-settled gate internally. Re-checked after
      // both awaits — a tab can close (or a fast re-render can re-run this
      // whole effect on an engine change) while either is in flight.
      const create = await loadEngine(resolvedEngine);
      if (disposed) return;
      if (!create) {
        // No engine registered at all — only reachable with a corrupt or
        // incomplete install, since xterm-engine is a required builtin.
        setEngineMissing(true);
        return;
      }
      setEngineMissing(false);

      // Mutable, not const: reconnect() replaces this on every attempt, and
      // every closure below reads it live rather than capturing one socket.
      let ws: WebSocket;
      let reconnectAttempt = 0;
      let reconnectTimer: number | undefined;
      // Half-open detection state (see probeLiveness below): when the last
      // frame arrived, and the deadline for an in-flight liveness probe.
      let lastFrameAt = Date.now();
      let pongTimer: number | undefined;
      const proto = location.protocol === "https:" ? "wss" : "ws";

      // Every path that puts raw bytes on the wire as terminal input
      // ultimately funnels through this. Mouse reports and focus reports
      // call it directly; touch keys go through sendKeyOrEcho (the local-
      // echo fork) below, and the engine's own onData (real typed/pasted/
      // composed input) additionally goes through sticky-Ctrl via
      // forwardInput.
      // False from each (re)connect until the server's "replayed" frame has
      // arrived and the engine has parsed every replayed byte; input meanwhile
      // waits in heldInput (see connect below). What the terminal answers on
      // its own to queries in the replayed history is dropped rather than
      // held: those answers were for a program that is gone, and delivered
      // they land in the shell as typed junk (and garble a resume command).
      let replayDone = false;
      const heldInput: string[] = [];
      const sendInput = (data: string) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (!replayDone) {
          const typed = stripTerminalReplies(data);
          if (typed) heldInput.push(typed);
          return;
        }
        ws.send(JSON.stringify({ type: "input", data }));
      };

      // Assigned once the engine (LocalEcho's adapter) exists below;
      // forwardInput only ever runs from real user input, which can't
      // happen before then — same "mutable, read live" idiom as `ws`.
      let localEcho: LocalEcho | null = null;
      // Mirrors currentCommand React state inside this closure (which the
      // "command" message handler below updates directly, in the same
      // scope) so forwardInput/routeLocalEcho always see the live value —
      // the outer `currentCommand` variable this effect captured at mount
      // time never changes without a remount.
      let liveCommand = "";
      // Set when a cursor-movement key goes through while local echo is
      // active: the buffer's append-at-end model (both the overlay position
      // and the word-boundary flush) is wrong once the cursor sits mid-line,
      // so every key passes straight through to the PTY — correct real echo,
      // per-keystroke round trips — until something establishes a fresh line
      // (Enter submits it, Ctrl+C discards it, a program switch replaces it).
      let echoSuspended = false;

      // Type-ahead local echo (plans/codeman-mobile-features.md, reworked
      // along VS Code's terminal type-ahead — see localEcho.ts's header):
      // every byte is forwarded to the PTY immediately, and LocalEcho only
      // mirrors what was sent so the overlay can cover the round trip.
      // Enter is the one delayed byte: a \r landing within ~80ms of typed
      // text hits Ink's text+Enter same-instant mishandling (T1), so it
      // waits out the remainder of that window — text itself was already
      // sent, so unlike the old buffered model there's nothing else to
      // flush. Backspace forwards the \x7f AND trims the overlay; when
      // the overlay has nothing left to trim it's eating real pre-capture
      // text, so the capture drops and the next keystroke re-reads the
      // cursor. Cursor-movement keys suspend the overlay (its append-at-
      // end model is wrong mid-line) until a fresh line exists — but
      // everything still sends immediately, suspension is display-only.
      let lastPrintableSentAt = 0;
      const sendPrintable = (text: string) => {
        sendInput(text);
        lastPrintableSentAt = performance.now();
      };
      const routeLocalEcho = (data: string, echo: LocalEcho) => {
        inputDebug("data", data);
        if (echoSuspended) {
          if (data === "\r" || data === "\x03") {
            echoSuspended = false;
            // Nothing is tracked while suspended, but the captured start
            // position (LocalEcho.startCol) survives emptying and would
            // otherwise carry a stale column onto the fresh line.
            echo.clear();
          }
          sendInput(data);
          return;
        }
        if (data === "\r") {
          echo.clear();
          const sinceText = performance.now() - lastPrintableSentAt;
          if (sinceText >= 80) sendInput("\r");
          else setTimeout(() => sendInput("\r"), 80 - sinceText);
          return;
        }
        if (data === "\x7f") {
          if (!echo.removeChar()) echo.clear();
          sendInput(data);
          return;
        }
        if (isPrintableBurst(data)) {
          // A burst arriving while a composition preview is live is that
          // composition's commit — strip the prefix that re-commits the
          // already-sent word tail (Gboard recomposition, see
          // LocalEcho.compositionOverlap) before sending.
          const text = echo.consumeCommitOverlap(normalizeSpaces(data));
          if (text !== normalizeSpaces(data)) inputDebug("strip", `${normalizeSpaces(data)} -> ${text}`);
          if (text) {
            echo.appendText(text);
            sendPrintable(text);
            inputDebug("send", text);
          }
          return;
        }
        echo.clear();
        sendInput(data);
        if (CURSOR_MOVEMENT_KEY.test(data)) echoSuspended = true;
      };

      const localEchoActive = () =>
        !!localEcho && mobilePointerRef.current && localEchoWhenMatches(localEchoWhenRef.current, liveCommand);

      // The local-echo fork every raw-byte input path shares. Touch keys
      // route through here too (not sendInput directly): a bar arrow that
      // bypassed the router left the buffer's overlay appending while the
      // real cursor sat mid-line.
      const sendKeyOrEcho = (data: string) => {
        snapToBottomIfScrolled(data);
        if (localEchoActive()) routeLocalEcho(data, localEcho!);
        else sendInput(data);
      };
      sendInputRef.current = sendKeyOrEcho;

      const forwardInput = (data: string) => {
        let toSend = data;
        // Sticky Ctrl from the touch key bar: converts the next single
        // letter typed into its control code (Ctrl+A..Z is ASCII & 0x1f for
        // both cases), then disarms regardless of what was typed — matches
        // how sticky modifiers behave on mobile OS keyboards.
        if (stickyCtrlRef.current) {
          if (data.length === 1 && /[a-zA-Z]/.test(data)) {
            toSend = String.fromCharCode(data.charCodeAt(0) & 0x1f);
          }
          stickyCtrlRef.current = false;
          setStickyCtrl(false);
        }
        sendKeyOrEcho(toSend);
      };

      // Image paste/drop (plans/codeman-mobile-features.md Phase 3): typed
      // through local echo when it's currently active (mobile + matching
      // pane), sent directly otherwise — same fork every other input path
      // in this file uses, just without the sticky-Ctrl/control-byte cases
      // that don't apply to a plain path string.
      const sendTextOrEcho = (text: string) => {
        snapToBottomIfScrolled(text);
        // While suspended (cursor mid-line), direct send is the correct
        // path here too: the PTY inserts at the real cursor and echoes.
        if (!localEchoActive() || echoSuspended) {
          sendInput(text);
          return;
        }
        const normalized = normalizeSpaces(text);
        localEcho!.appendText(normalized);
        sendPrintable(normalized);
      };
      sendTextRef.current = sendTextOrEcho;

      // Gated by localEchoWhen alone (not mobilePointer — desktop paste is
      // the common case for this one) so it works independently of the
      // local-echo feature itself. Destination is settings.pasteDropUploadDir
      // (default /tmp) with {cwd}/{gitroot} expanded per pane — see
      // resolveUploadDir.
      // Size gate shared by every upload path this pane has (paste, drop,
      // and the {image} touch key): an oversized file is reported and
      // skipped rather than streamed to the server. 0 = no limit — see
      // settings.uploadMaxSizeMb.
      const withinUploadLimit = (blob: Blob, displayName: string): boolean => {
        const reason = oversizeReason(blob.size, uploadMaxBytes(uploadMaxSizeRef.current));
        if (!reason) return true;
        onErrorRef.current(`${displayName}: ${reason}`);
        return false;
      };

      const uploadAndType = async (blob: Blob, filename: string) => {
        const destDir = cwdRef.current;
        if (!destDir) return;
        const conflict = uploadConflictRef.current;
        const apiConflict = conflict === "ask" ? "fail" : conflict;
        const uploadDir = await resolveUploadDir(pasteDropUploadDirRef.current, destDir);
        try {
          const result = await api.uploadFile(uploadDir, filename, blob, apiConflict);
          sendTextOrEcho(result.path);
        } catch (err) {
          onErrorRef.current(err);
        }
      };
      // Multi-image: upload all in parallel (keeping order when collecting
      // paths), then insert the resulting paths as one block the user submits
      // with a single Enter. When the pane's program has bracketed-paste mode
      // on (DEC 2004), send a real bracketed paste so a newline-joined block
      // lands without auto-submitting each line; otherwise fall back to a
      // space-separated single line (also no premature submit). A lone image
      // keeps the plain inline path (identical to uploadAndType).
      const uploadAndTypeMany = async (files: { blob: Blob; name: string }[]) => {
        const destDir = cwdRef.current;
        if (!destDir) return;
        const conflict = uploadConflictRef.current;
        const apiConflict = conflict === "ask" ? "fail" : conflict;
        const uploadDir = await resolveUploadDir(pasteDropUploadDirRef.current, destDir);
        const results = await Promise.all(
          files.map((f) =>
            api
              .uploadFile(uploadDir, f.name, f.blob, apiConflict)
              .then((r) => r.path)
              .catch((err) => {
                onErrorRef.current(err);
                return null;
              }),
          ),
        );
        const paths = results.filter((p): p is string => p !== null);
        if (paths.length === 0) return;
        if (paths.length === 1) {
          sendTextOrEcho(paths[0]);
        } else if (engineRef.current?.getMode(2004)) {
          sendInput(`\x1b[200~${paths.join("\n")}\x1b[201~`);
        } else {
          sendTextOrEcho(paths.join(" "));
        }
      };

      uploadImageRef.current = (file) => {
        if (!withinUploadLimit(file, file.name)) return;
        uploadAndType(file, uniqueUploadName(file.name, file.type));
      };
      uploadImagesRef.current = (files) => {
        const allowed = files.filter((f) => withinUploadLimit(f, f.name));
        if (allowed.length === 0) return;
        uploadAndTypeMany(
          allowed.map((f, i) => ({ blob: f, name: uniqueUploadName(f.name, f.type, i) })),
        );
      };

      const engine = await create({
        screen,
        settings: {
          fontFamily: initialSettings.current.fontFamily,
          fontSize: initialSettings.current.fontSize,
          fontWeight: initialSettings.current.fontWeight,
          fontWeightBold: initialSettings.current.fontWeightBold,
          cursorStyle: initialSettings.current.cursorStyle,
          cursorBlink: initialSettings.current.cursorBlink,
          lineHeight: initialSettings.current.lineHeight,
          letterSpacing: initialSettings.current.letterSpacing,
          minimumContrastRatio: initialSettings.current.minimumContrastRatio,
          textThickness: initialSettings.current.textThickness,
          copyJoinWrappedLines: initialSettings.current.copySelection !== "raw",
          copySelection: initialSettings.current.copySelection,
        },
        theme,
        isVisible: () => visibleRef.current,
        // The engine answers capability queries on its own, but the backend
        // is the one answerer (see terminalReplies.ts): its copies are
        // dropped here rather than typed into the shell a moment later.
        onData: (data) => {
          const typed = stripTerminalReplies(data);
          if (typed) forwardInput(typed);
        },
        resolvePaths: (paths, cells) => resolvePathsRef.current(paths, cells),
        onOpenUrl: openUrl,
        onOpenFile: (path, line) => onOpenFileRef.current?.(path, line),
        onOpenFileSecondary: (path, line) => onOpenFileSecondaryRef.current?.(path, line),
        // Only live output may set the clipboard: history replayed on attach
        // holds every copy a program ever made, and re-running them would
        // overwrite whatever the user copied since on each reload.
        onClipboardWrite: (text) => {
          if (replayDone) void copyText(text);
        },
        onLinkHoverChange: (activate, link) => {
          linkActivateRef.current = activate;
          hoveredLinkRef.current = activate ? (link ?? null) : null;
        },
      });
      if (disposed) {
        engine.dispose();
        return;
      }
      engineRef.current = engine;
      // Re-apply an accessory's standing suppression request to this fresh
      // engine instance (the attribute lives on the engine's own textarea,
      // which was just recreated).
      if (softKeyboardSuppressedRef.current) engine.setSoftKeyboardSuppressed?.(true);
      // engine structurally satisfies LocalEchoAdapter (same five T2a
      // methods) — no wrapping needed. Constructed unconditionally and
      // cheaply (one overlay div + one onRender subscription); forwardInput
      // decides per-call whether to actually route through it, so gating
      // (mobile pointer, currentCommand) can change live without a remount.
      localEcho = new LocalEcho(terminalBodyRef.current!, engine);
      // Deletion covers (see LocalEcho.maxCells) must blank stale cells
      // with the terminal theme's own background — the UI --bg fallback
      // can differ from the pane background under extension themes.
      if (theme.background) {
        terminalBodyRef.current!.style.setProperty("--local-echo-cover-bg", theme.background);
      }
      // The "command" handler above keeps this current from here on, but a
      // command message can land before the engine finished loading.
      localEcho.wrapMode = wrapModeForCommand(liveCommand);
      localEchoRef.current = localEcho;

      // Predictive keyboards deliver nothing through onData at all until
      // text commits, so without this, local echo shows nothing for the
      // whole word being typed, not just zero lag on the keystroke — gated
      // by the same localEchoActive() check every other input path already
      // uses, so a composition on a non-matching pane (or desktop) never
      // shows a preview local echo itself wouldn't otherwise be active for.
      // Display-only: the committed text arrives through onData like any
      // other typed burst.
      engine.onComposingChange((text) => {
        inputDebug("comp", text ?? "<end>");
        // No composition preview while suspended either — its commit will
        // arrive through onData and pass straight through to the PTY.
        if (!localEchoActive() || echoSuspended) return;
        if (text === null) localEcho?.clearComposing();
        else localEcho?.setComposing(text);
      });

      // The size last reported on the current connection. Only a change is
      // sent: the backend treats a resize as this view being used (the window
      // reflows to it), and the terminal re-measures for plenty of idle
      // reasons (a settings sync, a reconnect, a phone's address bar).
      let sentSize = "";
      const refit = () => {
        // fit() itself no-ops (returns null) on a disposed/zero-size
        // terminal; a ResizeObserver callback can still fire after cleanup
        // disconnects it.
        const result = engine.fit();
        if (result) {
          // LocalEcho caches cellMetrics at construction time (before this
          // terminal's very first fit ever runs, since refit is defined and
          // called after `new LocalEcho(...)` above) and only otherwise
          // refreshes it on a font change — never on a resize. Left stale,
          // every subsequent refit (rotation, keyboard show/hide, sidebar
          // toggle) silently drifts the overlay's cell size away from the
          // terminal's real one, anchoring buffered text at the wrong
          // pixel row/column even though findAnchor's own row/col math is
          // correct.
          localEcho?.refreshFont();
          const size = `${result.cols}x${result.rows}`;
          if (ws.readyState === WebSocket.OPEN && size !== sentSize) {
            sentSize = size;
            ws.send(JSON.stringify({ type: "resize", cols: result.cols, rows: result.rows }));
          }
        }
      };
      refitRef.current = refit;

      // History lives in the engine's own buffer (the terminal daemon replays a
      // window's output on attach), so the overlay thumb is drawn from the
      // buffer and redrawn whenever the viewport moves or the buffer grows —
      // at most once a frame, however much output arrives.
      const renderThumb = () => {
        const track = scrollTrackRef.current;
        if (!track || !visibleRef.current || document.hidden) return;
        const { viewportY, length, rows } = engine.getScrollState();
        const geometry = thumbGeometry({ total: length, rows, viewportY, trackHeight: track.clientHeight });
        if (!geometry) {
          track.classList.remove("visible");
          return;
        }
        track.classList.add("visible");
        const thumb = track.firstElementChild as HTMLElement;
        thumb.style.height = `${geometry.height}px`;
        thumb.style.top = `${geometry.top}px`;
      };
      let thumbRaf = 0;
      const scheduleThumb = () => {
        if (thumbRaf) return;
        thumbRaf = requestAnimationFrame(() => {
          thumbRaf = 0;
          renderThumb();
        });
      };
      const unsubScrollChange = engine.onScrollChange(scheduleThumb);
      scrollQueryRef.current = scheduleThumb;

      revealRef.current = () => {
        if (disposed) return;
        engine.reveal();
        refitRef.current?.();
        scrollQueryRef.current?.();
      };

      // Keys that move within the scrollback, so they must NOT snap it away:
      // PageUp/PageDown, with or without modifiers (CSI 5~ / 6~, and the
      // CSI 5;<mods>~ form a shifted or ctrl'd press produces).
      const SCROLLBACK_KEY_RE = /^\x1b\[[56](;\d+)?~$/;

      // A normal terminal snaps back to the live tail on the first keypress
      // while you're reading history, and lets the key through. Deliberately
      // NOT routed through here: mouse/wheel/focus reports, which call
      // sendInput directly (a wheel tick is how you scroll in the first
      // place), and this app's own terminal.* keybindings, which the key
      // handler claims before the engine ever emits data — so find, copy and
      // the prompt jumps all stay usable while scrolled.
      const snapToBottomIfScrolled = (data: string) => {
        if (!snapToBottomRef.current || !engine.isScrolledUp()) return;
        if (SCROLLBACK_KEY_RE.test(data)) return;
        engine.scrollToBottom();
      };

      // A close preceded by an "exit" message means the terminal itself is
      // gone (session/window killed) — close the tab. A close
      // with no "exit" first means something broke the pipe underneath
      // (server restart, sleep/wake, network blip) — reconnect instead of
      // losing the tab. Retrying is safe even if the session really did die
      // while disconnected: the next attach attempt gets its own "exit"
      // message immediately and the tab closes then, just delayed.
      let receivedExit = false;

      const connect = () => {
        // Input is held until the server says the replay is done: replayed
        // history can contain capability queries, and a terminal answers
        // those — answers that must not reach the shell as typed keys, and
        // real keystrokes that must not interleave with them.
        replayDone = false;
        // Send the real grid size along so the attach starts at it (see
        // wsAttach.ts): a fresh attach at the default 80x24 would size the
        // window to 80x24 until the post-open resize message lands,
        // reflowing every full-screen TUI twice — after a
        // long disconnect on a slow link that reflow storm left panes
        // visibly garbled. fit() is recomputed per attempt since the layout
        // can change while disconnected (rotation, keyboard); it returns
        // null only when the terminal is hidden/unmeasurable, where the
        // server's 80x24 default plus the onopen refit covers it as before.
        const dims = engine.fit();
        const size = dims ? `&cols=${dims.cols}&rows=${dims.rows}` : "";
        // The theme's colors ride along so the backend can answer color
        // queries (OSC 10/11) for this viewer; a theme change remounts the
        // terminal and so re-attaches with the new ones.
        const colors =
          (theme.foreground ? `&fg=${encodeURIComponent(theme.foreground)}` : "") +
          (theme.background ? `&bg=${encodeURIComponent(theme.background)}` : "");
        ws = new WebSocket(
          `${proto}://${location.host}/ws/attach?session=${encodeURIComponent(attachNameRef.current)}${size}${colors}`,
        );
        // Terminal output rides binary WS frames straight from the PTY (see
        // wsAttach.ts) — everything else stays JSON text. Set per-socket
        // since reconnects create a fresh WebSocket instance.
        ws.binaryType = "arraybuffer";

        ws.onopen = () => {
          reconnectAttempt = 0;
          lastFrameAt = Date.now();
          container.classList.remove("reconnecting");
          sentSize = "";
          refit();
        };

        ws.onmessage = (ev) => {
          // Any frame proves the path is alive — not just a "pong" reply
          // (which otherwise falls through the dispatch below as a no-op).
          lastFrameAt = Date.now();
          if (pongTimer !== undefined) {
            clearTimeout(pongTimer);
            pongTimer = undefined;
          }
          if (ev.data instanceof ArrayBuffer) {
            engine.write(new Uint8Array(ev.data));
            return;
          }
          const msg = JSON.parse(ev.data);
          if (msg.type === "host" && msg.platform === "win32") {
            engine.setWindowsPty?.(Number.isFinite(msg.windowsBuild) ? msg.windowsBuild : 0);
          } else if (msg.type === "replayed") {
            const socket = ws;
            const release = () => {
              if (ws !== socket || replayDone) return;
              replayDone = true;
              for (const data of heldInput.splice(0)) ws.send(JSON.stringify({ type: "input", data }));
            };
            if (engine.whenWritten) engine.whenWritten(release);
            else release();
          } else if (msg.type === "windowSwitched" && Number.isFinite(msg.windowIndex)) {
            onWindowSwitchRef.current?.(msg.windowIndex);
          } else if (
            msg.type === "sessionSwitched" &&
            typeof msg.session === "string" &&
            Number.isFinite(msg.windowIndex)
          ) {
            onSessionSwitchRef.current?.(msg.session, msg.windowIndex);
          } else if (msg.type === "command" && typeof msg.command === "string") {
            // A program switch invalidates any buffered pending text —
            // e.g. exiting claude mid-type would otherwise leave a stale
            // overlay in front of whatever now owns the pane.
            if (msg.command !== liveCommand) {
              localEcho?.clear();
              echoSuspended = false;
            }
            liveCommand = msg.command;
            if (localEcho) localEcho.wrapMode = wrapModeForCommand(msg.command);
            setCurrentCommand(msg.command);
          } else if (
            msg.type === "commandEvent" &&
            typeof msg.pane === "string" &&
            typeof msg.command === "string" &&
            (msg.event === "start" || msg.event === "end")
          ) {
            const event: TerminalCommandEvent = {
              pane: msg.pane,
              sessionName: typeof msg.sessionName === "string" ? msg.sessionName : "",
              event: msg.event,
              command: msg.command,
              cwd: typeof msg.cwd === "string" ? msg.cwd : "",
              exitCode: Number.isFinite(msg.exitCode) ? msg.exitCode : undefined,
              durationMs: Number.isFinite(msg.durationMs) ? msg.durationMs : undefined,
            };
            setLastCommandEvent(event);
            // App-wide relay for non-accessory consumers (see
            // TerminalCommandEvent in extensions.ts).
            window.dispatchEvent(new CustomEvent("perch:command-event", { detail: event }));
          } else if (msg.type === "exit") {
            receivedExit = true;
            ws.close();
          }
        };

        ws.onclose = () => {
          // An unanswered probe's deadline must not outlive this socket —
          // left armed, it would fire against the reconnected one.
          if (pongTimer !== undefined) {
            clearTimeout(pongTimer);
            pongTimer = undefined;
          }
          if (disposed) return;
          if (receivedExit) {
            onExitRef.current();
            return;
          }
          container.classList.add("reconnecting");
          const delay = Math.min(500 * 2 ** reconnectAttempt, 5000);
          reconnectAttempt++;
          reconnectTimer = window.setTimeout(connect, delay);
        };
      };

      connect();

      // Half-open detection (fixes the blank-terminal-after-long-idle bug):
      // a NAT/proxy idle timeout or the OS sleeping mid-connection kills the
      // TCP path without the browser ever firing onclose — readyState stays
      // OPEN, input silently goes nowhere, no output arrives, and the
      // reconnect path above never runs. When the socket has been quiet for
      // a while, send an app-level ping (wsAttach echoes "pong"); a missed
      // deadline force-closes the socket, which *does* fire onclose locally
      // and routes into the normal reconnect path.
      const PING_IDLE_MS = 30_000;
      const PONG_DEADLINE_MS = 5_000;
      const probeLiveness = () => {
        if (ws.readyState !== WebSocket.OPEN || pongTimer !== undefined) return;
        ws.send(JSON.stringify({ type: "ping" }));
        pongTimer = window.setTimeout(() => {
          pongTimer = undefined;
          ws.close();
        }, PONG_DEADLINE_MS);
      };
      const heartbeatTimer = window.setInterval(() => {
        if (Date.now() - lastFrameAt >= PING_IDLE_MS) probeLiveness();
      }, PING_IDLE_MS);
      // Waking from sleep / regaining network is the moment a half-open
      // socket actually gets noticed — probe right away rather than waiting
      // out the next interval tick (throttled while backgrounded anyway).
      const onConnectivityResume = () => {
        if (!document.hidden && Date.now() - lastFrameAt >= PING_IDLE_MS) probeLiveness();
      };
      document.addEventListener("visibilitychange", onConnectivityResume);
      window.addEventListener("online", onConnectivityResume);

      // Scrollback search runs over the buffer in the browser. Enter steps to
      // older matches (the way a terminal search reads back through output),
      // Shift+Enter to newer; a fresh query starts at the newest match.
      let searchMatches: Match[] = [];
      let searchIndex = -1;
      sendSearchRef.current = (action, query) => {
        if (action === "cancel") {
          engine.clearSelection();
          searchMatches = [];
          searchIndex = -1;
          return;
        }
        const read = engine.readBufferLine;
        const select = engine.selectBufferRange;
        if (!read || !select) return;
        if (action === "start") {
          const { length } = engine.getScrollState();
          const lines: string[] = [];
          for (let i = 0; i < length; i++) lines.push(read(i));
          searchMatches = findMatches(lines, query ?? "");
          searchIndex = -1;
        }
        searchIndex = stepMatch(searchIndex, searchMatches.length, action === "prev" ? 1 : -1);
        const match = searchMatches[searchIndex];
        if (match) select(match.column, match.line, match.length);
        else engine.clearSelection();
      };

      // Dragging the thumb, or pressing the bare track, scrolls the buffer
      // directly; the engine's scroll event redraws the thumb.
      const track = scrollTrackRef.current!;
      let dragOffsetPx = 0;
      const lineAtPointer = (clientY: number) => {
        const rect = track.getBoundingClientRect();
        const { length, rows } = engine.getScrollState();
        return lineForThumbTop(clientY - rect.top - dragOffsetPx, { total: length, rows, trackHeight: rect.height });
      };

      // Pointer Events (not mouse-only) so dragging works with touch and pen.
      // Pointer capture keeps events targeting the track even if a finger
      // slides off the narrow hit area.
      const onDragMove = (e: PointerEvent) => engine.scrollToLine(lineAtPointer(e.clientY));
      const onDragEnd = () => {
        document.body.classList.remove("scrollbar-dragging");
        track.removeEventListener("pointermove", onDragMove);
        track.removeEventListener("pointerup", onDragEnd);
        track.removeEventListener("pointercancel", onDragEnd);
      };
      track.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const thumb = track.firstElementChild as HTMLElement;
        const thumbRect = thumb.getBoundingClientRect();
        // Grabbing the thumb keeps it under the same point of the finger;
        // pressing the bare track centres the thumb there.
        dragOffsetPx = e.target === thumb ? e.clientY - thumbRect.top : thumbRect.height / 2;
        engine.scrollToLine(lineAtPointer(e.clientY));
        document.body.classList.add("scrollbar-dragging");
        track.setPointerCapture(e.pointerId);
        track.addEventListener("pointermove", onDragMove);
        track.addEventListener("pointerup", onDragEnd);
        track.addEventListener("pointercancel", onDragEnd);
      });

      // Prompt jumps: the engine records a marker at every OSC 133;A prompt
      // mark the shell integration emits. Without it sourced there are no
      // marks and nothing moves.
      const jumpToPrompt = (direction: 1 | -1) => {
        const lines = engine.promptLines?.();
        if (!lines) return;
        const target = jumpTarget(lines, engine.getScrollState().viewportY, direction);
        if (target !== null) engine.scrollToLine(target);
      };

      // ghostty-web's custom key handler semantics are INVERTED from
      // xterm.js: a truthy return means "handled — preventDefault and skip
      // the terminal's own key encoding", falsy means "process normally".
      // The engine normalizes this to "true = handled" regardless of which
      // engine is live. Only consulted on keydown, but the type guard stays
      // as cheap insurance against that changing. Combos come from the
      // rebindable keybindings map (via bindingsRef so a rebind applies
      // without re-mounting the terminal).
      engine.onKeyEvent((e) => {
        if (e.type !== "keydown") return false;
        // Shift+F10 / the Menu key — the platform keyboard gesture for a
        // context menu, anchored on the cursor cell rather than the pointer.
        // Ahead of serializeEvent's guard below: the Menu key has no
        // rebindable combo of its own, so it would be dropped there.
        if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
          e.preventDefault();
          const rect = screen.getBoundingClientRect();
          const metrics = engine.getCellMetrics();
          const cursor = engine.getCursor();
          openContextMenuAtRef.current(
            rect.left + (cursor.col + 1) * metrics.width,
            rect.top + (cursor.row + 1) * metrics.height,
          );
          return true;
        }
        const combo = serializeEvent(e);
        if (!combo) return false;
        const b = bindingsRef.current;
        const get = getContextGetter(e);
        if (bindingMatches(b["terminal.copy"], combo, get)) {
          e.preventDefault();
          copySelectionAsRef.current("default");
          return true;
        }
        if (bindingMatches(b["terminal.copyAsParagraph"], combo, get)) {
          e.preventDefault();
          copySelectionAsRef.current("paragraph");
          return true;
        }
        if (bindingMatches(b["terminal.find"], combo, get)) {
          e.preventDefault();
          // Toggle: closing here (rather than just opening) needs the
          // ref-forwarded handler since this handler is set up once and
          // can't see later renders' searchOpen value directly.
          if (searchOpenRef.current) handleSearchCloseRef.current();
          else setSearchOpen(true);
          return true;
        }
        if (bindingMatches(b["terminal.newline"], combo, get)) {
          e.preventDefault();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "input", data: "\n" }));
          }
          return true;
        }
        if (bindingMatches(b["terminal.clear"], combo, get)) {
          e.preventDefault();
          engine.clear();
          return true;
        }
        if (bindingMatches(b["terminal.scrollToBottom"], combo, get)) {
          e.preventDefault();
          engine.scrollToBottom();
          return true;
        }
        // Prompt jumps (plans/warp-features.md), see jumpToPrompt above.
        if (bindingMatches(b["terminal.previousCommand"], combo, get)) {
          e.preventDefault();
          jumpToPrompt(-1);
          return true;
        }
        if (bindingMatches(b["terminal.nextCommand"], combo, get)) {
          e.preventDefault();
          jumpToPrompt(1);
          return true;
        }
        return false;
      });

      // When the program in the terminal turns mouse reporting on (vim,
      // htop), the engine sends no mouse reports of its own (its own
      // selection mechanism only ever selects locally), so this layer
      // encodes SGR reports itself (mouseReports.ts) and ships them over the
      // attach socket — the same bytes a native terminal would write. The
      // app's gesture policy: plain click = program click; long-press =
      // program press with live motion; plain drag = LOCAL browser
      // selection; Shift+gesture = forwarded with the shift bit stripped
      // (Shift is this app's "force forward" modifier, not one the program
      // should see); middle/right = press/release directly. Wheel is handled separately below (Shift+wheel keeps
      // meaning horizontal scroll).
      const DRAG_THRESHOLD_PX = 4;
      const LONG_PRESS_MS = 500;

      const tracking = () => engine.getMode(1002) || engine.getMode(1000) || engine.getMode(1003);
      const sendReport = sendInput;
      const cellOf = (e: { clientX: number; clientY: number }) => engine.cellFromPoint(e.clientX, e.clientY);
      // Shift deliberately absent: see the gesture-policy comment above.
      const modsOf = (e: MouseEvent) => ({ alt: e.altKey, ctrl: e.ctrlKey });

      let pending: { startX: number; startY: number; source: MouseEvent } | null = null;
      let longPressTimer: number | undefined;
      // Button currently held-and-reported to the program (long-press or
      // shift/middle/right press). While set, the document-level listeners
      // below stream motion reports and the terminating release — document-
      // level so a release outside the terminal still ends the gesture.
      let heldButton: 0 | 1 | 2 | null = null;
      let lastMotionCell = { col: 0, row: 0 };

      const onHeldMove = (e: MouseEvent) => {
        if (heldButton === null) return;
        e.preventDefault();
        e.stopPropagation();
        // Button-event tracking (1002) / any-event (1003) report motion;
        // plain 1000 reports only press/release. Coalesce to one report per
        // cell crossed — pixel-granular mousemove floods add nothing.
        if (!engine.getMode(1002) && !engine.getMode(1003)) return;
        const { col, row } = cellOf(e);
        if (col === lastMotionCell.col && row === lastMotionCell.row) return;
        lastMotionCell = { col, row };
        sendReport(encodeSgrMouse("motion", heldButton, col, row, modsOf(e)));
      };
      const onHeldUp = (e: MouseEvent) => {
        if (heldButton === null) return;
        e.preventDefault();
        e.stopPropagation();
        lastMotionCell = cellOf(e);
        endHeld();
      };
      const beginHeld = (button: 0 | 1 | 2, source: MouseEvent) => {
        heldButton = button;
        const { col, row } = cellOf(source);
        lastMotionCell = { col, row };
        sendReport(encodeSgrMouse("press", button, col, row, modsOf(source)));
        document.addEventListener("mousemove", onHeldMove, true);
        document.addEventListener("mouseup", onHeldUp, true);
      };
      // Always reports the release (at the last known cell) — a press must
      // never be left dangling in the program, even when the gesture ends
      // abnormally (a new press superseding it, or unmount mid-drag).
      function endHeld() {
        if (heldButton === null) return;
        sendReport(encodeSgrMouse("release", heldButton, lastMotionCell.col, lastMotionCell.row));
        heldButton = null;
        document.removeEventListener("mousemove", onHeldMove, true);
        document.removeEventListener("mouseup", onHeldUp, true);
      }

      const onPendingMove = (e: MouseEvent) => {
        if (!pending) return;
        const dx = e.clientX - pending.startX;
        const dy = e.clientY - pending.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        const source = pending.source;
        endPending();
        // Drag: hand the gesture to the engine's local selection, anchored
        // at the original press point; the ongoing real moves extend it live.
        engine.beginLocalSelection(source.clientX, source.clientY);
      };

      const onPendingUp = (e: MouseEvent) => {
        if (!pending) return;
        const source = pending.source;
        endPending();
        e.preventDefault();
        e.stopPropagation();
        // Click: clear any leftover highlight from a prior local drag (the
        // swallowed mousedown never reached the engine's own selection
        // mechanism, so it had no chance to clear stale selection itself),
        // then report press+release at the press cell so the program gets a
        // normal click.
        engine.clearSelection();
        const { col, row } = cellOf(source);
        const mods = modsOf(source);
        sendReport(encodeSgrMouse("press", 0, col, row, mods));
        sendReport(encodeSgrMouse("release", 0, col, row, mods));
      };

      function endPending() {
        if (!pending) return;
        window.clearTimeout(longPressTimer);
        document.removeEventListener("mousemove", onPendingMove, true);
        document.removeEventListener("mouseup", onPendingUp, true);
        pending = null;
      }

      // Set by the touch handlers below when a swipe-scroll ends: Android
      // synthesizes compatibility mouse events after a touchend it wasn't
      // allowed to cancel (they're often non-cancelable post-scroll), and
      // that ghost mousedown would focus the hidden textarea — popping the
      // on-screen keyboard — through this handler AND the engine's own
      // listener. Swallowing every mouse event in this window kills the
      // whole synthesized burst; real mice are unaffected (nothing sets it
      // without touch).
      let suppressMouseUntil = 0;
      const lastMouse = { x: 0, y: 0 };

      const onCapture = (e: MouseEvent) => {
        if (isSyntheticSelectStart(e)) return;
        if (performance.now() < suppressMouseUntil) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (e.type === "mousemove") {
          lastMouse.x = e.clientX;
          lastMouse.y = e.clientY;
        }

        // Right button, before the link-open branch below so that a
        // ctrl+right-click (the Mac context-menu gesture) opens the menu
        // rather than arming a link open. Whether the press is kept or
        // forwarded to a program that has mouse reporting on is the
        // rightClickBehavior setting's whole job; a kept press is swallowed
        // here and answered by the contextmenu event that follows it.
        if (e.type === "mousedown" && e.button === 2) {
          const mode = rightClickBehaviorRef.current;
          const forwardWanted = tracking() && (mode === "forward" ? !e.shiftKey : e.shiftKey);
          if (!forwardWanted) {
            e.preventDefault();
            e.stopPropagation();
            // The swallowed mousedown would normally be what focuses the
            // engine's hidden textarea — do it ourselves.
            engine.focusInput();
            rightClickPendingRef.current = { x: e.clientX, y: e.clientY };
            return;
          }
        }

        // Ctrl+click / Ctrl+Shift+click (Cmd equivalents on mac) on a
        // hovered link: swallow the whole press-to-release gesture so
        // nothing reaches the program or the engine (a forwarded ctrl+click would
        // e.g. re-trigger nvim's own <C-LeftMouse> tag-jump binding), and
        // activate the link directly on release. Deliberately ahead of the
        // tracking() check: the engine's own unmodified-click activation is
        // suppressed wholesale, making this the only activation path
        // whether or not the program is mouse-reporting.
        if (linkPressArmedRef.current) {
          if (e.type === "mouseup" || e.type === "mousemove") {
            e.preventDefault();
            e.stopPropagation();
          }
          if (e.type === "mouseup") {
            linkPressArmedRef.current = false;
            // Re-check at release time: if the pointer dragged off the
            // link or the modifier was released first, drop the gesture
            // instead of activating (matches a normal link click's
            // cancel-by-drag-away behavior).
            if (isOpenGesture(e) && linkActivateRef.current) linkActivateRef.current(e);
          }
          return;
        }
        if (isOpenGesture(e) && e.type === "mousedown" && linkActivateRef.current) {
          e.preventDefault();
          e.stopPropagation();
          linkPressArmedRef.current = true;
          return;
        }

        // Without mouse tracking, plain gestures fall through to the
        // engine's own local selection — nothing to forward.
        if (!tracking()) return;
        // Moves/releases of in-flight gestures are handled by the document-
        // level pending/held listeners registered on press.
        if (e.type !== "mousedown") return;
        if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
        const button = e.button as 0 | 1 | 2;

        endPending();
        endHeld();
        e.preventDefault();
        e.stopPropagation();
        // The swallowed mousedown would normally be what focuses the
        // engine's hidden textarea — do it ourselves.
        engine.focusInput();

        if (button !== 0 || e.shiftKey) {
          // Middle/right press, or Shift-forced forward: report the press
          // immediately; the held listeners stream motion + release.
          beginHeld(button, e);
          return;
        }

        // Plain left press: click, drag, or long-press — unknown until
        // movement (or its absence) tells. Swallow and decide.
        pending = { startX: e.clientX, startY: e.clientY, source: e };
        document.addEventListener("mousemove", onPendingMove, true);
        document.addEventListener("mouseup", onPendingUp, true);
        longPressTimer = window.setTimeout(() => {
          if (!pending) return;
          const source = pending.source;
          endPending();
          // Held without moving: start a real press now; the held
          // listeners stream the rest live.
          beginHeld(0, source);
        }, LONG_PRESS_MS);
      };
      const capturedMouseEvents = ["mousedown", "mousemove", "mouseup"] as const;
      for (const type of capturedMouseEvents) {
        screen.addEventListener(type, onCapture, true);
      }

      // The engine's own click handler activates any link under the cursor
      // with no modifier gate (and would double-activate after our armed
      // path already ran). All link activation goes through the armed
      // press/release path above instead, so clicks never reach the engine.
      const onClickCapture = (e: MouseEvent) => {
        e.stopPropagation();
      };
      screen.addEventListener("click", onClickCapture, true);

      // Horizontal scroll: there's no horizontal wheel report programs
      // reliably understand, so forwarding one through the terminal would
      // scroll vertically or do nothing. Detect the gesture here and ask the
      // server to deliver <ScrollWheelLeft>/
      // <ScrollWheelRight> straight to nvim over RPC, which handles the
      // actual scrolling itself.
      const HSCROLL_PX_PER_TICK = 50;
      let hScrollPx = 0;
      let hScrollCol = 0;
      let hScrollRow = 0;
      let hScrollRafPending = false;
      const flushHScroll = () => {
        hScrollRafPending = false;
        const ticks = Math.trunc(hScrollPx / HSCROLL_PX_PER_TICK);
        if (ticks === 0) return;
        hScrollPx -= ticks * HSCROLL_PX_PER_TICK;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({ type: "hscroll", amount: ticks, col: hScrollCol, row: hScrollRow }),
          );
        }
      };
      // NOTE the engine's custom wheel handler semantics are INVERTED from
      // xterm.js, same as the key handler above: truthy = "handled, stop".
      // onWheelEvent SETS the one handler (it doesn't stack), so horizontal
      // and vertical handling share this callback.
      const wheelAcc = new WheelLineAccumulator();
      engine.onWheelEvent((e) => {
        // Diagonal trackpad motion (both deltas nonzero, no shift) counts
        // as vertical so ordinary scrolling keeps working normally.
        const horizontal = e.shiftKey ? e.deltaY : e.deltaY === 0 ? e.deltaX : 0;
        if (horizontal !== 0) {
          const rect = container.getBoundingClientRect();
          hScrollCol = Math.min(
            engine.cols - 1,
            Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * engine.cols)),
          );
          hScrollRow = Math.min(
            engine.rows - 1,
            Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * engine.rows)),
          );
          hScrollPx += horizontal;
          if (!hScrollRafPending) {
            hScrollRafPending = true;
            requestAnimationFrame(flushHScroll);
          }
          e.preventDefault();
          return true;
        }

        // Vertical wheel while the program is mouse-reporting: one SGR wheel
        // report per DOM event, gated by xterm.js's line-accumulation math
        // (ported in WheelLineAccumulator) so sub-line trackpad deltas
        // accumulate until a full line's worth arrived instead of each
        // micro-event firing a report. Without tracking, fall through
        // (return false): the engine's own wheel path scrolls the history,
        // or sends arrow keys in the alternate screen.
        if (!tracking()) return false;
        const lines = wheelAcc.linesFor(e, engine.getCharHeight(), engine.rows);
        if (lines !== 0) {
          const { col, row } = cellOf(e);
          sendReport(
            encodeSgrMouse(lines < 0 ? "wheelUp" : "wheelDown", 0, col, row, {
              alt: e.altKey,
              ctrl: e.ctrlKey,
            }),
          );
        }
        e.preventDefault();
        return true;
      });

      // Touch long-press selection (plans/mobile-touch-select-copy-open.md).
      // `activeSel` is the mutable source of truth read/written by every
      // handler below — same "mutable, read live" idiom as `ws`/`liveCommand`
      // above; setActiveSel additionally pushes it into React state so the
      // toolbar (rendered outside this effect) can react. anchor/head are
      // plain 0-based screen (col,row) cells — see the field's declaration
      // comment above for why this needs no "stitching" beyond the initial
      // candidate detection.
      type TouchSel = {
        anchorCol: number;
        anchorRow: number;
        headCol: number;
        headRow: number;
        open: { kind: "url" | "path"; target: string; line?: number } | null;
        interacting: boolean;
      };
      let activeSel: TouchSel | null = null;
      const setActiveSel = (s: TouchSel | null) => {
        activeSel = s;
        setTouchSel(s);
      };
      // Bumped on every new selection; a resolvePaths response whose gen no
      // longer matches belongs to a selection that was already replaced or
      // dismissed, and must not patch stale `open` state onto the current one.
      let touchSelGen = 0;

      const cellFor = (clientX: number, clientY: number) => {
        const c = engine.cellFromPoint(clientX, clientY);
        return { col: c.col - 1, row: c.row - 1 };
      };
      // The engine's own screen-row-major addressing (matches
      // engine.selectCells/term.select()'s linear stride) — comparing two
      // cells' linear position is how selectRange below finds which one
      // comes first in reading order, spanning any number of rows.
      const linearOf = (col: number, row: number) => row * engine.cols + col;

      function dismissTouchSelection() {
        if (!activeSel) return;
        engine.clearSelection();
        setActiveSel(null);
      }
      dismissTouchSelectionRef.current = dismissTouchSelection;

      // Selects the screen-row-major range between two 0-based screen cells
      // (inclusive) — works identically whether both land on the same
      // logical/wrapped line or on completely separate ones, since it's just
      // the engine's own linear addressing, exactly like desktop's existing
      // drag-to-select.
      function selectRange(aCol: number, aRow: number, bCol: number, bRow: number) {
        const aLin = linearOf(aCol, aRow);
        const bLin = linearOf(bCol, bRow);
        const startLin = Math.min(aLin, bLin);
        const endLin = Math.max(aLin, bLin);
        const startCol = startLin % engine.cols;
        const startRow = Math.floor(startLin / engine.cols);
        engine.selectCells(startCol, startRow, endLin - startLin + 1);
      }

      // Returns true when a selection was actually started (a candidate or
      // word was found under the point) — the caller uses this to decide
      // whether the rest of the gesture belongs to the selection or falls
      // through as an ordinary tap. Stitching only matters here, to detect a
      // word/link candidate that may span wrapped rows under the press —
      // everything after this (extend, handle-drag) works in plain screen
      // (col,row) space and never needs it again.
      function beginTouchSelection(clientX: number, clientY: number): boolean {
        const { col, row } = cellFor(clientX, clientY);
        const stitched = engine.readStitchedLine(row);
        if (!stitched) return false;
        const { text, startLine } = stitched;
        const pressIdx = (row - startLine) * engine.cols + col;
        const range = rangeAt(text, pressIdx);
        if (!range) return false;
        // A keyboard already open from earlier typing has nothing closing it
        // here otherwise — same rule the scroll-start branch already applies
        // ("starting a different kind of gesture means dropping focus"),
        // just triggered by a successful long-press instead of a swipe.
        const active = document.activeElement;
        if (active instanceof HTMLElement && screen.contains(active)) active.blur();
        const gen = ++touchSelGen;
        const toRC = (idx: number) => ({ col: idx % engine.cols, row: startLine + Math.floor(idx / engine.cols) });
        const startRC = toRC(range.startIdx);
        const endRC = toRC(range.endIdx - 1);
        selectRange(startRC.col, startRC.row, endRC.col, endRC.row);
        navigator.vibrate?.(10);
        const open: TouchSel["open"] =
          range.candidate?.kind === "url" ? { kind: "url", target: range.candidate.target } : null;
        setActiveSel({
          anchorCol: startRC.col,
          anchorRow: startRC.row,
          headCol: endRC.col,
          headRow: endRC.row,
          open,
          interacting: true,
        });
        if (range.candidate?.kind === "path") {
          const target = range.candidate.target;
          const line = range.candidate.line;
          const cell = startRC.row >= 0 ? { row: startRC.row, col: startRC.col } : null;
          resolvePathsRef.current([target], [cell]).then(([resolved]) => {
            if (touchSelGen !== gen || !activeSel) return;
            if (!resolved) return;
            setActiveSel({ ...activeSel, open: { kind: "path", target: resolved, line } });
          });
        }
        return true;
      }

      // Extends the in-progress selection to a new point, anchored at the
      // gesture's fixed start cell — used both while the initiating finger
      // is still down (live-drag) and, unmodified, as a handle's own drag-move
      // (T8): a handle drag is exactly the same anchor-fixed/point-moves
      // operation, just driven by a different input source.
      function extendTouchSelection(clientX: number, clientY: number) {
        if (!activeSel) return;
        const { col, row } = cellFor(clientX, clientY);
        selectRange(activeSel.anchorCol, activeSel.anchorRow, col, row);
        setActiveSel({ ...activeSel, headCol: col, headRow: row });
      }
      touchHandleMoveRef.current = extendTouchSelection;

      // Drag-handle start (T8): normalizes anchor/head so the OTHER
      // (undragged) end becomes the fixed anchor and the grabbed end becomes
      // the head — done once per drag gesture (not recomputed from a
      // possibly-already-crossed pair on every move), which is what lets
      // extendTouchSelection's plain anchor-fixed/head-moves math handle a
      // handle dragged past its counterpart without losing track of which
      // cell was actually fixed.
      function beginHandleDrag(which: "start" | "end") {
        if (!activeSel) return;
        const aLin = linearOf(activeSel.anchorCol, activeSel.anchorRow);
        const hLin = linearOf(activeSel.headCol, activeSel.headRow);
        const startPoint =
          aLin <= hLin
            ? { col: activeSel.anchorCol, row: activeSel.anchorRow }
            : { col: activeSel.headCol, row: activeSel.headRow };
        const endPoint =
          aLin <= hLin
            ? { col: activeSel.headCol, row: activeSel.headRow }
            : { col: activeSel.anchorCol, row: activeSel.anchorRow };
        const fixed = which === "start" ? endPoint : startPoint;
        const dragged = which === "start" ? startPoint : endPoint;
        setActiveSel({ ...activeSel, anchorCol: fixed.col, anchorRow: fixed.row, headCol: dragged.col, headRow: dragged.row });
      }
      touchHandleBeginRef.current = beginHandleDrag;

      // Dismisses a shown selection if new output redrew over it and wiped
      // the engine's own highlight out from under us (T6).
      const unsubTouchSelRenderCheck = engine.onRender(() => {
        if (activeSel && !engine.getSelection()) dismissTouchSelection();
      });

      // Right-click/long-press context menu would otherwise pop over a
      // touch selection (and during the 700ms ghost-mouse suppression window
      // below); native text-selection UI has no place here either way.
      const onContextMenu = (e: Event) => {
        // The browser's own menu never belongs over a terminal (App.tsx
        // suppresses it app-wide too); this app's menu takes its place.
        e.preventDefault();
        const pending = rightClickPendingRef.current;
        rightClickPendingRef.current = null;
        // A touch long-press (which owns its own link menu), the ghost-mouse
        // window after a swipe, or a press that was forwarded to a
        // mouse-aware program all leave `pending` null — nothing to open.
        if (activeSel || performance.now() < suppressMouseUntil || !pending) return;
        // Paste mode still opens the menu where a menu is the more useful
        // answer: over a link, or with a selection to act on. The link test
        // is the click point's own text (candidateAtPoint), not the engine's
        // hover state — a right-click can land on a link the pointer never
        // hovered over, e.g. straight after focusing the pane elsewhere.
        if (
          rightClickBehaviorRef.current === "paste" &&
          !hoveredLinkRef.current &&
          !candidateAtPointRef.current(pending.x, pending.y) &&
          !engineRef.current?.getSelection()
        ) {
          pasteFromClipboardRef.current();
          return;
        }
        openContextMenuAtRef.current(pending.x, pending.y);
      };
      screen.addEventListener("contextmenu", onContextMenu, true);

      // Touch swipes: the engine's only touch handling (if any) is a
      // canvas touchend that focuses the IME textarea — drags scroll
      // nothing on mobile by default. Convert single-finger swipes into
      // synthetic wheel events dispatched through the engine: they funnel
      // through the custom wheel handler above, so every policy there (SGR
      // reports under tracking, nvim hscroll, the engine's own fallback)
      // applies to touch unchanged. Once a drag crosses the threshold the
      // whole gesture is a scroll, and touchmove is preventDefault()ed to
      // stop browser pan/pull-to-refresh (belt-and-braces with the CSS
      // touch-action: none). Gesture endings are owned entirely by
      // onTouchEnd below.
      const TOUCH_SCROLL_THRESHOLD_PX = 8;
      let touchLast: { x: number; y: number } | null = null;
      let touchScrolling = false;
      // Finger travel not yet turned into whole lines of buffer scroll.
      let touchScrollPx = 0;
      let longPressTouchTimer: number | undefined;
      // True once this press's long-press timer has actually started (or
      // extended) the selection currently shown — onTouchEnd reads this to
      // tell "finalize the selection I just made" apart from "ordinary tap".
      let selectionArmedThisGesture = false;
      // True as soon as the long-press timer fires, regardless of whether
      // beginTouchSelection actually found a word/candidate under the point
      // (whitespace, an edge cell, or any other miss). Without this, a long,
      // stationary hold that fails to find anything selectable fell through
      // to onTouchEnd's plain-tap branch below — touchLast was still set and
      // touchScrolling still false, so wasTap read true, and a hold the user
      // clearly meant as "select" instead silently opened the keyboard.
      let longPressFiredThisGesture = false;
      const cancelLongPressTouch = () => {
        if (longPressTouchTimer !== undefined) {
          window.clearTimeout(longPressTouchTimer);
          longPressTouchTimer = undefined;
        }
      };
      const onTouchStart = (e: TouchEvent) => {
        // Registered non-passive (below) specifically so this can run:
        // touch-action:none already blocks native panning, but nothing short
        // of preventDefault() here blocks the OS's own long-press gesture
        // recognition (text-selection magnifier/callout, native focus of a
        // nearby editable) from firing during a stationary hold — the
        // -webkit-touch-callout/user-select CSS on .terminal-screen covers
        // some of that, but not reliably across every browser/OS, and a
        // long-press meant for our own select gesture has no business
        // triggering any native touch handling at all.
        e.preventDefault();
        cancelLongPressTouch();
        selectionArmedThisGesture = false;
        longPressFiredThisGesture = false;
        if (activeSel) {
          // A fresh touch while a selection is showing dismisses it (T6);
          // this same touch can still become a normal tap, a scroll, or a
          // new long-press selection below.
          dismissTouchSelection();
        }
        if (e.touches.length !== 1) {
          touchLast = null;
          return;
        }
        touchLast = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        touchScrolling = false;
        touchScrollPx = 0;
        const startX = touchLast.x;
        const startY = touchLast.y;
        longPressTouchTimer = window.setTimeout(() => {
          longPressTouchTimer = undefined;
          longPressFiredThisGesture = true;
          lastLongPressPtRef.current = { x: startX, y: startY };
          linkMenuOpenedRef.current = false;
          if (beginTouchSelection(startX, startY)) {
            selectionArmedThisGesture = true;
          } else {
            // No word/link under the press (empty area) — offer Paste, the
            // classic mobile long-press-to-paste gesture on the prompt.
            showMenuRef.current?.(startX, startY, [
              { label: "Paste", onClick: () => pasteFromClipboardRef.current() },
            ]);
          }
        }, LONG_PRESS_MS);
      };
      const onTouchMove = (e: TouchEvent) => {
        if (activeSel) {
          if (e.touches.length !== 1) return;
          const t = e.touches[0];
          e.preventDefault();
          extendTouchSelection(t.clientX, t.clientY);
          return;
        }
        if (!touchLast || e.touches.length !== 1) return;
        const t = e.touches[0];
        const dx = touchLast.x - t.clientX;
        const dy = touchLast.y - t.clientY;
        if (!touchScrolling && Math.hypot(dx, dy) < TOUCH_SCROLL_THRESHOLD_PX) {
          // Sub-threshold jitter during a stationary long-press candidate —
          // preventDefault() here too (same reasoning as touchstart above),
          // so a real finger's inevitable micro-movement never gives native
          // touch handling an opening mid-hold.
          e.preventDefault();
          return;
        }
        if (!touchScrolling) {
          cancelLongPressTouch();
          // Gesture just confirmed as a scroll, not a tap: drop any
          // existing focus. Covers two cases with one rule — the keyboard
          // is currently open (this closes it, matching "scrolling means
          // you're reading, not typing") and the keyboard was already
          // dismissed via the OS back gesture but the hidden input quietly
          // kept DOM focus (nothing left focused for the IME to reopen on
          // this touch). No dependency on guessing keyboard-close timing.
          const active = document.activeElement;
          if (active instanceof HTMLElement && screen.contains(active)) active.blur();
        }
        touchScrolling = true;
        e.preventDefault();
        touchLast = { x: t.clientX, y: t.clientY };
        // Dominant axis only: the wheel handler treats mixed deltas as
        // vertical, which would swallow slightly-diagonal horizontal swipes.
        const [deltaX, deltaY] = Math.abs(dx) > Math.abs(dy) ? [dx, 0] : [0, dy];
        // A vertical swipe with history to read and no program asking for the
        // mouse scrolls the buffer itself, a line per row of finger travel.
        // Everything else (mouse-reporting programs, the alternate screen,
        // horizontal scroll) keeps going through the wheel policy.
        if (deltaY !== 0 && !tracking()) {
          const { viewportY, length, rows } = engine.getScrollState();
          if (length > rows) {
            touchScrollPx += deltaY;
            const cell = engine.getCharHeight();
            const lines = cell > 0 ? Math.trunc(touchScrollPx / cell) : 0;
            if (lines !== 0) {
              touchScrollPx -= lines * cell;
              engine.scrollToLine(viewportY + lines);
            }
            return;
          }
        }
        engine.dispatchSyntheticWheel({
          deltaX,
          deltaY,
          clientX: t.clientX,
          clientY: t.clientY,
          bubbles: true,
          cancelable: true,
        });
      };
      const onTouchEnd = (e: TouchEvent) => {
        cancelLongPressTouch();
        if (selectionArmedThisGesture) {
          // This press is the one that just created/extended the selection
          // now shown: reveal its toolbar (hidden until settled), don't
          // focus, don't treat it as a tap.
          selectionArmedThisGesture = false;
          if (activeSel) setActiveSel({ ...activeSel, interacting: false });
          touchLast = null;
          touchScrolling = false;
          e.stopPropagation();
          if (e.cancelable) e.preventDefault();
          suppressMouseUntil = performance.now() + 700;
          return;
        }
        // Own every gesture ending on the terminal: swallow it before the
        // engine's own touchend (which may focus its textarea and pop the
        // on-screen keyboard) — real devices deliver post-scroll touchends
        // with per-browser cancelable/compat quirks, so suppressing the
        // engine's handler only on scrolls proved unreliable. Focus — the
        // thing that opens the keyboard — is granted here and only here: a
        // completed single-finger tap. Swipes, cancelled gestures, a long
        // hold that missed every selectable candidate, and multi-touch never
        // focus.
        const wasTap = touchLast !== null && !touchScrolling && !longPressFiredThisGesture;
        if (!wasTap) suppressMouseUntil = performance.now() + 700;
        longPressFiredThisGesture = false;
        touchLast = null;
        touchScrolling = false;
        e.stopPropagation();
        if (e.cancelable) e.preventDefault();
        if (wasTap && e.type === "touchend") engine.focusInput();
      };
      screen.addEventListener("touchstart", onTouchStart, { passive: false });
      screen.addEventListener("touchmove", onTouchMove, { passive: false });
      screen.addEventListener("touchend", onTouchEnd, true);
      screen.addEventListener("touchcancel", onTouchEnd, true);

      // Focus in/out reports (mode 1004). focusin/focusout bubble from
      // both focus targets (the screen div via engine.focus(), the hidden
      // textarea via presses); transitions between the two stay inside
      // `screen` and are filtered out via relatedTarget.
      // Using a pane makes it the view its window is sized for, the way tmux's
      // window-size latest treats a click or keypress: focus, a click or a tap
      // tells the backend (typing and a real resize already do).
      const activate = () => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "activate" }));
      };
      const onFocusIn = (e: FocusEvent) => {
        if (e.relatedTarget instanceof Node && screen.contains(e.relatedTarget)) return;
        activate();
        if (engine.getMode(1004)) sendReport(focusReport(true));
      };
      const onFocusOut = (e: FocusEvent) => {
        if (e.relatedTarget instanceof Node && screen.contains(e.relatedTarget)) return;
        if (engine.getMode(1004)) sendReport(focusReport(false));
        localEcho?.clear();
      };
      screen.addEventListener("focusin", onFocusIn);
      screen.addEventListener("focusout", onFocusOut);
      screen.addEventListener("pointerdown", activate, true);

      // Image paste/drop (plans/codeman-mobile-features.md Phase 3): upload
      // to settings.pasteDropUploadDir and type the resulting path. Capture phase on
      // paste, ahead of ghostty-web's own bundled paste handling, so a
      // non-image paste (the common case) is left completely alone — only
      // an image item gets preventDefault/stopPropagation, never a plain
      // text paste.
      const onPaste = (e: ClipboardEvent) => {
        if (!localEchoWhenMatches(localEchoWhenRef.current, liveCommand)) return;
        const items = e.clipboardData?.items;
        if (!items) return;
        const imageItems = Array.from(items).filter((it) => it.type.startsWith("image/"));
        const blobs = imageItems
          .map((it) => ({ blob: it.getAsFile(), type: it.type }))
          .filter((b): b is { blob: File; type: string } => b.blob !== null);
        if (blobs.length === 0) return;
        // preventDefault before the size filter: the paste was unambiguously
        // an image paste, so it must not fall through to the engine as text
        // just because the limit rejected every item.
        e.preventDefault();
        e.stopPropagation();
        const allowed = blobs.filter((b) => withinUploadLimit(b.blob, b.blob.name || "pasted image"));
        if (allowed.length === 0) return;
        if (allowed.length === 1) {
          uploadAndType(allowed[0].blob, uniqueUploadName(undefined, allowed[0].type));
        } else {
          uploadAndTypeMany(allowed.map((b, i) => ({ blob: b.blob, name: uniqueUploadName(undefined, b.type, i) })));
        }
      };
      screen.addEventListener("paste", onPaste, true);

      // Drop targets the whole terminal body (scrollbar/search-bar/touch-key
      // gutters included), not just the screen — anywhere over the pane is a
      // reasonable drop target. dragover must preventDefault too, or the
      // browser never fires drop at all (its default is "reject the drop").
      // Any file type uploads here, unlike onPaste above: a drop carrying
      // files is unambiguously a file drop, whereas intercepting every
      // non-image paste would break ordinary text paste.
      const onDragOver = (e: DragEvent) => {
        if (!localEchoWhenMatches(localEchoWhenRef.current, liveCommand)) return;
        if (!Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === "file")) return;
        e.preventDefault();
      };
      const onDrop = (e: DragEvent) => {
        if (!localEchoWhenMatches(localEchoWhenRef.current, liveCommand)) return;
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length === 0) return;
        e.preventDefault();
        const allowed = files.filter((f) => withinUploadLimit(f, f.name));
        if (allowed.length === 0) return;
        if (allowed.length === 1) {
          uploadAndType(allowed[0], uniqueUploadName(allowed[0].name, allowed[0].type));
        } else {
          uploadAndTypeMany(allowed.map((f, i) => ({ blob: f, name: uniqueUploadName(f.name, f.type, i) })));
        }
      };
      terminalBodyRef.current!.addEventListener("dragover", onDragOver);
      terminalBodyRef.current!.addEventListener("drop", onDrop);

      // Fires when the tab becomes visible again (display:none → block) and on
      // window resizes, so hidden terminals refit as soon as they can measure.
      // Observes the screen div (what fit() measures), not the host: the
      // touch key bar mounting/unmounting resizes only the flex body around
      // the screen, never the host itself.
      //
      // The trailing settle pass exists for mobile keyboard show/hide storms
      // (win/vv observed bouncing 825→425→825→797 within milliseconds):
      // per-step refits have left the canvas mis-scaled — internal buffer at
      // the wrong resolution for its final CSS size, rendering blurry
      // stretched glyphs — until something forced a full re-layout (users
      // had to switch tabs). engine.reveal() is the one public path that
      // re-sizes the canvas to the shimmed metrics AND force-renders, so
      // running it once the storm goes quiet performs that tab-switch reset
      // automatically.
      let settleTimer: number | undefined;
      const observer = new ResizeObserver(() => {
        refit();
        window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(() => {
          if (disposed) return;
          engine.reveal();
          refit();
        }, 350);
      });
      observer.observe(screen);

      // Same coarse-pointer gate as the [focused] effect below: a tab
      // opened by a tap would otherwise mount straight into a focused
      // contenteditable and pop the on-screen keyboard.
      if (focused && !window.matchMedia("(pointer: coarse)").matches) engine.focus();

      // Mobile IME caret reveal shifts the terminal horizontally: during
      // composition the engine re-positions (and widens) its hidden helper
      // textarea at the cursor cell, so with the cursor near the right edge
      // the caret lands outside the viewport, and Chrome reveals it by
      // scrolling every scrollable ancestor — overflow:hidden ones included,
      // which have no scrollbar the user could ever drag back, so the shift
      // sticks. Snap horizontal scroll anywhere in the terminal body's own
      // ancestor/descendant chain straight back; the app's one legitimate
      // horizontal scroller (the touch key bar) is a sibling, never in the
      // chain, and the engine's scrollback viewport only scrolls vertically.
      const onCaretRevealScroll = (ev: Event) => {
        const body = terminalBodyRef.current;
        if (!body) return;
        const target = ev.target instanceof Element ? ev.target : document.scrollingElement;
        if (!target) return;
        if ((body.contains(target) || target.contains(body)) && target.scrollLeft !== 0) {
          target.scrollLeft = 0;
        }
      };
      document.addEventListener("scroll", onCaretRevealScroll, true);

      cleanup = () => {
        clearTimeout(reconnectTimer);
        clearTimeout(pongTimer);
        clearInterval(heartbeatTimer);
        document.removeEventListener("visibilitychange", onConnectivityResume);
        window.removeEventListener("online", onConnectivityResume);
        clearTimeout(settleTimer);
        onDragEnd();
        endPending();
        endHeld();
        cancelLongPressTouch();
        unsubTouchSelRenderCheck();
        for (const type of capturedMouseEvents) {
          screen.removeEventListener(type, onCapture, true);
        }
        screen.removeEventListener("click", onClickCapture, true);
        screen.removeEventListener("contextmenu", onContextMenu, true);
        screen.removeEventListener("touchstart", onTouchStart);
        screen.removeEventListener("touchmove", onTouchMove);
        screen.removeEventListener("touchend", onTouchEnd, true);
        screen.removeEventListener("touchcancel", onTouchEnd, true);
        screen.removeEventListener("focusin", onFocusIn);
        screen.removeEventListener("focusout", onFocusOut);
        screen.removeEventListener("pointerdown", activate, true);
        screen.removeEventListener("paste", onPaste, true);
        terminalBodyRef.current?.removeEventListener("dragover", onDragOver);
        terminalBodyRef.current?.removeEventListener("drop", onDrop);
        document.removeEventListener("scroll", onCaretRevealScroll, true);
        observer.disconnect();
        ws.onclose = null;
        ws.close();
        localEcho?.dispose();
        localEchoRef.current = null;
        engine.dispose();
        engineRef.current = null;
        refitRef.current = null;
        scrollQueryRef.current = null;
        unsubScrollChange();
        cancelAnimationFrame(thumbRaf);
        revealRef.current = null;
      };
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cleanup?.();
    };
    // Theme is deliberately a dependency: neither engine can re-theme a live
    // terminal (ghostty's ANSI palette is baked into its WASM config at
    // construction; this app applies xterm's theme the same remount-based
    // way for uniform behavior across engines), so a theme switch tears the
    // whole terminal + WS down and rebuilds — the daemon replays the
    // content on reattach. Theme identity is stable (useThemeAssets), so this only
    // fires on a real theme change. resolvedEngine is also deliberately a
    // dependency: switching engines (directly or via "auto" re-resolving on
    // a device-class change) needs the exact same rebuild-and-reattach.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, resolvedEngine]);

  // Apply settings changes to the live terminal without reconnecting.
  useEffect(() => {
    engineRef.current?.setSettings({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      fontWeight: settings.fontWeight,
      fontWeightBold: settings.fontWeightBold,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      lineHeight: settings.lineHeight,
      letterSpacing: settings.letterSpacing,
      minimumContrastRatio: settings.minimumContrastRatio,
      textThickness: settings.textThickness,
      copyJoinWrappedLines: settings.copySelection !== "raw",
      copySelection: settings.copySelection,
    });
    refitRef.current?.();
  }, [settings]);

  // A newly-loaded extension font needs a re-measure even though
  // fontFamily was already set to its name (while the face was still
  // loading, so glyphs rendered in whatever fallback matched first).
  useEffect(() => {
    engineRef.current?.refreshFonts();
    refitRef.current?.();
    localEchoRef.current?.refreshFont();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontsVersion]);

  // A tab that was hidden skipped every scroll query while it was off screen
  // (see requestScrollState), so its thumb reflects whatever the pane looked
  // like when it was last visible. Catch it up once, on reveal — the one
  // moment the answer can actually be seen.
  useEffect(() => {
    if (visible) revealRef.current?.();
  }, [visible]);

  // Counterpart to the document.hidden bail-outs above: a backgrounded browser
  // tab neither paints nor queries, so catch both up the moment it returns to
  // the foreground.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden && visibleRef.current) revealRef.current?.();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // Not on touch devices: engine.focus() focuses the contenteditable screen
  // div, and doing that inside a user gesture (tapping a tab, tapping out
  // of the bottom panel — anything that flips `focused`) pops the
  // on-screen keyboard. On touch, keyboard focus is granted only by a
  // direct tap on the terminal (the touchend handler in the mount effect).
  useEffect(() => {
    if (!focused) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    requestAnimationFrame(() => engineRef.current?.focus());
  }, [focused]);

  // While focused, this view answers ExtensionContext.app.focusActiveTerminal
  // (an extension dialog closing and handing keys back to the prompt). The
  // rAF matches the focused-effect above: the caller's own UI teardown must
  // land first or its unmounting focus target steals the focus right back.
  useEffect(() => {
    if (!focused) return;
    const handler = () => requestAnimationFrame(() => engineRef.current?.focus());
    setFocusActiveTerminalHandler(handler);
    return () => clearFocusActiveTerminalHandler(handler);
  }, [focused]);

  // Pixel rects (relative to .terminal-body) of the touch selection's first
  // and last cells, recomputed every render from the engine's live cell
  // metrics — the toolbar anchors to the first, the drag handles (T8) to
  // both. Both stay null while there's nothing settled to show yet (T7) —
  // interacting is only ever true during the initiating finger's own live
  // drag, never during a handle drag (T8 hides only its own toolbar, via
  // TouchSelection's local state — see its component comment).
  let touchSelRect: { left: number; top: number; width: number; height: number } | null = null;
  let touchSelStartRect: { left: number; top: number; width: number; height: number } | null = null;
  let touchSelEndRect: { left: number; top: number; width: number; height: number } | null = null;
  if (touchSel && !touchSel.interacting) {
    const engine = engineRef.current;
    const screenEl = screenRef.current;
    const bodyEl = terminalBodyRef.current;
    if (engine && screenEl && bodyEl) {
      const { width: cw, height: ch } = engine.getCellMetrics();
      const screenRect = screenEl.getBoundingClientRect();
      const bodyRect = bodyEl.getBoundingClientRect();
      const cellRect = (col: number, row: number) => ({
        left: screenRect.left - bodyRect.left + col * cw,
        top: screenRect.top - bodyRect.top + row * ch,
        width: cw,
        height: ch,
      });
      const aLin = touchSel.anchorRow * engine.cols + touchSel.anchorCol;
      const hLin = touchSel.headRow * engine.cols + touchSel.headCol;
      const first = aLin <= hLin
        ? { col: touchSel.anchorCol, row: touchSel.anchorRow }
        : { col: touchSel.headCol, row: touchSel.headRow };
      const last = aLin <= hLin
        ? { col: touchSel.headCol, row: touchSel.headRow }
        : { col: touchSel.anchorCol, row: touchSel.anchorRow };
      touchSelRect = cellRect(first.col, first.row);
      touchSelStartRect = touchSelRect;
      touchSelEndRect = cellRect(last.col, last.row);
    }
  }

  // The link/word candidate under a viewport point, from the visible text —
  // the same detection the touch long-press uses. Synchronous, so it can
  // also answer "is the pointer on a link?" for a decision that has to be
  // made before any path resolution (paste-mode right-click). A path
  // candidate here is only a candidate: whether the file exists is settled
  // by resolvePaths.
  const candidateAtPoint = (clientX: number, clientY: number) => {
    const engine = engineRef.current;
    if (!engine) return null;
    const cell = engine.cellFromPoint(clientX, clientY);
    const col = cell.col - 1;
    const row = cell.row - 1;
    const stitched = engine.readStitchedLine(row);
    if (!stitched) return null;
    const candidate = rangeAt(stitched.text, (row - stitched.startLine) * engine.cols + col)?.candidate;
    if (!candidate) return null;
    // The candidate's first screen cell, so its path resolves against the
    // pane it's printed in (null when that cell is above the live screen).
    const startRow = stitched.startLine + Math.floor(candidate.startIdx / engine.cols);
    const startCell = startRow >= 0 ? { row: startRow, col: candidate.startIdx % engine.cols } : null;
    return { ...candidate, cell: startCell };
  };
  const candidateAtPointRef = useRef(candidateAtPoint);
  candidateAtPointRef.current = candidateAtPoint;

  // Builds and opens the terminal's right-click menu at a viewport point.
  // What's under the pointer decides the link rows: the engine's own
  // hovered link when it reports one (authoritative — an OSC 8 hyperlink's
  // target isn't its visible text, and a path link is already resolved),
  // otherwise the same text hit-test the touch long-press uses, whose path
  // candidates still need resolving against the pane's cwd. That resolve is
  // async, so a path menu opens a tick later rather than offering an "Open
  // File" that might not exist — the same tradeoff the touch link menu
  // makes.
  const openContextMenuAt = (clientX: number, clientY: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    const hasSelection = !!engine.getSelection();

    const show = (link: HoveredLink | null) => {
      const items: MenuItem[] = [];
      if (link?.kind === "url") {
        items.push({ label: "Open Link", onClick: () => openUrl(link.target) });
        items.push({
          label: "Copy Link",
          onClick: () => {
            copyText(link.target).catch((err) => onErrorRef.current(err));
          },
        });
        items.push({ separator: true, label: "", onClick: () => {} });
      } else if (link?.kind === "path") {
        items.push({ label: "Open File", onClick: () => onOpenFileRef.current?.(link.target, link.line) });
        if (isPreviewableRef.current?.(link.target)) {
          items.push({ label: "Preview", onClick: () => onPreviewFileRef.current?.(link.target) });
        }
        items.push({
          label: "Copy Path",
          onClick: () => {
            copyText(link.target).catch((err) => onErrorRef.current(err));
          },
        });
        items.push({ separator: true, label: "", onClick: () => {} });
      }
      items.push({
        label: "Copy",
        shortcutCommand: "terminal.copy",
        disabled: !hasSelection,
        onClick: () => copySelectionAsRef.current("default"),
      });
      items.push({
        label: "Copy as Paragraph",
        shortcutCommand: "terminal.copyAsParagraph",
        disabled: !hasSelection,
        onClick: () => copySelectionAsRef.current("paragraph"),
      });
      items.push({ label: "Paste", onClick: () => pasteFromClipboardRef.current() });
      // Omitted rather than shown dead when the engine can't do it (the
      // seam's selectAll is optional).
      if (engine.selectAll) {
        items.push({ label: "Select All", onClick: () => engineRef.current?.selectAll?.() });
      }
      items.push({ separator: true, label: "", onClick: () => {} });
      items.push({
        label: "Clear",
        shortcutCommand: "terminal.clear",
        onClick: () => engineRef.current?.clear(),
      });
      showMenuRef.current?.(clientX, clientY, items);
    };

    const hovered = hoveredLinkRef.current;
    if (hovered) {
      show(hovered);
      return;
    }
    const candidate = candidateAtPoint(clientX, clientY);
    if (!candidate) {
      show(null);
      return;
    }
    if (candidate.kind === "url") {
      show({ kind: "url", target: candidate.target });
      return;
    }
    resolvePathsRef.current([candidate.target], [candidate.cell])
      .then(([resolved]) => {
        show(resolved ? { kind: "path", target: resolved, line: candidate.line } : null);
      })
      .catch(() => show(null));
  };
  openContextMenuAtRef.current = openContextMenuAt;

  // Copies the selection. The engine already applied the user's copy mode
  // (settings.copySelection) in getSelection, so "default" just copies that
  // text; "paragraph" additionally undoes the wrapping the PROGRAM did to
  // its own output, for a one-off Copy as Paragraph regardless of the mode.
  // unwrapParagraphs is idempotent, so re-applying it over an engine that
  // already did (mode "paragraph") is a no-op — which is also what keeps
  // paragraph mode working on an engine built against the older settings
  // contract, since that engine ignores copySelection entirely. In "raw"
  // mode the base text still carries a break at every wrap column, so a
  // mid-word wrap gains a space here; joining those needs the terminal's
  // own wrap knowledge, which raw mode is explicitly opting out of.
  const copySelectionAs = (mode: "default" | "paragraph") => {
    const selection = engineRef.current?.getSelection();
    if (!selection) return;
    const text = mode === "paragraph" ? unwrapParagraphs(selection) : selection;
    copyText(text).catch((err) => onErrorRef.current(err));
  };
  copySelectionAsRef.current = copySelectionAs;

  // Reads the clipboard and pastes it into the terminal — as a bracketed paste
  // when the pane's program has DEC mode 2004 on (so a multi-line clipboard
  // inserts as one block instead of running each line), else raw. Backs the
  // long-press "Paste" menu items. readText() is allowed here because every
  // caller runs from a tap (menu click / toolbar button).
  const pasteFromClipboard = () => {
    navigator.clipboard
      .readText()
      .then((text) => {
        if (!text) return;
        const seq = engineRef.current?.getMode(2004) ? `\x1b[200~${text}\x1b[201~` : text;
        sendInputRef.current(seq);
      })
      .catch((err) => onErrorRef.current(err));
  };
  pasteFromClipboardRef.current = pasteFromClipboard;

  const handleTouchSelCopy = () => {
    if (!touchSel) return;
    const text = engineRef.current?.getSelection();
    if (text) copyText(text).catch((err) => onErrorRef.current(err));
    dismissTouchSelectionRef.current();
  };

  const handleTouchSelPaste = () => {
    pasteFromClipboard();
    dismissTouchSelectionRef.current();
  };

  const handleTouchSelOpen = () => {
    if (!touchSel?.open) return;
    if (touchSel.open.kind === "url") {
      openUrl(touchSel.open.target);
    } else {
      onOpenFileRef.current?.(touchSel.open.target, touchSel.open.line);
    }
    dismissTouchSelectionRef.current();
  };

  // A touch long-press that lands on a file/URL link opens the app's shared
  // context menu (Open / Preview? / Copy) at the press point, in place of the
  // inline Copy/Open selection toolbar (which still handles plain-text
  // selections below). Reacts to touchSel.open resolving: a URL is set
  // synchronously by beginTouchSelection, a path only after its async
  // resolvePaths returns — so this fires on that transition, once per gesture
  // (linkMenuOpenedRef is reset when each long-press begins).
  useEffect(() => {
    if (!touchSel || touchSel.interacting || !touchSel.open) return;
    if (linkMenuOpenedRef.current) return;
    linkMenuOpenedRef.current = true;
    const open = touchSel.open;
    const pt = lastLongPressPtRef.current ?? { x: 0, y: 0 };
    const items: MenuItem[] = [
      {
        label: open.kind === "url" ? "Open Link" : "Open File",
        onClick: () => {
          if (open.kind === "url") openUrl(open.target);
          else onOpenFileRef.current?.(open.target, open.line);
          dismissTouchSelectionRef.current();
        },
      },
    ];
    if (open.kind === "path" && isPreviewableRef.current?.(open.target)) {
      items.push({
        label: "Preview",
        onClick: () => {
          onPreviewFileRef.current?.(open.target);
          dismissTouchSelectionRef.current();
        },
      });
    }
    items.push({
      label: "Copy",
      onClick: () => {
        copyText(open.target).catch((err) => onErrorRef.current(err));
        dismissTouchSelectionRef.current();
      },
    });
    items.push({
      label: "Paste",
      onClick: () => {
        pasteFromClipboard();
        dismissTouchSelectionRef.current();
      },
    });
    showMenuRef.current?.(pt.x, pt.y, items);
  }, [touchSel]);

  // Fresh object per render (like the inline props it replaced) — accessory
  // components re-render with this terminal, reading live values.
  const accessoryContext: TerminalAccessoryContext = {
    focused,
    mobilePointer,
    command: currentCommand,
    lastCommandEvent,
    stickyCtrl,
    toggleStickyCtrl: () => setStickyCtrl((v) => !v),
    sendInput: (data) => sendInputRef.current(data),
    sendText: (text) => sendTextRef.current(text),
    uploadImage: (file) => uploadImageRef.current(file),
    uploadImages: (files) => uploadImagesRef.current(files),
    setSoftKeyboardSuppressed: (suppressed) => {
      softKeyboardSuppressedRef.current = suppressed;
      engineRef.current?.setSoftKeyboardSuppressed?.(suppressed);
    },
    containerRef: terminalBodyRef,
  };

  return (
    <div
      ref={containerRef}
      className={`terminal-host${visible ? "" : " hidden"}`}
    >
      {/* The touch key bar sits below this body in normal flow (flex
          column), so the terminal shrinks above it instead of rendering
          its last rows underneath; the overlays anchor to the body so
          they too stay clear of the bar. */}
      <div ref={terminalBodyRef} className="terminal-body">
        {engineMissing && (
          <div className="terminal-engine-missing">
            Terminal engine unavailable - the bundled xterm-engine extension failed to load.
            Reinstall or rebuild the app's bundled extensions, then reload.
          </div>
        )}
        <div ref={screenRef} className="terminal-screen" />
        {searchOpen && (
          <SearchBar
            query={searchQuery}
            onQueryChange={handleSearchQueryChange}
            onNext={handleSearchNext}
            onPrev={handleSearchPrev}
            onClose={handleSearchClose}
          />
        )}
        <div ref={scrollTrackRef} className="terminal-scrollbar">
          <div className="terminal-scrollbar-thumb" />
        </div>
        <div className="reconnect-overlay">Reconnecting…</div>
        {/* Plain-text selections keep the inline Copy/Open toolbar; a link
            selection (touchSel.open set) is handled by the context menu the
            effect above opens instead, so the toolbar is suppressed for it. */}
        {touchSelRect && touchSelStartRect && touchSelEndRect && !touchSel?.open && (
          <TouchSelection
            rect={touchSelRect}
            startRect={touchSelStartRect}
            endRect={touchSelEndRect}
            containerRef={terminalBodyRef}
            openLabel={null}
            onCopy={handleTouchSelCopy}
            onPaste={handleTouchSelPaste}
            onOpen={handleTouchSelOpen}
            onHandleDragStart={(which) => touchHandleBeginRef.current(which)}
            onHandleDragMove={(x, y) => touchHandleMoveRef.current(x, y)}
          />
        )}
        {extensionTerminalAccessories
          .filter((a) => a.placement === "overlay")
          .map((a) => (
            <a.component key={a.id} context={accessoryContext} />
          ))}
      </div>
      {extensionTerminalAccessories
        .filter((a) => a.placement === "bar")
        .map((a) => (
          <a.component key={a.id} context={accessoryContext} />
        ))}
    </div>
  );
}

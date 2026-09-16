// Types-only copy of client/src/engines/types.ts — the TerminalEngine seam
// — for extension-implemented engines (xterm-engine, ghostty-engine).
// Structural typing interops with the host's own copy without either side
// importing the other (see extensions/_shared's module comment). Runtime
// engine-support helpers (markSyntheticSelectStart, cellFromPoint, link
// providers, ensureContrastRatio) come from the host via the
// "@perch/engine-support" shim instead — never from a bundled copy,
// whose Symbol/state identity would differ from the host's.

export interface TerminalTheme {
  foreground?: string;
  background?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

// The subset of AppSettings an engine actually renders with — passed as a
// plain slice so an engine module never needs to know about unrelated app
// settings (upload conflict policy, tab placement, etc).
export interface TerminalEngineSettings {
  fontFamily: string;
  fontSize: number;
  fontWeight: "normal" | "medium";
  fontWeightBold: "normal" | "bold";
  cursorStyle: "block" | "bar" | "underline";
  cursorBlink: boolean;
  lineHeight: number;
  letterSpacing: number;
  minimumContrastRatio: number;
  textThickness: number;
  // Lines of history kept in the browser. Optional; engines default it.
  scrollback?: number;
  // Join soft-wrapped rows when extracting selection text for copy — see
  // client/src/selectionText.ts (shared via @perch/engine-support).
  // Derived from copySelection below (it is `copySelection !== "raw"`) and
  // kept because engines shipped outside this repo read it; a new engine
  // should read copySelection instead.
  copyJoinWrappedLines: boolean;
  // How copied selection text is assembled. Optional so an engine built
  // against the older contract still type-checks (it just never sees
  // "paragraph" and falls back to copyJoinWrappedLines above; the app
  // applies unwrapParagraphs itself on its own copy paths).
  copySelection?: "raw" | "joinWrapped" | "paragraph";
}

// 1-based cell-grid coordinates — matches the SGR mouse-report wire format
// mouseReports.ts encodes.
export interface CellPosition {
  col: number;
  row: number;
}

// 0-based screen-relative coordinates (row 0 = top of the visible
// viewport) — matches readLine's row numbering. Deliberately a distinct
// type from CellPosition: that one is 1-based for SGR wire compatibility,
// this one isn't a wire format at all.
export interface ScreenPosition {
  col: number;
  row: number;
}

// What the pointer is currently over, when it's over a link — reported
// alongside the activation callback by onLinkHoverChange below. `target` is
// the real destination (an OSC 8 URI, or a path the engine already resolved
// through resolvePaths), never the visible cell text.
export interface HoveredLink {
  kind: "url" | "path";
  target: string;
  // 1-based line number from a "path:line[:col]" link, when it had one.
  line?: number;
}

// 0-based cell on the terminal's live screen (row 0 = top of the screen,
// not of local scrollback) — lets the server resolve a path link against the
// pane it's printed in.
export interface ScreenCell {
  row: number;
  col: number;
}

// A logical line wrapped across rows by a split pane — see readPaneLines.
export interface PaneLine {
  left: number;
  width: number;
  // Screen row of the line's first row; negative when it began in history.
  startRow: number;
  text: string;
}

export interface TerminalEngineOptions {
  // Element the engine mounts into (TerminalView's `screen` ref, never the
  // outer host) — sibling widgets stay outside whatever key/paste
  // listeners the engine attaches to it.
  screen: HTMLElement;
  settings: TerminalEngineSettings;
  theme: TerminalTheme;
  // Whether this terminal is currently on screen — read by the engine's
  // own render-suppression (a hidden/backgrounded terminal shouldn't spend
  // paint cycles); combined internally with document.hidden.
  isVisible: () => boolean;
  // Raw typed/pasted/composed input — called for every onData-equivalent
  // event, including an engine's own IME workarounds. Sticky-Ctrl
  // transformation happens in the caller, not here.
  onData: (data: string) => void;
  // Link detection (regex/path scanning) is engine-agnostic and lives in
  // terminalLinks.ts; these are the app-level callbacks it already takes,
  // passed straight through by whichever adapter the engine module uses.
  // `cells` is index-aligned with `paths`: each candidate's first screen
  // cell, or null when it isn't on the live screen.
  resolvePaths: (paths: string[], cells?: (ScreenCell | null)[]) => Promise<(string | null)[]>;
  // The rejoined wrapped line per side-by-side pane under a live screen row
  // — a split pane's wraps reach the terminal as hard line breaks, so the
  // engine can't stitch them from its own buffer. Optional: an engine or
  // host without it just doesn't link paths wrapped inside split panes.
  readPaneLines?: (row: number) => Promise<PaneLine[]>;
  onOpenUrl: (url: string) => void;
  onOpenFile: (path: string, line?: number) => void;
  onOpenFileSecondary: (path: string, line?: number) => void;
  // A program in the terminal asked to set the clipboard (OSC 52). The host
  // decides whether it is honored: output replayed from history carries the
  // copies of programs long gone, which must not overwrite what the user
  // copied since. Optional: without it the engine copies on its own.
  onClipboardWrite?: (text: string) => void;
  // Fired whenever link-hover state changes, so TerminalView's shared
  // mouse-capture layer knows whether a hovered link's activation callback
  // is armed for an open-gesture (ctrl/cmd) click. Hover tooltip DOM,
  // positioning, and show/hide are the engine's own concern.
  // The second argument describes WHAT is hovered, so the host can label a
  // context menu ("Open Link" vs "Open File") and copy the real target —
  // an OSC 8 hyperlink's URI is not its visible text, and a path link has
  // already been resolved by the engine. Optional so an engine built
  // against the older contract still satisfies this type; the host then
  // falls back to detecting a link from the visible text under the pointer.
  onLinkHoverChange: (activate: ((e: MouseEvent) => void) | null, link?: HoveredLink | null) => void;
}

// Everything TerminalView calls on a live engine instance. Kept narrow and
// descriptive of actual TerminalView call sites (extracted from the
// current ghostty-only implementation), not aspirational.
export interface TerminalEngineHandle {
  readonly cols: number;
  readonly rows: number;
  // Uint8Array for a binary WS "data" frame straight from the PTY (see
  // wsAttach.ts) — both engines' underlying write() already accept it
  // alongside string.
  write(data: string | Uint8Array): void;
  // General terminal focus (e.g. tab activation, search close).
  focus(): void;
  // Focuses whichever element actually receives keyboard input — may
  // differ from focus() (e.g. a hidden IME textarea) — used by the mouse
  // capture layer after swallowing a press that would normally focus it.
  focusInput(): void;
  getSelection(): string;
  clearSelection(): void;
  // Selects the whole buffer (the right-click menu's "Select All").
  // Optional: an engine that can't do it simply omits the menu row.
  selectAll?(): void;
  // Clears the terminal's own local buffer (terminal.clear keybinding) —
  // unrelated to the backend's scrollback, which the server owns.
  clear(): void;
  // Starts a local (browser-side) text selection anchored at a screen point.
  // Subsequent real mousemove/mouseup events are not re-forwarded here —
  // the engine's own selection mechanism extends/finalizes them natively
  // once armed (ghostty: synthetic mousedown replay on its canvas; xterm:
  // term.select(), see plans/terminal-engine-setting.md's T1 findings).
  beginLocalSelection(clientX: number, clientY: number): void;
  // Programmatic selection over a linear cell range, all in 0-based screen
  // coordinates (row 0 = top of the visible viewport, matching readLine's
  // numbering) — `length` spans wrapped rows the same way term.select()'s
  // linear count does. Used by touch long-press selection (plans/mobile-
  // touch-select-copy-open.md), where there's no real mouse gesture to
  // replay from. xterm drives its buffer-absolute term.select() directly
  // (offsetting by baseY); ghostty's term.select() clamps its row argument
  // to rows-1 and can't reach visible rows once scrollback exists, so it
  // replays marked synthetic mouse events instead, same as
  // beginLocalSelection.
  selectCells(col: number, row: number, length: number): void;
  // Screen-relative wrapped-line stitching (0 = top of the visible
  // viewport) — the same logic terminalLinks.ts's stitchLine/stitchXtermLine
  // already do per-engine for link hover, exposed here so touch selection
  // can run the same candidate-detection over an arbitrary pressed row
  // without a hover event. Out-of-range rows return null.
  readStitchedLine(row: number): { text: string; startLine: number } | null;
  cellFromPoint(clientX: number, clientY: number): CellPosition;
  getCharHeight(): number;
  // DEC private-mode query (mouse tracking, focus reporting, etc).
  getMode(mode: number): boolean;
  // Resizes to fit `screen`'s current box; returns the new grid, or null
  // if the container isn't measurable yet (zero size) — the caller is
  // responsible for telling the server about a real resize.
  fit(): { cols: number; rows: number } | null;
  // Forces a full repaint — used when a hidden/backgrounded terminal
  // becomes visible again and may be showing a stale or blank frame.
  reveal(): void;
  setSettings(settings: TerminalEngineSettings): void;
  // Forces a re-measure after an extension font finishes loading (glyphs
  // rendered against a fallback face while the real one was still
  // downloading need a nudge to redraw with it).
  refreshFonts(): void;
  // Attaches a key/wheel handler; return true to mark the event handled
  // (preventDefault + skip the engine's own key/wheel handling for it) —
  // each engine normalizes its own native return-value convention to this
  // shared "true = handled" shape.
  onKeyEvent(handler: (e: KeyboardEvent) => boolean): void;
  onWheelEvent(handler: (e: WheelEvent) => boolean): void;
  // Fires on every compositionupdate with the IME's current full
  // in-progress word (not an incremental delta), and once more with null
  // on compositionend — used to preview a not-yet-committed predictive-
  // keyboard word through LocalEcho, since the OS delivers nothing through
  // onData at all until the word actually commits.
  onComposingChange(handler: (text: string | null) => void): void;
  // Dispatches a synthetic wheel event at whichever internal element the
  // engine's own onWheelEvent handler actually listens on — used to route
  // touch-swipe gestures (computed in TerminalView) through the same wheel
  // policy real wheel events go through.
  dispatchSyntheticWheel(init: WheelEventInit): void;
  // Reads one screen-relative row's text (0 = top of the visible viewport),
  // right-trimmed of trailing whitespace, at most `cols` characters — used
  // by LocalEcho's prompt finder (plans/codeman-mobile-features.md).
  // Out-of-range rows return "".
  readLine(row: number): string;
  // The cursor's screen-relative position (0-based, matches readLine's row
  // numbering).
  getCursor(): ScreenPosition;
  // True when the viewport isn't pinned to the bottom of the buffer (the
  // user has scrolled back into history).
  isScrolledUp(): boolean;
  // Where the viewport sits in the buffer. Lines are absolute: 0 is the
  // oldest line of scrollback, `length` counts scrollback plus the screen,
  // `baseY` is the first line of the bottom page and `viewportY` the first
  // line currently shown (equal to baseY when pinned to the bottom).
  getScrollState(): { viewportY: number; baseY: number; length: number; rows: number };
  // Scrolls so absolute `line` is the top visible line (clamped).
  scrollToLine(line: number): void;
  scrollToBottom(): void;
  // Fires when the viewport moves or the buffer grows; returns an
  // unsubscribe. What a scroll thumb redraws from.
  onScrollChange(cb: () => void): () => void;
  // One absolute buffer line's text, right-trimmed. Optional: an engine
  // without buffer access gets no scrollback search.
  readBufferLine?(line: number): string;
  // Selects `length` cells starting at absolute (col, line), scrolling it
  // into view.
  selectBufferRange?(col: number, line: number, length: number): void;
  // Absolute lines where a prompt began (OSC 133;A from shell integration),
  // oldest first, kept current as scrollback is trimmed. Optional: without
  // it the prompt-jump commands have nothing to jump to.
  promptLines?(): number[];
  // Tells the engine the terminals are Windows ConPTY pseudo-terminals (with
  // the Windows build number), or not, so it can match how they reflow.
  // Optional: an engine without it renders them as it would any other.
  setWindowsPty?(windowsBuild: number | null): void;
  // Cell size in CSS pixels, respecting lineHeight/letterSpacing — the
  // same grid both cellFromPoint and the engine's own renderer use.
  getCellMetrics(): { width: number; height: number };
  // Suppresses the mobile soft keyboard while keeping the engine's input
  // element focusable (inputmode="none" on the hidden IME textarea):
  // hardware keys and app-drawn keyboards (terminal accessories) keep
  // working, but tapping the terminal no longer summons the OS keyboard.
  // Optional — an engine without it simply can't suppress, and the host
  // calls it defensively. Re-applied by the host after engine creation, so
  // implementations only need to affect the live element.
  setSoftKeyboardSuppressed?(suppressed: boolean): void;
  // Fires after each repaint completes; returns an unsubscribe. Multiple
  // subscribers are supported (unlike onKeyEvent/onWheelEvent, which each
  // set a single handler).
  onRender(cb: () => void): () => void;
  dispose(): void;
}

// Async because ghostty-web needs a one-time WASM init before its first
// Terminal can construct (memoized inside engines/ghostty.ts) — xterm.js
// has no such step but matches the same shape so the caller (and the
// engines/index.ts registry) never needs to know which engine is live.
export type CreateTerminalEngine = (options: TerminalEngineOptions) => Promise<TerminalEngineHandle>;

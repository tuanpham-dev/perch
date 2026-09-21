// xterm.js implementation of the TerminalEngine seam — moved verbatim from
// core client/src/engines/xterm.ts when both engines became bundled
// extensions (this one a REQUIRED builtin: the app's rendering floor).
// Originally a resurrection-and-forward-port of the pre-swap TerminalView
// (git show 4505044^), re-verified against @xterm/xterm 6.0.0. Nothing
// outside this extension may import "@xterm/xterm" or its addons.
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type FontWeight } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { cellFromPoint, joinedSelectionText, unwrapParagraphs } from "@perch/engine-support";
import { copyText } from "../../_shared/clipboard";
import { buildXtermLinkProvider, stitchXtermLine } from "./links";
import type {
  CellPosition,
  HoveredLink,
  TerminalEngineHandle,
  TerminalEngineOptions,
  TerminalEngineSettings,
} from "../../_shared/terminalEngineTypes";

function toFontWeight(weight: TerminalEngineSettings["fontWeight"]): FontWeight {
  // "medium" maps to the numeric 500 weight — utils/fonts.ts registers the
  // font's 500-weight face under the same family name, and xterm's own
  // fontWeight option (rendered as real DOM text) picks it up natively via
  // the browser's own font matching, same visual result as ghostty's
  // canvas-side weight handling through a completely different mechanism.
  return weight === "medium" ? "500" : "normal";
}

// async to match CreateTerminalEngine's shared shape — xterm has no
// WASM-style init step (unlike ghostty), but the registry never needs to
// know which engine is live. stylesheetReady (client.tsx's injected
// xterm.css <link> readiness) is awaited before term.open() below attaches
// any DOM — otherwise xterm's own raw, unstyled <textarea> can flash
// visible for as long as that stylesheet is still in flight.
export async function createXtermEngine(
  options: TerminalEngineOptions,
  stylesheetReady?: Promise<void>,
): Promise<TerminalEngineHandle> {
  await stylesheetReady;
  const {
    screen,
    settings: initialSettings,
    theme,
    onData,
    resolvePaths,
    readPaneLines,
    onOpenUrl,
    onOpenFile,
    onOpenFileSecondary,
    onClipboardWrite,
    onLinkHoverChange,
  } = options;

  let disposed = false;
  // Live settings copy for the ones consulted at event time rather than
  // applied to term.options (the copy mode) — updated in setSettings.
  let currentSettings = initialSettings;

  const term = new Terminal({
    // Required by @xterm/addon-unicode11's terminal.unicode API below.
    allowProposedApi: true,
    cursorBlink: initialSettings.cursorBlink,
    cursorStyle: initialSettings.cursorStyle,
    fontSize: initialSettings.fontSize,
    fontFamily: initialSettings.fontFamily,
    fontWeight: toFontWeight(initialSettings.fontWeight),
    fontWeightBold: initialSettings.fontWeightBold,
    lineHeight: initialSettings.lineHeight,
    letterSpacing: initialSettings.letterSpacing,
    // Native option — no shim needed, unlike ghostty. Default (4.5) mirrors
    // VS Code/code-server (terminal.integrated.minimumContrastRatio).
    minimumContrastRatio: initialSettings.minimumContrastRatio,
    // History lives here, in the browser: the terminal daemon replays a
    // window's output on attach, and scrolling, search and prompt jumps all
    // read this buffer.
    scrollback: initialSettings.scrollback ?? 10_000,
    // xterm's SelectionService only force-starts local selection for
    // Option+click/drag on Mac (shouldForceSelection branches on
    // Browser.isMac) — irrelevant here since this engine's local selection
    // goes through term.select() directly (see beginLocalSelection below),
    // never through xterm's own mousedown/shift-force path at all (T1
    // finding: that path only *extends* an existing selection, never
    // starts one from blank, and would double-report to the backend besides).
    // Left at its default; nothing in this engine relies on it.
    theme,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // xterm's default (Unicode 6) width table treats some emoji used in
  // prompts (e.g. a sailboat "⛵") as narrow, clipping half the glyph.
  // Unicode 11 tables classify them correctly. Spike-verified unchanged
  // against 6.0.0 (activeVersion switches to "11" without error).
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";

  // No leaked-resize-listener workaround here — the equivalent xterm 5.5.0
  // bug the pre-swap code worked around is spike-confirmed fixed in 6.0.0
  // (open() still adds one window "resize" listener, but dispose() now
  // correctly removes it).
  term.open(screen);

  // WebGL needs the canvas term.open() just created, so it can't load
  // earlier alongside the other addons. Wrapped in try/catch because
  // activate() throws synchronously on WebGL2-less environments (old
  // browsers, some embedded webviews) rather than failing gracefully —
  // falls back to xterm's default DOM renderer in that case. A context
  // loss later (GPU reset, driver crash) is handled the same way: dispose
  // the addon and let xterm fall back to DOM rather than rendering a blank
  // terminal.
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // No WebGL2 support — DOM renderer remains active.
  }

  const rowsEl = term.element?.querySelector(".xterm-rows") as HTMLElement | null;
  const applyTextThickness = (thickness: number) => {
    if (!rowsEl) return;
    // currentColor resolves per-element at use time (each character's own
    // DOM span keeps its own set `color`), not as a fixed value inherited
    // from where the stroke is declared — spike-verified visually (the
    // stroke matched each glyph's own color, not a single flat tint).
    rowsEl.style.webkitTextStroke = thickness > 0 ? `${thickness}px currentColor` : "";
  };
  applyTextThickness(initialSettings.textThickness);

  // xterm.js has no equivalent to ghostty-web's always-on render loop (it
  // only repaints dirty rows on actual content changes), so there's no
  // render-suppression-while-hidden workaround needed here — `isVisible`
  // from options is intentionally unused by this engine.

  const lastMouse = { x: 0, y: 0 };
  const onTooltipMouseMove = (e: MouseEvent) => {
    lastMouse.x = e.clientX;
    lastMouse.y = e.clientY;
  };
  screen.addEventListener("mousemove", onTooltipMouseMove);
  const hoverTooltip = document.createElement("div");
  hoverTooltip.className = "xterm-hover terminal-link-tooltip";
  term.element?.appendChild(hoverTooltip);
  const showTooltip = (event: MouseEvent, text: string) => {
    const hostRect = term.element?.getBoundingClientRect();
    if (!hostRect) return;
    hoverTooltip.textContent = text;
    hoverTooltip.style.left = `${event.clientX - hostRect.left + 12}px`;
    hoverTooltip.style.top = `${event.clientY - hostRect.top + 16}px`;
    hoverTooltip.style.display = "block";
  };
  const hideTooltip = () => {
    hoverTooltip.style.display = "none";
  };

  // OSC 8's `text` is the link's real target URI, not the visible cell
  // content, so a file:// target routes through onOpenFile the same as a
  // detected file-path link.
  const activateOsc8 = (event: MouseEvent, text: string) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const link = osc8Link(text);
    if (link.kind === "path") onOpenFile(link.target);
    else onOpenUrl(link.target);
  };

  // Same file:-vs-everything-else split activateOsc8 acts on, as data — so
  // the hover report below and the activation can't drift apart.
  const osc8Link = (text: string): HoveredLink => {
    try {
      const url = new URL(text);
      if (url.protocol === "file:") {
        return { kind: "path", target: decodeURIComponent(url.pathname) };
      }
    } catch {
      // Not a parseable URL — treat as a URL target anyway (mailto:, custom
      // schemes some tools emit), exactly as onOpenUrl does.
    }
    return { kind: "url", target: text };
  };
  term.options.linkHandler = {
    activate: activateOsc8,
    hover: (event, text) => {
      showTooltip(event, text);
      onLinkHoverChange((e) => activateOsc8(e, text), osc8Link(text));
    },
    leave: () => {
      hideTooltip();
      onLinkHoverChange(null);
    },
  };

  const linkProvider = buildXtermLinkProvider(term, {
    resolvePaths,
    readPaneLines,
    onOpenUrl,
    onOpenFile,
    onOpenFileSecondary,
    onHoverChange: (link) => {
      if (link) {
        // ILink.hover carries no MouseEvent (unlike term.options.linkHandler
        // above), so the tooltip is positioned from the dedicated mousemove
        // tracker — same pattern the ghostty engine uses.
        const hostRect = term.element?.getBoundingClientRect();
        if (hostRect) {
          hoverTooltip.textContent = link.text;
          hoverTooltip.style.left = `${lastMouse.x - hostRect.left + 12}px`;
          hoverTooltip.style.top = `${lastMouse.y - hostRect.top + 16}px`;
          hoverTooltip.style.display = "block";
        }
        onLinkHoverChange((e) => link.activate(e, link.text), {
          kind: link.kind,
          target: link.target,
          line: link.line,
        });
      } else {
        hideTooltip();
        onLinkHoverChange(null);
      }
    },
  });
  const linkProviderDisposable = term.registerLinkProvider(linkProvider);

  const dataSub = term.onData(onData);

  // OSC 52 clipboard forwarding — lets an app in the pane (nvim's osc52
  // clipboard provider, the clipboard-tool shims, tmux's own set-clipboard
  // passthrough) push a copy into the browser clipboard, through the host's
  // onClipboardWrite when it gives one (it skips replayed history) or the
  // same copyText() the UI's own copy actions use. Payload is "<selection-char>;<base64>";
  // the query form ("...;?") is left unanswered since this engine has no
  // clipboard-read access to reply with.
  const oscHandlerDisposable = term.parser.registerOscHandler(52, (data) => {
    const payload = data.slice(data.indexOf(";") + 1);
    if (!payload || payload === "?") return true;
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      if (onClipboardWrite) onClipboardWrite(text);
      else void copyText(text);
    } catch {
      // Malformed base64 — ignore rather than throwing out of the parser.
    }
    return true;
  });

  // Prompt marks (OSC 133;A from the shell integration). The OSC handler runs
  // mid-parse, at the exact byte the mark arrives, so a marker registered here
  // lands on the prompt's own line even when a replay delivers hundreds of
  // prompts in one write. Markers follow their line as scrollback is trimmed
  // and dispose themselves when it's discarded. Returning false lets any
  // other OSC 133 handler see the sequence too.
  const promptMarkers = new Set<{ line: number; isDisposed: boolean; dispose(): void }>();
  const promptHandlerDisposable = term.parser.registerOscHandler(133, (data) => {
    if (data === "A" || data.startsWith("A;")) {
      const marker = term.registerMarker(0);
      if (marker) {
        promptMarkers.add(marker);
        marker.onDispose(() => promptMarkers.delete(marker));
      }
    }
    return false;
  });

  const scrollListeners = new Set<() => void>();
  const notifyScroll = () => {
    for (const cb of scrollListeners) cb();
  };
  const scrollSub = term.onScroll(notifyScroll);
  const writeParsedSub = term.onWriteParsed(notifyScroll);

  // Predictive keyboards (Gboard etc.) deliver nothing through onData at
  // all until a word actually commits (space, punctuation, a suggestion
  // tap) — xterm.js's own textarea still fires the standard Composition
  // Events throughout, which is the only signal available for previewing
  // the in-progress word before then. Listened on directly rather than
  // through xterm's own CompositionHelper (private, no public hook) —
  // xterm's own compositionend handler on the same element independently
  // reads the committed text and forwards it through the normal onData
  // path once this fires, so no double-send risk here either.
  let composingHandler: ((text: string | null) => void) | null = null;
  const onCompositionUpdate = (e: CompositionEvent) => composingHandler?.(e.data);
  const onCompositionEndForPreview = () => composingHandler?.(null);
  term.textarea?.addEventListener("compositionupdate", onCompositionUpdate);
  term.textarea?.addEventListener("compositionend", onCompositionEndForPreview);

  // Android IME bridge (mirrors the ghostty engine's, which was debugged
  // live on-device). xterm's CompositionHelper reads each commit out of
  // textarea.value in a 0ms timer and never clears the value afterwards.
  // Left in place, that stale text corrupts the NEXT word twice over:
  // (a) Gboard reads it as surrounding text and silently recomposes over
  // the previous word (type "abc def", backspace to "abc", type "xyz" —
  // the composition becomes "abcxyz", re-committing "abc"), and (b) the
  // keydown-229 diff in xterm's _handleAnyTextareaChanges computes
  // newValue.replace(oldValue, "") — garbage on every deletion (no match
  // → diff = the whole new value), which lands in _dataAlreadySent and
  // offsets the next commit's substring, eating its leading chars
  // (observed live 2026-07-25: that repro committed "yz", losing the x).
  // Clearing the value AFTER xterm's own reader timer (ours is scheduled
  // behind it in FIFO order) fixes both while leaving xterm's commit
  // delivery untouched.
  const onCompositionEndCleanup = () => {
    setTimeout(() => {
      if (term.textarea) term.textarea.value = "";
    }, 0);
  };
  term.textarea?.addEventListener("compositionend", onCompositionEndCleanup);

  // With the textarea kept empty, xterm's value-diff can no longer see
  // Android backspaces (keydown is 229; the delete arrives only as a
  // beforeinput on an already-empty value), so forward deletes directly.
  // preventDefault keeps the value untouched, which also silences the
  // diff path while text IS present — this bridge owns deletes entirely,
  // never doubling them. Desktop backspace is a real keydown 8, handled
  // and preventDefault()ed by xterm before any beforeinput can fire.
  // Insertions are deliberately NOT bridged here (unlike ghostty): with a
  // clean empty value, xterm's own diff/composition machinery delivers
  // them correctly, and bridging both paths would double-send.
  const onBeforeInput = (e: InputEvent) => {
    if (e.isComposing) return;
    let out: string;
    switch (e.inputType) {
      case "deleteContentBackward":
        out = "\x7f";
        break;
      case "deleteContentForward":
        out = "\x1b[3~";
        break;
      default:
        return;
    }
    e.preventDefault();
    onData(out);
  };
  term.textarea?.addEventListener("beforeinput", onBeforeInput as EventListener);

  // Real cell box from xterm's render service — the same value its renderer
  // draws glyphs with (private path; see getCellMetrics' comment below for
  // why the rect/cols container-math fallback is a last resort: the
  // container keeps up to one cell of leftover space past the fitted grid,
  // so dividing by cols/rows overestimates the cell size).
  const cssCellDims = (): { width: number; height: number } => {
    const cell = (
      term as unknown as {
        _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } };
      }
    )._core?._renderService?.dimensions?.css?.cell;
    if (cell && cell.width > 0 && cell.height > 0) return { width: cell.width, height: cell.height };
    const rect = screen.getBoundingClientRect();
    return { width: rect.width / term.cols, height: rect.height / term.rows };
  };

  const cellFromPointOnEngine = (clientX: number, clientY: number): CellPosition => {
    // Measure from xterm's own grid element and its real cell box — the
    // exact math xterm's getCoords hit-testing uses. The old container-rect
    // ÷ rows math overestimated the cell height (leftover space below the
    // fitted grid), an error that accumulates downward: clicks on low rows
    // of a tall terminal mapped to the row above.
    const gridEl = term.element?.querySelector(".xterm-screen") ?? screen;
    const rect = gridEl.getBoundingClientRect();
    const { width, height } = cssCellDims();
    return cellFromPoint(clientX, clientY, rect, width, height, term.cols, term.rows);
  };

  // Fan-out for onRender: one real subscription to xterm's event,
  // broadcast to however many callers have asked to be notified.
  const renderListeners = new Set<() => void>();
  const renderSub = term.onRender(() => {
    for (const cb of renderListeners) cb();
  });

  // Active drag-selection teardown, set while a beginLocalSelection() drag
  // is in progress so a second call (shouldn't happen, but cheap to guard)
  // or dispose() can clean it up.
  let endLocalSelectionDrag: (() => void) | null = null;

  // Selection text with soft-wrap joining. term.getSelection() only joins
  // rows flagged isWrapped, and tmux's cursor-positioned redraws leave that
  // flag unset — joinedSelectionText additionally joins rows filled to the
  // last column. getSelectionPosition() here returns the selection model's
  // raw 0-based coords with an EXCLUSIVE end column (verified against
  // @xterm/xterm 6.0.0's CoreBrowserTerminal.getSelectionPosition), despite
  // the 1-based IBufferRange typing — exactly the shape the helper takes.
  //
  // copySelection picks the mode; an older host that only sets
  // copyJoinWrappedLines maps onto "joinWrapped"/"raw". "paragraph"
  // additionally undoes the wrapping the PROGRAM did to its own output —
  // lossy, so it only ever runs when the user asked for it.
  const copyMode = (): "raw" | "joinWrapped" | "paragraph" =>
    currentSettings.copySelection ?? (currentSettings.copyJoinWrappedLines ? "joinWrapped" : "raw");

  const selectionForCopy = (): string => {
    const mode = copyMode();
    if (mode === "raw") return term.getSelection();
    const pos = term.getSelectionPosition();
    if (!pos) return term.getSelection();
    const joined = joinedSelectionText(term, {
      startX: pos.start.x,
      startY: pos.start.y,
      endX: pos.end.x,
      endY: pos.end.y,
    });
    return mode === "paragraph" ? unwrapParagraphs(joined) : joined;
  };

  // Browser-native copy (right-click → Copy, or a copy keydown no app
  // keybinding claimed) fires on xterm's hidden textarea and is answered by
  // xterm's own 'copy' handler on term.element with the raw un-joined text.
  // Capture on `screen` (an ancestor) runs first and overrides it with the
  // same joined text the app's copy paths produce.
  const onCopyEvent = (e: ClipboardEvent) => {
    if (copyMode() === "raw") return;
    if (!term.hasSelection() || !e.clipboardData) return;
    e.clipboardData.setData("text/plain", selectionForCopy());
    e.preventDefault();
    e.stopPropagation();
  };
  screen.addEventListener("copy", onCopyEvent, true);

  const handle: TerminalEngineHandle = {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write: (data) => term.write(data),
    whenWritten: (done) => term.write("", done),
    focus: () => term.focus(),
    focusInput: () => term.textarea?.focus(),
    setSoftKeyboardSuppressed: (suppressed) => {
      // inputmode="none" is the standard "focusable but no virtual
      // keyboard" mechanism — hardware/app-drawn input still lands in the
      // textarea's key events.
      if (!term.textarea) return;
      if (suppressed) term.textarea.setAttribute("inputmode", "none");
      else term.textarea.removeAttribute("inputmode");
    },
    getSelection: () => selectionForCopy(),
    clearSelection: () => term.clearSelection(),
    selectAll: () => term.selectAll(),
    clear: () => term.clear(),
    // T1 finding: xterm's own mousedown/shift-force replay path only
    // *extends* an existing selection (never starts one from blank) and
    // would double-report to the backend besides — so this engine skips DOM
    // replay entirely and drives term.select(column, row, length)
    // directly, updating it on each real mousemove for as long as the
    // drag continues (TerminalView's own onCapture has already released
    // the gesture by the time this is called, so these are this engine's
    // own temporary listeners, torn down on mouseup). term.select()'s row
    // is buffer-absolute (mobile-touch-select-copy-open.md spike finding),
    // so screen rows here are resolved through viewportY, same as
    // selectCells below. The anchor is resolved once, at press time: the
    // view scrolls under a drag that reaches the edge (and new output moves
    // the buffer under it either way), and the cell the gesture started on
    // must not travel with it.
    beginLocalSelection: (clientX, clientY) => {
      endLocalSelectionDrag?.();
      const start = cellFromPointOnEngine(clientX, clientY);
      const startCol = start.col - 1;
      const startRow = term.buffer.active.viewportY + start.row - 1;
      const linear = (row: number, col: number) => row * term.cols + col;
      const startLinear = linear(startRow, startCol);
      const update = (clientX2: number, clientY2: number) => {
        const cur = cellFromPointOnEngine(clientX2, clientY2);
        const curRow = term.buffer.active.viewportY + cur.row - 1;
        const curLinear = linear(curRow, cur.col - 1);
        if (curLinear >= startLinear) {
          term.select(startCol, startRow, curLinear - startLinear + 1);
        } else {
          term.select(cur.col - 1, curRow, startLinear - curLinear + 1);
        }
      };
      update(clientX, clientY);
      const onMove = (e: MouseEvent) => update(e.clientX, e.clientY);
      const onUp = () => endLocalSelectionDrag?.();
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
      endLocalSelectionDrag = () => {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("mouseup", onUp, true);
        endLocalSelectionDrag = null;
      };
    },
    // Spike finding: term.select()'s row is buffer-absolute, so a screen row
    // (0 = top of the visible viewport) must add viewportY.
    selectCells: (col, row, length) => {
      term.select(col, term.buffer.active.viewportY + row, length);
    },
    // Seam contract is screen-relative (0 = top of the visible viewport);
    // stitchXtermLine works in absolute buffer rows, so offset by viewportY
    // both ways — same conversion readLine below already does.
    readStitchedLine: (row) => {
      const viewportY = term.buffer.active.viewportY;
      const stitched = stitchXtermLine(term, viewportY + row);
      return stitched ? { text: stitched.text, startLine: stitched.startLine - viewportY } : null;
    },
    cellFromPoint: cellFromPointOnEngine,
    getCharHeight: () => cssCellDims().height,
    getMode: (mode) => {
      const modes = term.modes;
      switch (mode) {
        case 1000:
          return modes.mouseTrackingMode === "vt200";
        case 1002:
          return modes.mouseTrackingMode === "drag";
        case 1003:
          return modes.mouseTrackingMode === "any";
        case 1004:
          return modes.sendFocusMode;
        default:
          return false;
      }
    },
    fit: () => {
      if (disposed) return null;
      if (screen.clientWidth === 0 || screen.clientHeight === 0) return null;
      fit.fit();
      return { cols: term.cols, rows: term.rows };
    },
    // xterm has no render-suppression-while-hidden to undo — refresh(...)
    // just forces a repaint in case anything was missed, which is cheap
    // and safe even when nothing actually needs it.
    reveal: () => {
      if (disposed) return;
      term.refresh(0, term.rows - 1);
    },
    setSettings: (s) => {
      term.options.fontFamily = s.fontFamily;
      term.options.fontSize = s.fontSize;
      term.options.fontWeight = toFontWeight(s.fontWeight);
      term.options.fontWeightBold = s.fontWeightBold;
      term.options.cursorStyle = s.cursorStyle;
      term.options.cursorBlink = s.cursorBlink;
      term.options.lineHeight = s.lineHeight;
      term.options.letterSpacing = s.letterSpacing;
      term.options.minimumContrastRatio = s.minimumContrastRatio;
      applyTextThickness(s.textThickness);
      currentSettings = s;
    },
    // Spike finding: the DOM renderer re-measures on the next reflow once
    // document.fonts reflects the newly-loaded face — CSS font-family
    // naturally respects that, unlike a canvas renderer. refresh() is a
    // cheap belt-and-braces repaint regardless.
    refreshFonts: () => {
      if (disposed) return;
      term.refresh(0, term.rows - 1);
    },
    // xterm's custom key/wheel handler return-value convention is the
    // OPPOSITE of this interface's "true = handled": its own docs show
    // `return false` to mean "I handled it, skip xterm's own encoding"
    // for keys, and "return whether xterm.js should process the event"
    // for wheel (i.e. false = we handled it). Invert both ways here so
    // TerminalView's shared handler logic never needs to know.
    onKeyEvent: (handler) => {
      term.attachCustomKeyEventHandler((e) => !handler(e));
    },
    onWheelEvent: (handler) => {
      term.attachCustomWheelEventHandler((e) => !handler(e));
    },
    onComposingChange: (handler) => {
      composingHandler = handler;
    },
    dispatchSyntheticWheel: (init) => {
      // xterm's own wheel listener is bound to term.element (a div it
      // creates as a *child* of screen via term.open), not screen itself —
      // dispatching on screen never reaches it since events only bubble up
      // from their target, never down into descendants.
      (term.element ?? screen).dispatchEvent(new WheelEvent("wheel", init));
    },
    // Global (0 = top of scrollback) and screen-relative indexing meet at
    // buffer.viewportY — what the seam means by "screen" is what is on
    // screen, which is only buffer.baseY while the pane sits at the live
    // tail. Reading through baseY instead made every screen-row API answer
    // about the bottom page whenever the pane was scrolled back: a
    // long-press on a path up in the history hit-tested a row of the live
    // screen, usually blank, so the press found nothing to select and the
    // link menu never appeared.
    readLine: (row) => {
      const idx = term.buffer.active.viewportY + row;
      // xterm's buffer is a circular list: get() wraps the index modulo
      // length and never returns undefined, so out-of-range has to be
      // checked explicitly rather than relying on a falsy return.
      if (idx < 0 || idx >= term.buffer.active.length) return "";
      const line = term.buffer.active.getLine(idx);
      if (!line) return "";
      return line.translateToString(true, 0, term.cols);
    },
    // xterm counts the cursor from the live screen; the seam counts screen
    // rows from the viewport. They differ only while scrolled back, where
    // the cursor is off-screen and the row lands outside 0..rows-1 — which
    // is what a caller placing something at the cursor should see.
    getCursor: () => ({
      col: term.buffer.active.cursorX,
      row: term.buffer.active.baseY + term.buffer.active.cursorY - term.buffer.active.viewportY,
    }),
    // baseY: top of the bottom page when fully scrolled down. viewportY:
    // top of what's currently shown. Equal means pinned to the bottom.
    isScrolledUp: () => term.buffer.active.viewportY !== term.buffer.active.baseY,
    getScrollState: () => ({
      viewportY: term.buffer.active.viewportY,
      baseY: term.buffer.active.baseY,
      length: term.buffer.active.length,
      rows: term.rows,
    }),
    scrollToLine: (line) => term.scrollToLine(Math.max(0, Math.min(term.buffer.active.baseY, Math.round(line)))),
    scrollToBottom: () => term.scrollToBottom(),
    onScrollChange: (cb) => {
      scrollListeners.add(cb);
      return () => scrollListeners.delete(cb);
    },
    readBufferLine: (index) => {
      if (index < 0 || index >= term.buffer.active.length) return "";
      return term.buffer.active.getLine(index)?.translateToString(true) ?? "";
    },
    selectBufferRange: (col, index, length) => {
      // Keep the match off the very top edge, so there's context above it.
      const buf = term.buffer.active;
      if (index < buf.viewportY || index >= buf.viewportY + term.rows) {
        term.scrollToLine(Math.max(0, Math.min(buf.baseY, index - Math.floor(term.rows / 3))));
      }
      term.select(col, index, length);
    },
    setWindowsPty: (windowsBuild) => {
      term.options.windowsPty = windowsBuild === null ? {} : { backend: "conpty", buildNumber: windowsBuild };
    },
    promptLines: () =>
      [...promptMarkers]
        .filter((m) => !m.isDisposed && m.line >= 0)
        .map((m) => m.line)
        .sort((a, b) => a - b),
    // Prefers xterm's own measured cell box (same value its renderer draws
    // glyphs with, on the same private path ecosystem addons already lean
    // on for pixel-accurate overlays — there's no public equivalent) over
    // rect.width/term.cols. That container-math approximation is not just
    // imprecise (confirmed live: ~5% off even once correctly fitted, enough
    // to visibly drift the local-echo overlay away from the real glyphs
    // over a long line) — it's also wrong by ~2x whenever this runs before
    // the terminal's first fit() lands (term.cols still at its default 80,
    // not yet the real fitted column count), which the old code had no way
    // to detect or recover from since LocalEcho only re-reads metrics on an
    // explicit refreshFont() call, not on every resize.
    getCellMetrics: () => cssCellDims(),
    onRender: (cb) => {
      renderListeners.add(cb);
      return () => renderListeners.delete(cb);
    },
    dispose: () => {
      disposed = true;
      endLocalSelectionDrag?.();
      screen.removeEventListener("copy", onCopyEvent, true);
      screen.removeEventListener("mousemove", onTooltipMouseMove);
      term.textarea?.removeEventListener("compositionupdate", onCompositionUpdate);
      term.textarea?.removeEventListener("compositionend", onCompositionEndForPreview);
      term.textarea?.removeEventListener("compositionend", onCompositionEndCleanup);
      term.textarea?.removeEventListener("beforeinput", onBeforeInput as EventListener);
      dataSub.dispose();
      oscHandlerDisposable.dispose();
      promptHandlerDisposable.dispose();
      scrollSub.dispose();
      writeParsedSub.dispose();
      scrollListeners.clear();
      renderSub.dispose();
      renderListeners.clear();
      linkProviderDisposable.dispose();
      linkProvider.dispose();
      hoverTooltip.remove();
      term.dispose();
    },
  };

  return handle;
}

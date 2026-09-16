import { inputDebug } from "./inputDebug";

// Zero-lag local echo overlay (plans/codeman-mobile-features.md Phase 2,
// reworked 2026-07-24 along the lines of VS Code's terminal type-ahead
// addon): every keystroke is forwarded to the PTY the moment it arrives —
// nothing is withheld, so the PTY always holds exactly what the user
// typed and no send/reconcile bookkeeping can corrupt it — while this
// overlay optimistically draws the in-flight tail (text sent whose real
// echo hasn't round-tripped yet) as absolutely-positioned spans over the
// terminal. Where VS Code verifies its predictions byte-by-byte against
// the PTY output stream, this verifies *state*: after each repaint it
// reads the screen, and once the real echo has caught up (or a timeout
// passes without it ever matching — a non-echoing program, or a wrap
// model gone stale) the overlay clears and reality shows through. The
// overlay is purely cosmetic: its worst failure mode is briefly stale
// pixels, never wrong input. Framework-free and engine-agnostic — takes a
// narrow adapter shaped exactly like TerminalEngineHandle's five
// LocalEcho primitives (T2a) so it works unchanged against either engine,
// and is unit-testable without one.

export interface LocalEchoAdapter {
  readonly cols: number;
  readLine(row: number): string;
  getCursor(): { col: number; row: number };
  isScrolledUp(): boolean;
  getCellMetrics(): { width: number; height: number };
  onRender(cb: () => void): () => void;
}

// Matched by shape (glyph + trailing space), not a fixed string — Claude
// Code's and Codex's prompts differ, and either could change between
// versions (LESSONS 2026-07-12: parse structure, not known strings). The
// space is a class, not a literal " " — Claude Code's Ink UI pads the glyph
// with a non-breaking space (U+00A0), presumably so the terminal never
// treats the gap as a wrap point, which a literal-space match silently
// never finds (confirmed live: readLine returns the glyph correctly, just
// followed by   instead of  ).
const PROMPT_GLYPHS = ["❯", ">"];
const PROMPT_GLYPH_PATTERNS = PROMPT_GLYPHS.map((g) => new RegExp(`${g}[  ]`));

// How the program that owns the pane rewraps a too-long input line — the
// overlay must predict the same cell positions the real echo will land on.
// "ink": Claude Code's Ink box (word wrap, hanging indent under the first
// row's text, final column reserved — see wrapPositions). "shell": a
// readline/zle line editor (character wrap into every column, continuation
// rows at column 0).
export type WrapMode = "ink" | "shell";

// Shells all share the zle/readline wrap behavior; anything else (Claude
// Code, Codex, other TUIs) keeps the ink model this overlay was built
// against. Matched against the window's foreground command; a login shell can
// report with a leading dash.
const SHELL_COMMANDS = new Set(["sh", "ash", "dash", "bash", "zsh", "fish", "ksh", "csh", "tcsh", "nu"]);
export function wrapModeForCommand(command: string): WrapMode {
  return SHELL_COMMANDS.has(command.trim().replace(/^-/, "").toLowerCase()) ? "shell" : "ink";
}

// Android IMEs (Samsung's keyboard among them) sometimes deliver the
// space between words as a non-breaking space (U+00A0) in both
// composition text and committed bursts. Normalized to a real space
// before sending AND before recording as expected — an NBSP forwarded
// raw would embed a literal \xc2\xa0 in the typed command, and the
// overlay must track exactly the bytes the PTY receives for checkSync's
// screen comparison to converge. Exported for TerminalView, which owns
// the sending half.
export function normalizeSpaces(text: string): string {
  return text.replace(/ /g, " ");
}

// How long the overlay may sit unmatched by the screen after the last
// keystroke before it clears itself and lets reality show through.
// Generous enough for a slow-mobile round trip; short enough that a
// diverged overlay (or a program that doesn't echo at all) self-heals
// rather than overpainting the screen indefinitely. VS Code's equivalent
// is max(500ms, 1.5x its measured latency); we don't measure latency.
const SYNC_TIMEOUT_MS = 2000;

export class LocalEcho {
  private readonly adapter: LocalEchoAdapter;
  private readonly container: HTMLDivElement;
  private readonly unsubRender: () => void;
  private cellMetrics: { width: number; height: number };
  // The input-area text the PTY should hold once every byte we've
  // forwarded has echoed: printables appended, backspaces removed. Built
  // exclusively from bytes ALREADY SENT — this module never sends
  // anything itself, so `expected` can drift from the screen only until
  // the echo lands (or checkSync gives up), never from the real input.
  private expected = "";
  // High-water mark of overlay cells drawn since capture. Cells between
  // the current text's end and this mark render as background-colored
  // covers: after a backspace the real screen still shows the deleted
  // char until the erase round-trips, and the cover hides it in the
  // meantime (VS Code's BackspacePrediction erases the buffer cell
  // directly; a DOM overlay can only paint over it). Beyond the stale
  // tail the covers sit over the input box's own padding spaces, where
  // they're invisible.
  private maxCells = 0;
  // When the last keystroke mutated this overlay — checkSync's timeout
  // baseline.
  private lastInputAt = 0;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  // Whether the most recent findAnchor() call landed on the prompt glyph
  // (true) or had to fall back to the raw cursor cell (false). A
  // glyph-anchored position is pinned to the prompt; the cursor-fallback
  // position, by definition, *is* the cursor, so render() only trusts an
  // anchored capture's row delta while the glyph is actually visible.
  private anchorIsStable = false;
  // Where the overlay's first char draws, captured once when the buffer
  // goes empty → non-empty and held until clear(). The prompt-glyph anchor
  // alone is only the start of the *input area* — the line can already hold
  // real text the buffer knows nothing about (a tab-completed path, text
  // typed before local echo activated, a recalled history entry), and the
  // cursor at first-keystroke time is exactly where new input will echo.
  // Never read live at render time: real PTY output arriving mid-typing
  // can move the cursor, which is the same re-basing hazard anchorIsStable
  // guards against. When the prompt glyph is visible the capture is
  // *anchored*: a column plus a row delta from the glyph, so streamed
  // output scrolling the prompt upward doesn't invalidate it. When no
  // glyph is visible (heavily themed shell prompts ending in other glyphs
  // entirely — powerlevel10k segments, "% ", "± " — or an Ink box mid-
  // redraw) the capture is *unanchored*: the absolute cursor cell,
  // re-located by line prefix after scrolls (findUnanchoredRow). null =
  // not captured yet (nothing typed since the last clear()).
  private startCol: number | null = null;
  private startAnchored = false;
  private startRowDelta = 0; // anchored captures: rows below the glyph row
  private startRow = 0; // unanchored captures: absolute row (fallback)
  // Unanchored captures: the line's text left of the start cell (the
  // prompt, plus any pre-existing input) — constant while the buffer is
  // alive, so findUnanchoredRow can re-locate the row after the screen
  // scrolls under the overlay.
  private startLinePrefix = "";
  // See WrapMode — owned by TerminalView, which knows the pane's current
  // foreground command; the overlay itself can't tell an Ink box from zle.
  wrapMode: WrapMode = "ink";
  // The text currently being IME-composed, shown but not yet committed by
  // the OS — never part of `expected`. Predictive keyboards deliver
  // nothing at all through the normal onData path until text commits, so
  // without this a phone typing a sentence shows nothing on screen — not
  // just zero lag lost, but indistinguishable from "typing doesn't work".
  // Display-only: nothing reaches the PTY until the OS commits the text
  // through the engine's normal onData path, at which point the commit
  // burst is forwarded (and lands in `expected`) like any other typed
  // text. An earlier iteration instead flushed completed words to the PTY
  // ahead of their commit, reconciling backspaces into the already-sent
  // prefix with counted \x7f erases — dropped 2026-07-24: that
  // reconciliation depended on per-vendor IME revision behavior the
  // browser only partially surfaces, and kept corrupting the input after
  // backspace on real devices. The forward-everything-immediately model
  // above replaced it.
  private composing = "";
  // The composition text as of the last clearComposing, and when it was
  // cleared — see clearComposing on engine commit ordering.
  private lastComposing = "";
  private lastComposingClearedAt = 0;

  constructor(overlayHost: HTMLElement, adapter: LocalEchoAdapter) {
    this.adapter = adapter;
    this.cellMetrics = adapter.getCellMetrics();
    this.container = document.createElement("div");
    this.container.className = "local-echo-overlay";
    overlayHost.appendChild(this.container);
    // Every repaint is a chance the real echo just landed: verify first
    // (checkSync may clear a caught-up overlay), then redraw whatever is
    // still in flight on top of the fresh frame.
    this.unsubRender = adapter.onRender(() => {
      this.checkSync();
      if (this.expected || this.composing || this.maxCells) this.render();
    });
  }

  // Restarts the sync-timeout clock — called on every keystroke-driven
  // mutation. The timer exists for the no-output case: if the PTY never
  // sends anything after our bytes (a non-echoing program), no repaint
  // fires checkSync, and the overlay would sit forever without it.
  private touch(): void {
    this.lastInputAt = performance.now();
    if (this.syncTimer !== null) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.checkSync(), SYNC_TIMEOUT_MS + 50);
  }

  // The caller has ALREADY forwarded the text to the PTY (or does so in
  // the same tick) — these only record it as expected and redraw.
  addChar(ch: string): void {
    this.appendText(ch);
  }

  appendText(rawText: string): void {
    this.captureStart();
    this.expected += normalizeSpaces(rawText);
    this.touch();
    this.render();
  }

  // The caller has already forwarded the \x7f; this records its effect.
  // Returns false when `expected` is empty — the backspace is erasing
  // real text the overlay never covered, so the caller should drop the
  // capture (clear()) and let the next keystroke re-read the cursor.
  removeChar(): boolean {
    if (!this.expected) return false;
    this.expected = this.expected.slice(0, -1);
    this.touch();
    this.render();
    return true;
  }

  // `text` is the IME's current full composition (compositionupdate's own
  // `data`), a replacement of the in-progress text each call, not an
  // incremental delta — never appended to. Display-only (see `composing`).
  setComposing(text: string): void {
    this.captureStart();
    this.composing = normalizeSpaces(text);
    this.touch();
    this.render();
  }

  // The composition ended (compositionend). Clears the transient preview —
  // never touches `expected`: the OS delivers the committed text through
  // the engine's normal onData path, which reaches `expected` like any
  // other typed burst. ghostty forwards that commit BEFORE its
  // compositionend listeners run; xterm defers it through a timer until
  // just AFTER — so the last composition is remembered briefly, letting
  // consumeCommitOverlap recognize a post-compositionend commit too.
  clearComposing(): void {
    if (!this.composing) return;
    this.lastComposing = this.composing;
    this.lastComposingClearedAt = performance.now();
    this.composing = "";
    this.render();
  }

  // The trailing partial word of `expected` — everything after its last
  // space. What an IME's recomposition can re-cover (they only ever
  // recompose the word the cursor touches, never across a space).
  private get expectedTail(): string {
    return this.expected.slice(this.expected.lastIndexOf(" ") + 1);
  }

  // How many leading chars of `text` re-cover text already sent, because
  // the IME silently restarted its composition over the word before the
  // cursor. Confirmed live on Gboard (2026-07-25): type "abc def",
  // backspace to "abc", type "xyz" — Gboard's composition becomes
  // "abcxyz" even though "abc" was already committed and sent, so both
  // the preview and the eventual commit burst would duplicate "abc"
  // without this. Gated on the composition itself covering the tail:
  // plain non-IME typing (hardware keyboards, paste) never matches.
  // Deliberately compared against `expected` AT THIS MOMENT: keyboards
  // that instead erase the word with real backspaces before re-inserting
  // it shrink `expected` first, so the overlap is 0 there and the full
  // burst goes through — both vendor behaviors resolve through this one
  // rule, with no per-vendor event modeling (which is what killed the
  // old flush-reconciliation design).
  private compositionOverlap(text: string): number {
    const tail = this.expectedTail;
    if (!tail || !text.startsWith(tail)) return 0;
    return tail.length;
  }

  // Router pre-send hook for printable bursts: while a composition
  // preview is live, an arriving burst is (both engines' ordering) that
  // composition's commit — strip the prefix that merely re-commits the
  // already-sent tail, and return only the bytes that should actually be
  // sent and recorded. "" means the commit was entirely a re-commit
  // (e.g. tapping the cursor next to a word makes Gboard recompose and
  // recommit it unchanged) and nothing should be sent.
  consumeCommitOverlap(text: string): string {
    const composition =
      this.composing ||
      (performance.now() - this.lastComposingClearedAt < 150 ? this.lastComposing : "");
    if (!composition || !composition.startsWith(this.expectedTail)) return text;
    return text.slice(this.compositionOverlap(text));
  }

  clear(): void {
    this.expected = "";
    this.composing = "";
    this.lastComposing = "";
    this.maxCells = 0;
    // Deliberately the ONLY reset point for the captured start. Emptying
    // through backspaces or a cancelled composition puts the cursor back on
    // the captured cell, so the capture stays valid there.
    this.startCol = null;
    if (this.syncTimer !== null) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.container.replaceChildren();
  }

  // The verification half of the type-ahead loop: compare the screen
  // against the overlay's cells. Once every expected char is really on
  // screen and every cover cell reads blank, the echo has fully caught up
  // — clearing the overlay changes nothing visually and re-arms the
  // capture for the next burst at a fresh cursor. If the screen still
  // hasn't matched SYNC_TIMEOUT_MS after the last keystroke, give up and
  // clear anyway: the pane isn't echoing (or is echoing something our
  // wrap model doesn't predict), and the screen — not the overlay — is
  // the truth worth showing. Never clears mid-composition: the preview is
  // the only visible feedback the user has for uncommitted text, and its
  // chars haven't been sent, so the screen can't match them anyway.
  private checkSync(): void {
    if (!this.expected && !this.composing && !this.maxCells) return;
    if (this.composing) return;
    if (this.adapter.isScrolledUp()) return;
    const padded = this.expected + " ".repeat(Math.max(0, this.maxCells - this.expected.length));
    const { start, indentCol } = this.computeStart();
    // A glyph-anchored capture can't be verified while the glyph is off
    // screen (mid-redraw): computeStart falls back to the live cursor,
    // which the capture was never relative to — a comparison there is
    // noise in both directions.
    if (this.startAnchored && !this.anchorIsStable) return;
    const positions = LocalEcho.wrapPositions(padded, start, indentCol, this.adapter.cols, this.wrapMode);
    let matched = true;
    let row = -1;
    let line = "";
    for (let i = 0; i < padded.length; i++) {
      const p = positions[i];
      if (p.row !== row) {
        row = p.row;
        line = this.adapter.readLine(row);
      }
      // readLine right-trims, so cells past the line's text read as
      // spaces — which is exactly what a cover cell (or an expected
      // trailing space) should compare equal to.
      if ((line[p.col] ?? " ") !== padded[i]) {
        matched = false;
        break;
      }
    }
    if (matched || performance.now() - this.lastInputAt > SYNC_TIMEOUT_MS) {
      inputDebug("sync", matched ? `match-clear "${this.expected}"` : `timeout-clear "${this.expected}"`);
      this.clear();
    }
  }

  // Cell metrics can change once an extension font finishes loading (a
  // fallback face measures differently) — re-read them and reposition
  // whatever's still pending. Called alongside the engine's own
  // refreshFonts() (see TerminalView's fontsVersion effect).
  refreshFont(): void {
    this.cellMetrics = this.adapter.getCellMetrics();
    this.render();
  }

  dispose(): void {
    this.unsubRender();
    this.container.remove();
  }

  // Bottom-up shape scan for a prompt glyph followed by a space, anchoring
  // just past it; falls back to the real cursor cell if no marker is
  // visible (keeps typing visible even if the scan misses).
  private findAnchor(): { col: number; row: number } {
    const cursor = this.adapter.getCursor();
    for (let row = cursor.row; row >= 0; row--) {
      const line = this.adapter.readLine(row);
      for (const pattern of PROMPT_GLYPH_PATTERNS) {
        const match = pattern.exec(line);
        if (match) {
          this.anchorIsStable = true;
          return { col: match.index + 2, row };
        }
      }
    }
    this.anchorIsStable = false;
    return cursor;
  }

  // Snapshot where the buffer's first char will echo — the cursor cell at
  // first-keystroke time (see startCol). Idempotent: no-op while a capture
  // is held, so every appendText/setComposing can call it unconditionally.
  private captureStart(): void {
    if (this.startCol !== null) return;
    const anchor = this.findAnchor();
    const cursor = this.adapter.getCursor();
    if (!this.anchorIsStable) {
      // No prompt glyph to pin to — an unanchored capture off the cursor
      // cell, re-located by line prefix when the screen scrolls (see
      // findUnanchoredRow). Under the old buffered model an Ink pane
      // could keep the live-cursor fallback instead (nothing was sent, so
      // the cursor never moved); with every byte forwarded immediately
      // the echo itself moves the cursor, and a live fallback would
      // re-draw the whole overlay after the real text, duplicating it.
      this.startCol = cursor.col;
      this.startRow = cursor.row;
      this.startLinePrefix = this.adapter.readLine(cursor.row).slice(0, cursor.col);
      this.startAnchored = false;
      return;
    }
    this.startAnchored = true;
    if (cursor.row < anchor.row || (cursor.row === anchor.row && cursor.col < anchor.col)) {
      // Cursor behind the glyph anchor (a scan that matched above the real
      // prompt) — trust the anchor, as before this capture existed.
      this.startCol = anchor.col;
      this.startRowDelta = 0;
      return;
    }
    this.startCol = cursor.col;
    this.startRowDelta = cursor.row - anchor.row;
  }

  // An unanchored capture has no glyph to re-find, but the screen still
  // scrolls under it: an input line wrapping on the bottom row pushes the
  // prompt up one, and a background job's output pushes it further. The
  // recorded startLinePrefix re-locates the row — same bottom-up scan as
  // findAnchor, keyed on text recorded from the live screen instead of a
  // known glyph. Falls back to the captured row when the prefix is blank
  // (nothing distinctive to match) or has scrolled off entirely.
  private findUnanchoredRow(): number {
    if (!this.startLinePrefix.trim()) return this.startRow;
    const cursor = this.adapter.getCursor();
    for (let row = cursor.row; row >= 0; row--) {
      if (this.adapter.readLine(row).startsWith(this.startLinePrefix)) return row;
    }
    return this.startRow;
  }

  // "shell" mode: zle/readline rely on the terminal's own autowrap — text
  // fills every column including the last, splits mid-word, and every
  // continuation row starts at column 0.
  //
  // "ink" mode: greedy word-wrap matching Ink's own box (confirmed live: it
  // never splits a word across rows, unlike a naive per-column wrap — which
  // put the overlay's wrap point wherever `cols` fell mid-word, several
  // columns off from the real terminal's, garbling every row after the
  // first divergence). Continuation rows re-indent to `indentCol` (the
  // input area's first column), not 0: Ink hangs wrapped input under the
  // first row's text, not under the "❯ " marker (confirmed live — the real
  // wrapped row starts two columns in, exactly matching the prompt prefix's
  // width). `start` can sit further right than `indentCol` when the line
  // already held text at capture time (see startCol).
  private static wrapPositions(
    text: string,
    start: { col: number; row: number },
    indentCol: number,
    cols: number,
    mode: WrapMode,
  ): { row: number; col: number }[] {
    const positions: { row: number; col: number }[] = [];
    if (mode === "shell") {
      let col = start.col;
      let row = start.row;
      for (let i = 0; i < text.length; i++) {
        if (col >= cols) {
          col = 0;
          row++;
        }
        positions.push({ row, col });
        col++;
      }
      return positions;
    }
    const tokens = text.match(/\S+\s*|\s+/g) ?? [];
    // Ink's box never lets text touch the terminal's final column — it
    // reserves it (so its cursor block always has a cell to render in),
    // wrapping a token whose end would cross it. Boundary established
    // empirically against real Claude Code (cols=43, prompt at col 2,
    // first line holding 35 chars + an inter-word space, so the next
    // token starts at col 38): a 4-char token ("ccc ", ending col 41)
    // stayed; 5- and 6-char tokens ("bbbb ", "bbbbb ", crossing col 42)
    // both wrapped. The token's trailing space counts toward the fit —
    // an unsent word sits one column further left than word+space will,
    // and visibly hops down a row the moment its space is typed, exactly
    // when the real box re-wraps it too.
    const edge = cols - 1;
    let col = start.col;
    let row = start.row;
    for (const token of tokens) {
      // Only wrap-before-token if the token isn't the first thing on this
      // row (a token wider than the whole row would loop forever waiting
      // for space that never comes) and it doesn't fit in what's left.
      if (col > indentCol && col + token.length > edge) {
        col = indentCol;
        row++;
      }
      for (let j = 0; j < token.length; j++) {
        if (col >= edge) {
          col = indentCol;
          row++;
        }
        positions.push({ row, col });
        col++;
      }
    }
    // Defensive: text.match can't undercount, but keep positions.length in
    // lockstep with text.length regardless.
    while (positions.length < text.length) {
      if (col >= edge) {
        col = indentCol;
        row++;
      }
      positions.push({ row, col });
      col++;
    }
    return positions;
  }

  // The start cell and hanging-indent column the overlay draws (and
  // checkSync verifies) against. An anchored capture is only trusted
  // while the glyph anchor is: its row delta is relative to the glyph,
  // and the cursor-fallback anchor tracks a cursor the capture was taken
  // to be independent of. An unanchored capture is its own absolute cell.
  private computeStart(): { start: { col: number; row: number }; indentCol: number } {
    const anchor = this.findAnchor();
    let start = anchor;
    if (this.startCol !== null) {
      if (!this.startAnchored) start = { col: this.startCol, row: this.findUnanchoredRow() };
      else if (this.anchorIsStable) start = { col: this.startCol, row: anchor.row + this.startRowDelta };
    }
    return { start, indentCol: anchor.col };
  }

  private render(): void {
    this.container.replaceChildren();
    // A recomposition's preview re-covers the tail of `expected` (see
    // compositionOverlap) — draw only the genuinely new part, or the
    // overlay would show the shared prefix twice, side by side.
    const composingVisible = this.composing.slice(this.compositionOverlap(this.composing));
    const text = this.expected + composingVisible;
    if (text.length > this.maxCells) this.maxCells = text.length;
    if (!this.maxCells || this.adapter.isScrolledUp()) return;
    // Covers need a held capture to be positioned from; without one (and
    // with no text, which would capture on append) there's nothing to
    // draw over.
    if (!text && this.startCol === null) return;
    const { start, indentCol } = this.computeStart();
    const { width, height } = this.cellMetrics;
    const cols = this.adapter.cols;
    const frag = document.createDocumentFragment();
    // Cells between the text's end and the high-water mark draw as
    // background-colored blanks — see maxCells.
    const padded = text + " ".repeat(this.maxCells - text.length);
    const positions = LocalEcho.wrapPositions(padded, start, indentCol, cols, this.wrapMode);
    for (let i = 0; i < padded.length; i++) {
      const { row, col } = positions[i];
      const span = document.createElement("span");
      // Composing (not-yet-committed) chars get their own class — matches
      // the underline convention native IME composition renders with, so
      // there's still a visible cue that this part hasn't committed yet.
      span.className =
        i < this.expected.length
          ? "local-echo-char"
          : i < text.length
            ? "local-echo-char local-echo-char-composing"
            : "local-echo-char local-echo-char-cover";
      span.textContent = padded[i];
      span.style.left = `${col * width}px`;
      span.style.top = `${row * height}px`;
      span.style.width = `${width}px`;
      span.style.height = `${height}px`;
      // Overrides the CSS line-height (var(--terminal-line-height), a
      // unitless multiplier meaning "x times the font's own size" per CSS
      // semantics) with the actual measured cell height in px. The
      // engine's lineHeight *setting* means something different — "x times
      // the font's own measured natural line height" — so even the
      // default value of 1 resolves to a different, smaller number
      // (fontSize itself, e.g. 14px) than the real terminal's actual
      // per-cell line height (e.g. 18px, IBM Plex Mono's natural metric)
      // — visibly shrinking and mispositioning every overlay glyph inside
      // its own (correctly sized) cell box.
      span.style.lineHeight = `${height}px`;
      frag.appendChild(span);
    }
    this.container.appendChild(frag);
  }
}

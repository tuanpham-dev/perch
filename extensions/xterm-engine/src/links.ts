// xterm.js link-provider adapter — moved from core terminalLinks.ts (whose
// generic candidate detection stayed core, shared via the
// @perch/engine-support shim) when the engine became this extension.
import type { IBufferRange, ILink as XtermILink, ILinkProvider as XtermILinkProvider, Terminal as XtermTerminal } from "@xterm/xterm";
import { findCandidates, isOpenGesture, MAX_STITCH_LINES } from "@perch/engine-support";
import type { PaneLine, ScreenCell } from "../../_shared/terminalEngineTypes";

// xterm.js counterpart to stitchLine above — same wrapped-row-stitching
// logic, but against xterm's IBuffer/IBufferLine shapes (getLine/
// translateToString match ghostty-web's signatures exactly; only the
// Terminal type differs). `y` is a 0-based scrollback-ABSOLUTE buffer row
// (IBuffer.getLine's own index space), and the returned startLine is in
// that same space — callers holding a screen-relative row must offset by
// buffer.baseY themselves (see the engine's readStitchedLine).
export function stitchXtermLine(term: XtermTerminal, y: number): { text: string; startLine: number } | null {
  const buffer = term.buffer.active;
  if (y < 0 || y >= buffer.length) return null;
  let startLine = y;
  for (let i = 0; i < MAX_STITCH_LINES && buffer.getLine(startLine)?.isWrapped; i++) {
    startLine--;
  }
  const cols = term.cols;
  const parts: string[] = [];
  let endLine = startLine;
  for (let i = 0; i < MAX_STITCH_LINES; i++) {
    const line = buffer.getLine(endLine);
    if (!line) break;
    parts.push(line.translateToString(false, 0, cols));
    const next = buffer.getLine(endLine + 1);
    if (!next?.isWrapped) break;
    endLine++;
  }
  if (!parts.length) return null;
  return { text: parts.join(""), startLine };
}

// 0-based buffer-index -> xterm's IBufferCellPosition, which (unlike
// ghostty-web's 0-based, raw-compared range) is documented 1-based on both
// axes — verified against @xterm/xterm 6.0.0's typings (IBufferCellPosition:
// "The x/y position within the buffer (1-based)"). startLine is the 0-based
// absolute row stitchXtermLine returned, so +1 converts row space too.
function indexToXtermPosition(
  startLine: number,
  cols: number,
  idx: number,
): { x: number; y: number } {
  return { y: startLine + Math.floor(idx / cols) + 1, x: (idx % cols) + 1 };
}

// A provided link plus what it actually points at — the engine forwards
// these fields to the host as a HoveredLink so a context menu can label and
// copy the real target (already resolved, for a path) rather than the
// visible cell text.
export interface XtermDetectedLink extends XtermILink {
  kind: "url" | "path";
  target: string;
  line?: number;
}

export interface XtermTerminalLinksHandlers {
  resolvePaths: (paths: string[], cells?: (ScreenCell | null)[]) => Promise<(string | null)[]>;
  readPaneLines?: (row: number) => Promise<PaneLine[]>;
  onOpenUrl: (url: string) => void;
  onOpenFile: (path: string, line?: number) => void;
  onOpenFileSecondary: (path: string, line?: number) => void;
  // Fired with the ILink under the pointer (or null on leave) — same shape
  // as ghostty-web's onHoverChange, so the caller's tooltip can read
  // link.text and its own activate(e, link.text) either way.
  onHoverChange: (link: XtermDetectedLink | null) => void;
}

// Vertical pane-border glyphs tmux draws between side-by-side panes
// (pane-border-lines single / heavy / double). A row containing one may hold
// a path tmux wrapped with a hard line break, so it's worth asking the
// server for the rejoined pane lines; other rows never pay that request.
const PANE_BORDER = /[│┃║]/;

// Just past the host resolver's not-found TTL (MISSING_TTL_MS = 2000 in
// client/src/pathResolver.ts), so a re-check actually reaches the server.
const RECHECK_MS = 2_050;
const MAX_RECHECKS = 30;

// The xterm linkifier fields the hover re-check needs. Private API, verified
// present (unmangled) in @xterm/xterm 6.0.0's lib bundle: xterm caches a
// row's provider reply until the pointer changes rows, so without re-asking
// through it, a path whose file appears while the pointer rests on its row
// stays plain until the pointer moves off and back.
interface PrivateLinkifier {
  _isMouseOut?: boolean;
  _currentLink?: unknown;
  _lastBufferCell?: { x: number; y: number };
  _askForLink?: (position: { x: number; y: number }, useLineCache: boolean) => void;
}

interface Found {
  kind: "url" | "path";
  text: string;
  target: string;
  line?: number;
  range: IBufferRange;
  cell: ScreenCell | null;
}

export function buildXtermLinkProvider(
  term: XtermTerminal,
  handlers: XtermTerminalLinksHandlers,
): XtermILinkProvider & { dispose(): void } {
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;
  let recheckRow = -1;
  let recheckCount = 0;

  const scheduleRecheck = (y: number) => {
    if (recheckCount >= MAX_RECHECKS) return;
    recheckTimer = setTimeout(() => {
      const linkifier = (term as unknown as { _core?: { linkifier?: PrivateLinkifier } })._core?.linkifier;
      const cell = linkifier?._lastBufferCell;
      if (!linkifier?._askForLink || !cell || linkifier._isMouseOut || linkifier._currentLink) return;
      if (cell.y !== y) return;
      recheckCount++;
      linkifier._askForLink(cell, false);
    }, RECHECK_MS);
  };

  return {
    dispose() {
      clearTimeout(recheckTimer);
    },
    provideLinks(y, callback) {
      clearTimeout(recheckTimer);
      if (y !== recheckRow) {
        recheckRow = y;
        recheckCount = 0;
      }
      // Linkifier passes a 1-BASED buffer line: getCoords' Math.ceil'd
      // viewport row plus buffer.ydisp (verified against @xterm/xterm
      // 6.0.0's Linkifier._positionFromMouseEvent / input/Mouse.getCoords).
      // Converting to the 0-based absolute row stitchXtermLine/getLine use
      // is a plain -1 — no baseY juggling, and it stays correct however
      // much local scrollback has accumulated. (The old code subtracted
      // baseY from an assumed-0-based y, which put every link range one
      // row below the pointer and, once output scrolled, scanned lines
      // from the top of scrollback instead of the viewport.)
      const absRow = y - 1;
      const stitched = stitchXtermLine(term, absRow);
      if (!stitched) {
        callback(undefined);
        return;
      }
      const { text, startLine } = stitched;
      const cols = term.cols;
      // Screen rows are measured from baseY (the top of the live screen,
      // which is what tmux's pane layout describes), captured now so a
      // scroll during the round trips can't skew the mapping.
      const baseY = term.buffer.active.baseY;
      const liveRow = (absLine: number) => {
        const row = absLine - baseY;
        return row >= 0 && row < term.rows ? row : null;
      };

      const found: Found[] = findCandidates(text).map((c) => {
        const row = liveRow(startLine + Math.floor(c.startIdx / cols));
        return {
          kind: c.kind,
          text: c.text,
          target: c.target,
          line: c.line,
          range: {
            start: indexToXtermPosition(startLine, cols, c.startIdx),
            end: indexToXtermPosition(startLine, cols, c.endIdx - 1),
          },
          cell: row === null ? null : { row, col: c.startIdx % cols },
        };
      });

      const hoveredLive = liveRow(absRow);
      const paneLines =
        handlers.readPaneLines && hoveredLive !== null && PANE_BORDER.test(text)
          ? handlers.readPaneLines(hoveredLive).catch(() => [] as PaneLine[])
          : Promise.resolve([] as PaneLine[]);

      paneLines
        .then((lines) => {
          // Paths tmux wrapped inside a split pane: detected on the rejoined
          // text, kept only when they really span rows (single-row ones are
          // already in `found`), and mapped back through the pane's own
          // left edge and width. Their range is contiguous in xterm's
          // reading order, so on all but the last row the underline also
          // covers the neighbouring pane — xterm ranges can't skip cells.
          const wrapped: Found[] = [];
          for (const pane of lines) {
            for (const c of findCandidates(pane.text)) {
              const firstRow = Math.floor(c.startIdx / pane.width);
              const lastRow = Math.floor((c.endIdx - 1) / pane.width);
              if (c.kind !== "path" || firstRow === lastRow) continue;
              const start = { row: pane.startRow + firstRow, col: pane.left + (c.startIdx % pane.width) };
              const end = { row: pane.startRow + lastRow, col: pane.left + ((c.endIdx - 1) % pane.width) };
              wrapped.push({
                kind: "path",
                text: c.text,
                target: c.target,
                line: c.line,
                range: {
                  start: { x: start.col + 1, y: start.row + baseY + 1 },
                  end: { x: end.col + 1, y: end.row + baseY + 1 },
                },
                cell: start.row >= 0 ? start : null,
              });
            }
          }
          const linear = (p: { x: number; y: number }) => p.y * (cols + 1) + p.x;
          const overlaps = (a: IBufferRange, b: IBufferRange) =>
            linear(a.start) <= linear(b.end) && linear(b.start) <= linear(a.end);
          const all = [...found.filter((f) => !wrapped.some((w) => overlaps(w.range, f.range))), ...wrapped];
          if (!all.length) {
            callback(undefined);
            return;
          }

          const pathItems = all.filter((f) => f.kind === "path");
          // A failed lookup leaves the paths unlinked, never the whole row:
          // URLs on the same line don't depend on it.
          const resolve = pathItems.length
            ? handlers
                .resolvePaths(
                  pathItems.map((f) => f.target),
                  pathItems.map((f) => f.cell),
                )
                .catch(() => pathItems.map(() => null))
            : Promise.resolve<(string | null)[]>([]);

          return resolve.then((resolved) => {
            const links: XtermDetectedLink[] = [];
            let pathIdx = 0;
            let missing = false;
            for (const f of all) {
              let openTarget: string | undefined = f.target;
              if (f.kind === "path") {
                openTarget = resolved[pathIdx] ?? undefined;
                pathIdx++;
                if (!openTarget) {
                  missing = true;
                  continue;
                }
              }
              const { kind, line } = f;
              const target = openTarget;
              const link: XtermDetectedLink = {
                range: f.range,
                text: f.text,
                kind,
                target,
                line,
                activate(event) {
                  if (!isOpenGesture(event)) return;
                  if (kind === "url") {
                    handlers.onOpenUrl(target);
                  } else if (event.shiftKey) {
                    handlers.onOpenFileSecondary(target, line);
                  } else {
                    handlers.onOpenFile(target, line);
                  }
                },
                hover: () => handlers.onHoverChange(link),
                leave: () => handlers.onHoverChange(null),
              };
              links.push(link);
            }
            callback(links.length ? links : undefined);
            if (missing) scheduleRecheck(y);
          });
        })
        .catch(() => callback(undefined));
    },
  };
}

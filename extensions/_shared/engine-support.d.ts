// Types for the "@perch/engine-support" runtime shim (see
// shims/engine-support.mjs) — the host's engine-support helpers, exposed to
// extension bundles the same way React is. Signatures mirror the host
// modules they re-export (client/src: mouseReports.ts, terminalLinks.ts,
// engines/types.ts, contrast.ts).
declare module "@perch/engine-support" {
  export function cellFromPoint(
    x: number,
    y: number,
    rect: { left: number; top: number },
    charWidth: number,
    charHeight: number,
    cols: number,
    rows: number,
  ): { col: number; row: number };

  export interface Candidate {
    kind: "url" | "path";
    startIdx: number;
    endIdx: number;
    text: string;
    target: string;
    line?: number;
  }
  export function findCandidates(text: string): Candidate[];

  export function isOpenGesture(event: MouseEvent): boolean;
  export function openUrl(url: string): void;
  export const MAX_STITCH_LINES: number;

  export function markSyntheticSelectStart(event: MouseEvent): void;
  export function isSyntheticSelectStart(event: MouseEvent): boolean;

  export type Rgb = readonly [number, number, number];
  export function ensureContrastRatio(fg: Rgb, bg: Rgb, ratio: number): Rgb | undefined;

  // Terminal input utilities (client/src/lib/terminalInput.ts) — shared
  // with the touch-keys extension.
  export function whenMatches(when: string, command: string): boolean;
  export function sendWithInkSafeEnters(data: string, send: (chunk: string) => void): void;

  // Copy-time wrapped-line joining (client/src/selectionText.ts). Range is
  // 0-based, buffer-absolute, end column EXCLUSIVE — engines normalize
  // their own getSelectionPosition() semantics before calling (xterm 6:
  // already exclusive; ghostty-web 0.4: inclusive, pass end.x + 1).
  export interface SelectionRangeExclusive {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  }
  export interface SelectionBufferCell {
    getChars(): string;
    getWidth(): number;
  }
  export interface SelectionBufferLine {
    readonly isWrapped: boolean;
    translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
    getCell?(x: number): SelectionBufferCell | undefined;
  }
  export interface SelectionTextTerminal {
    readonly cols: number;
    buffer: { active: { getLine(y: number): SelectionBufferLine | null | undefined } };
  }
  export function joinedSelectionText(term: SelectionTextTerminal, range: SelectionRangeExclusive): string;

  // Joins the line breaks a PROGRAM made while word-wrapping its own output
  // (a renderer like Ink emits a real "\n" plus a continuation indent).
  // Deliberately lossy — code and command output collapse to one line per
  // block — so apply it only for the "paragraph" copy mode or a per-copy
  // "Copy as Paragraph" action, never on the default copy path. Idempotent.
  export function unwrapParagraphs(text: string): string;
}

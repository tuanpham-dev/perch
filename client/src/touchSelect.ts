// Word/link range computation for touch long-press selection
// (plans/mobile-touch-select-copy-open.md) — engine-agnostic and pure so it's
// unit-testable without a live terminal. Reuses terminalLinks.ts's regex
// detector so a pressed URL/path selects its full (punctuation-trimmed,
// line-suffix-aware) span rather than just the whitespace-delimited word
// under the finger.
import { findCandidates, type Candidate } from "./terminalLinks";

export interface SelectionRange {
  startIdx: number;
  endIdx: number;
  text: string;
  candidate: Candidate | null;
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

// idx is a 0-based index into `text` (the same linear buffer-index space
// terminalLinks.ts's Candidate.startIdx/endIdx use). Returns null when the
// pressed cell has no content to select (whitespace, or past the end of the
// stitched line).
export function rangeAt(text: string, idx: number): SelectionRange | null {
  if (idx < 0 || idx >= text.length) return null;
  if (isWhitespace(text[idx])) return null;

  for (const c of findCandidates(text)) {
    if (idx >= c.startIdx && idx < c.endIdx) {
      return { startIdx: c.startIdx, endIdx: c.endIdx, text: c.text, candidate: c };
    }
  }

  let start = idx;
  while (start > 0 && !isWhitespace(text[start - 1])) start--;
  let end = idx + 1;
  while (end < text.length && !isWhitespace(text[end])) end++;
  return { startIdx: start, endIdx: end, text: text.slice(start, end), candidate: null };
}

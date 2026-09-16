// See react.mjs — same single-instance rationale, for the host's terminal
// engine-support helpers. These MUST be the host's own instances:
// markSyntheticSelectStart tags events with a module-private Symbol that
// TerminalView's isSyntheticSelectStart checks, and findCandidates shares
// the host's regexes/behavior — a bundled copy would silently disagree.
const ES = window.__perchModules["@perch/engine-support"];
export const {
  cellFromPoint,
  findCandidates,
  isOpenGesture,
  openUrl,
  MAX_STITCH_LINES,
  markSyntheticSelectStart,
  isSyntheticSelectStart,
  ensureContrastRatio,
  whenMatches,
  sendWithInkSafeEnters,
  joinedSelectionText,
  unwrapParagraphs,
} = ES;
export default ES;

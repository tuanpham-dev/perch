// Prefixed forms (/abs, ~/, ./, ../) are unambiguous — greedily consume
// everything up to whitespace/quote/bracket. ":" is excluded from the class
// so a trailing ":line[:col]" suffix (matched separately below) isn't eaten
// into the path itself.
const PREFIXED_PATH = /(?:~\/|\.{1,2}\/|\/)[^\s"'`<>|:]+/;
// Windows forms, just as unambiguous: a drive path ("C:\\src\\app.ts",
// "C:/src") or a dot-relative one with backslashes (".\\src\\app.ts").
const WINDOWS_PATH = /(?:\b[A-Za-z]:[\\/]|\.{1,2}\\)[^\s"'`<>|:]+/;
// Bare relative path with at least one "/" (e.g. "src/app.ts").
const SLASHED_PATH = /\b[\w.-]+\/[\w./-]+/;
// Bare filename with an extension (e.g. "README.md"). The extension must
// start with a letter, not a digit — otherwise "3.14" reads as a file named
// "3" with extension "14".
const NAMED_FILE = /\b[\w-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b/;
// Well-known files with no extension (or only a leading dot) that the forms
// above can't see when printed bare — "Makefile", "LICENSE", ".gitignore".
// A fixed list rather than any bare word, so ordinary prose never turns into
// an existence check. The slashed and prefixed forms already cover
// "docker/Dockerfile" and "./Makefile", so this only needs the bare name.
const KNOWN_NAMES = [
  "Makefile", "makefile", "GNUmakefile", "Dockerfile", "Containerfile", "Jenkinsfile",
  "Vagrantfile", "Gemfile", "Rakefile", "Procfile", "Brewfile", "Justfile", "justfile",
  "Caddyfile", "Taskfile", "LICENSE", "LICENCE", "COPYING", "README", "CHANGELOG",
  "AUTHORS", "NOTICE", "CODEOWNERS", ".gitignore", ".gitattributes", ".dockerignore",
  ".editorconfig", ".env", ".npmrc", ".nvmrc", ".prettierrc", ".bashrc", ".zshrc", ".profile",
];
// Lookarounds instead of \b: \b can't anchor before a leading dot, and the
// trailing check has to let "LICENSE." (sentence end) through while
// rejecting "Makefile.bak" or "README-old".
const KNOWN_FILE = new RegExp(
  `(?<![\\w./~-])(?:${KNOWN_NAMES.map((n) => n.replace(/\./g, "\\.")).join("|")})(?![\\w-]|\\.\\w)`,
);

// KNOWN_FILE is last so the :line[:col] group (m[1]) stays shared by all.
const PATH_RE = new RegExp(
  `(?:${WINDOWS_PATH.source}|${PREFIXED_PATH.source}|${SLASHED_PATH.source}|${NAMED_FILE.source}|${KNOWN_FILE.source})(?::(\\d+)(?::\\d+)?)?`,
  "g",
);

const URL_RE = /\bhttps?:\/\/[^\s"'`<>|]+/g;

// Trailing punctuation that's almost always sentence/bracket decoration
// rather than part of the link itself (mirrors how browsers/mail clients
// trim autolinked URLs).
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

export interface Candidate {
  kind: "url" | "path";
  startIdx: number;
  endIdx: number;
  text: string;
  target: string; // URL, or path with any :line[:col] suffix stripped
  line?: number;
}

export function findCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];

  for (const m of text.matchAll(URL_RE)) {
    const trimmed = trimTrailing(m[0]);
    if (!trimmed.length) continue;
    const startIdx = m.index!;
    out.push({ kind: "url", startIdx, endIdx: startIdx + trimmed.length, text: trimmed, target: trimmed });
  }

  for (const m of text.matchAll(PATH_RE)) {
    let raw = m[0];
    const lineStr = m[1];
    // Trim trailing punctuation only when there's no :line suffix already
    // anchoring the match's real end (a suffix digit is never punctuation).
    const trimmed = lineStr ? raw : trimTrailing(raw);
    if (!trimmed.length) continue;
    raw = trimmed;
    const startIdx = m.index!;
    const target = lineStr ? raw.slice(0, raw.indexOf(":" + lineStr)) : raw;
    out.push({
      kind: "path",
      startIdx,
      endIdx: startIdx + raw.length,
      text: raw,
      target,
      line: lineStr ? Number(lineStr) : undefined,
    });
  }

  return out;
}

function trimTrailing(s: string): string {
  return s.replace(TRAILING_PUNCT, "");
}

// Defensive cap on how many buffer rows a single wrapped logical line can
// stitch across — a pathological giant single-line blob (minified JSON,
// etc.) shouldn't make every hover walk thousands of rows. Consumed by the
// engine extensions' own stitchers (each engine's buffer API differs) via
// the @perch/engine-support shim.
export const MAX_STITCH_LINES = 500;

// ---- Paths a program broke across rows ----
//
// The terminal records its own soft wraps, and every engine's stitcher
// rejoins them before detection runs. A program that word-wraps its own
// output writes real newlines instead, so a path caught by one of those is
// two unrelated lines as far as the buffer — and therefore the detector —
// can see. On a desktop-width pane that barely ever happens; on a phone,
// where Claude Code's box leaves around forty columns, it happens to nearly
// every path it prints, so the terminal stops offering links at exactly the
// width where reaching a file by hand is hardest.
//
// Rejoining two rows is a guess, so it stays narrow: the first row has to
// have genuinely run out of room, and the halves have to read as one path
// once joined. Callers try the unjoined candidate first and only fall back
// to this one, and every path goes through the same existence check as any
// other — so a wrong guess resolves to nothing and is quietly dropped.

// How many columns a row may leave unused and still count as "full". A
// program wrapping at the pane's width usually stops a column or two short:
// Ink (Claude Code's renderer) reserves the final column outright, and a
// wrap decision made on the *next* word can leave a little more.
const WRAP_SLACK = 2;

export interface WrappedPath {
  /** The whole path, both halves, with any :line[:col] suffix stripped. */
  target: string;
  line?: number;
  /** Where the path starts in the first row. */
  headStart: number;
  /** Where it resumes in the second row, and how much of it that row holds. */
  contStart: number;
  contLength: number;
}

/**
 * The path split between `head` (one row's own text, right-padding and all)
 * and `cont` (the row under it), or null when those two rows don't read as
 * one. Both rows are given as the terminal prints them; `cols` is the pane's
 * width.
 */
export function joinWrappedPath(head: string, cont: string, cols: number): WrappedPath | null {
  const headText = head.replace(/\s+$/, "");
  // Room to spare at the end means the program chose to stop there.
  if (!headText || headText.length > cols || cols - headText.length > WRAP_SLACK) return null;
  const headStart = Math.max(headText.lastIndexOf(" "), headText.lastIndexOf("\t")) + 1;
  const headToken = headText.slice(headStart);
  if (!headToken) return null;
  // The continuation keeps the block's own indent, which isn't part of the path.
  const contStart = cont.length - cont.replace(/^\s+/, "").length;
  const contToken = /^\S+/.exec(cont.slice(contStart))?.[0];
  if (!contToken) return null;
  const joined = headToken + contToken;
  const candidate = findCandidates(joined).find((c) => c.kind === "path" && c.startIdx === 0);
  // Nothing to gain unless the match actually crosses the break: a path that
  // ends on the first row is the ordinary single-row case, already detected.
  if (!candidate || candidate.endIdx <= headToken.length) return null;
  return {
    target: candidate.target,
    line: candidate.line,
    headStart,
    contStart,
    contLength: candidate.endIdx - headToken.length,
  };
}

export function isOpenGesture(event: MouseEvent): boolean {
  return event.ctrlKey || event.metaKey;
}

export function openUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

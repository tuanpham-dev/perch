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

export function isOpenGesture(event: MouseEvent): boolean {
  return event.ctrlKey || event.metaKey;
}

export function openUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

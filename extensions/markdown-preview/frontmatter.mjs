// Pure YAML-frontmatter model for the preview — the split and the
// value-to-text reduction, kept out of src/client.tsx so `node --test` can
// exercise them without a bundler or a DOM (same pattern as git-scm's
// statusModel.mjs). Tested by frontmatter.test.mjs.

// A frontmatter block is the "---" fence a file opens with, and Markdown
// itself has no notion of it: a plain renderer reads the opening fence as a
// horizontal rule and the keys under it as a setext heading, which is what
// every skill/agent/plugin file looked like in this preview — a rule, then
// one run-on heading with the indentation flattened out of it. A leading BOM
// is tolerated, and "..." closes a block as well as "---" (both are YAML
// document enders, and some generators emit the former).
const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * Splits a Markdown file into its frontmatter block (the raw YAML between the
 * fences, without them) and the body that follows. `meta` is null when the
 * file doesn't open with a block, in which case `body` is the input unchanged.
 */
export function splitFrontmatter(raw) {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { meta: null, body: raw };
  return { meta: match[1], body: raw.slice(match[0].length) };
}

/**
 * One frontmatter value as a single line of text, or null when it has a shape
 * worth keeping (a map, or a list of maps) and the caller should render it as
 * a nested table instead. Scalars speak for themselves; a list of scalars
 * reads better joined than stacked.
 */
export function scalarText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    if (value.some((item) => item !== null && typeof item === "object" && !(item instanceof Date))) return null;
    return value.map((item) => scalarText(item)).join(", ");
  }
  return null;
}

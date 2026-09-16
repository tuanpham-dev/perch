// Conflict-marker parsing shared by src/client.tsx's ConflictView and this
// file's own tests — extracted out of client.tsx so it can run under plain
// `node --test` with no build step, the same pattern as statusModel.mjs.
//
// Splits a working-tree file's lines into alternating plain-text runs and
// conflict blocks, keyed by line range in `lines` so a resolution can splice
// the original array rather than reconstructing untouched text byte-for-
// byte. Handles both the default 2-way marker set and the diff3/zdiff3
// 3-way set (an extra "||||||| <base label>" section) — see git's
// merge.conflictStyle setting.
//
// Marker matching strips a trailing "\r" before comparing so a CRLF-line-
// ended file (git never rewrites the marker lines it inserts to match the
// file's own line endings, but doesn't strip a pre-existing "\r" either) is
// recognized the same as an LF file; the stored ours/base/theirs/text
// slices keep each line's original bytes (any "\r" included) untouched, so
// a CRLF file round-trips through buildResolvedContent unchanged.
function stripCR(line) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export function parseConflictSegments(lines) {
  const segments = [];
  let i = 0;
  let textStart = 0;

  const flushText = (end) => {
    if (end >= textStart) segments.push({ kind: "text", start: textStart, end });
  };

  while (i < lines.length) {
    if (!stripCR(lines[i]).startsWith("<<<<<<< ")) {
      i++;
      continue;
    }
    const start = i;
    const oursLabel = stripCR(lines[i]).slice("<<<<<<< ".length);
    i++;
    const oursStart = i;
    while (i < lines.length && !stripCR(lines[i]).startsWith("|||||||") && stripCR(lines[i]) !== "=======") i++;
    const ours = lines.slice(oursStart, i);

    let base;
    let baseLabel;
    if (i < lines.length && stripCR(lines[i]).startsWith("|||||||")) {
      baseLabel = stripCR(lines[i]).slice("||||||| ".length);
      i++;
      const baseStart = i;
      while (i < lines.length && stripCR(lines[i]) !== "=======") i++;
      base = lines.slice(baseStart, i);
    }

    if (i >= lines.length) {
      // No "=======" found — malformed/unterminated marker. Bail out and
      // let the trailing flushText below cover the rest as plain text
      // rather than guessing at a boundary.
      break;
    }
    i++; // skip "======="

    const theirsStart = i;
    while (i < lines.length && !stripCR(lines[i]).startsWith(">>>>>>> ")) i++;
    if (i >= lines.length) {
      // No closing ">>>>>>>" — same malformed-file bailout as above.
      break;
    }
    const theirs = lines.slice(theirsStart, i);
    const theirsLabel = stripCR(lines[i]).slice(">>>>>>> ".length);
    const end = i;

    flushText(start - 1);
    segments.push({ kind: "conflict", start, end, oursLabel, theirsLabel, ours, base, baseLabel, theirs });
    i = end + 1;
    textStart = i;
  }

  flushText(lines.length - 1);
  return segments;
}

export function buildResolvedContent(lines, segments, resolutions) {
  const out = [];
  for (const seg of segments) {
    if (seg.kind === "text") {
      out.push(...lines.slice(seg.start, seg.end + 1));
      continue;
    }
    const choice = resolutions[seg.start];
    if (!choice) {
      // Still undecided — keep the raw marker block as-is.
      out.push(...lines.slice(seg.start, seg.end + 1));
      continue;
    }
    out.push(...(choice === "ours" ? seg.ours : choice === "theirs" ? seg.theirs : [...seg.ours, ...seg.theirs]));
  }
  return out.join("\n");
}

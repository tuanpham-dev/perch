// The COMMITS search box's grammar, split out of the client so it can run
// under plain `node --test` — same reason statusModel.mjs and
// conflictModel.mjs live beside their panel code rather than inside it.
//
// One box, three git filters. Whitespace-separated terms; "author:" and
// "path:" claim their own term, everything else is message text:
//
//   sidebar headers            --grep="sidebar headers"
//   author:tuan path:server    --author=tuan -- server
//   fix author:tuan            --grep=fix --author=tuan
//
// A prefix with nothing after it ("author:") is dropped rather than turned
// into an empty filter that would match everything. A repeated prefix keeps
// the last one, the way a second --author on a command line wins.

const PREFIXES = { "author:": "author", "path:": "path" };

/**
 * @param {string} text
 * @returns {{ grep: string, author: string, path: string }}
 */
export function parseSearchQuery(text) {
  const out = { grep: "", author: "", path: "" };
  const words = [];
  for (const term of String(text ?? "").split(/\s+/)) {
    if (!term) continue;
    const prefix = Object.keys(PREFIXES).find((p) => term.toLowerCase().startsWith(p));
    if (prefix) {
      const value = term.slice(prefix.length).trim();
      if (value) out[PREFIXES[prefix]] = value;
      continue;
    }
    words.push(term);
  }
  out.grep = words.join(" ");
  return out;
}

/**
 * True when a parsed query would filter anything at all — an all-empty
 * parse (a blank box, or "author:" alone) means show the plain log.
 * @param {{ grep: string, author: string, path: string }} query
 */
export function hasFilters(query) {
  return Boolean(query.grep || query.author || query.path);
}

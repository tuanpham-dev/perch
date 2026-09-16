// Server hook for the search extension — a VS Code-style SEARCH panel:
// search and replace across every file under the active folder.
//
// cwd trusted the same way git-scm's server hook trusts it: single-user
// local dev tool gated on Host/Origin (see server/src/security.ts), client
// always supplies cwd from its own already-trusted active context.
//
// Three engines: ripgrep (preferred — respects .gitignore, real glob support,
// reports columns natively), grep (fallback — no .gitignore awareness,
// simpler --include/--exclude globs, columns computed here with a JS
// RegExp), and a built-in JavaScript search for systems with neither
// (Windows, usually): files come from git when the folder is a repository,
// so .gitignore still applies, and matching uses the same RegExp as replace. GET /capabilities tells the client which engine is live so it
// can grey out unsupported affordances. Both engines exclude binary files
// unconditionally (rg's default detection; grep's -I) — there is no toggle
// to include them, on either engine or in replace.
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execFileP = promisify(execFile);

const SEARCH_TIMEOUT = 20000;
const MAX_LINE_LEN = 300;
const MAX_SUBMATCHES_PER_LINE = 500;
const BINARY_SNIFF_LEN = 8000;

// ---- Engine detection ----

async function commandAvailable(cmd, args) {
  try {
    await execFileP(cmd, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

let engineCache = null;
async function detectEngine() {
  if (engineCache) return engineCache;
  if (await commandAvailable("rg", ["--version"])) {
    engineCache = { engine: "ripgrep", respectsGitignore: true, globSupport: "full" };
  } else if (await commandAvailable("grep", ["--version"])) {
    engineCache = { engine: "grep", respectsGitignore: false, globSupport: "basic" };
  } else {
    engineCache = { engine: "builtin", respectsGitignore: true, globSupport: "basic" };
  }
  return engineCache;
}

// ---- Shared helpers ----

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Builds the JS RegExp used for grep's column computation and (regardless
// of engine) for replace's re-verification — one query→regex translation
// shared by both, so search-highlighting and replace-matching never drift
// apart from each other.
function buildJsRegex(query, isRegex, caseSensitive, wholeWord, global) {
  let source = isRegex ? query : escapeRegExp(query);
  if (wholeWord) source = `\\b(?:${source})\\b`;
  const flags = (global ? "g" : "") + (caseSensitive ? "" : "i");
  return new RegExp(source, flags);
}

function parseGlobs(raw) {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Long minified lines would otherwise blow up the response — truncate
// around the first match and shift submatch offsets to match the slice.
function truncateLine(lineText, submatches) {
  if (lineText.length <= MAX_LINE_LEN) return { lineText, submatches };
  const firstStart = submatches[0]?.start ?? 0;
  const half = Math.floor(MAX_LINE_LEN / 2);
  let start = Math.max(0, firstStart - half);
  let end = Math.min(lineText.length, start + MAX_LINE_LEN);
  start = Math.max(0, end - MAX_LINE_LEN);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < lineText.length ? "…" : "";
  const sliced = prefix + lineText.slice(start, end) + suffix;
  const shift = start - prefix.length;
  const newSubmatches = submatches
    .map((sm) => ({ start: sm.start - shift, end: sm.end - shift }))
    .filter((sm) => sm.start >= 0 && sm.end <= sliced.length);
  return { lineText: sliced, submatches: newSubmatches };
}

// VS Code's search view left-trims each result line so matches align
// regardless of the line's original nesting depth in the source file —
// without this, deeply-indented code reads as a ragged, indented list in
// the results panel. Submatch offsets shift left by the trimmed length.
function trimLeadingWhitespace(lineText, submatches) {
  const leading = lineText.match(/^[ \t]+/);
  if (!leading) return { lineText, submatches };
  const trimLen = leading[0].length;
  return {
    lineText: lineText.slice(trimLen),
    // A match entirely inside the trimmed whitespace (e.g. searching for a
    // literal space) has nothing left to highlight post-trim — drop it
    // rather than show a negative-offset highlight.
    submatches: submatches
      .map((sm) => ({ start: sm.start - trimLen, end: sm.end - trimLen }))
      .filter((sm) => sm.start >= 0),
  };
}

function toResultArray(byFile) {
  return [...byFile.entries()]
    .map(([file, matches]) => ({ file, matches }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

// ---- ripgrep search ----

function searchWithRg(cwd, opts) {
  const { query, isRegex, caseSensitive, wholeWord, include, exclude, maxResults, respectGitignore } = opts;
  const args = ["--json"];
  if (!respectGitignore) args.push("--no-ignore");
  args.push(caseSensitive ? "-s" : "-i");
  if (wholeWord) args.push("-w");
  if (!isRegex) args.push("-F");
  for (const g of include) args.push("-g", g);
  for (const g of exclude) args.push("-g", `!${g}`);
  args.push("--", query, ".");

  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd });
    const rl = createInterface({ input: child.stdout });
    const byFile = new Map();
    let total = 0;
    let limitHit = false;
    let timedOut = false;
    let stderr = "";
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, SEARCH_TIMEOUT);

    rl.on("line", (line) => {
      if (limitHit) return;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }
      if (evt.type !== "match") return;
      const file = evt.data.path.text.replace(/^\.\//, "");
      const rawLineText = evt.data.lines.text.replace(/\n$/, "");
      const submatchesRaw = evt.data.submatches
        .slice(0, MAX_SUBMATCHES_PER_LINE)
        .map((sm) => ({ start: sm.start, end: sm.end }));
      const trimmed = trimLeadingWhitespace(rawLineText, submatchesRaw);
      const { lineText, submatches } = truncateLine(trimmed.lineText, trimmed.submatches);
      if (submatches.length === 0) return;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push({
        line: evt.data.line_number,
        column: (submatches[0]?.start ?? 0) + 1,
        lineText,
        submatches,
      });
      total++;
      if (total >= maxResults) {
        limitHit = true;
        child.kill();
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut && !limitHit) {
        reject(new Error("Search timed out."));
        return;
      }
      if (code === 2 && !limitHit) {
        reject(new Error(stderr.trim() || "ripgrep failed"));
        return;
      }
      resolve({ results: toResultArray(byFile), limitHit });
    });
  });
}

// ---- grep fallback search ----
// --null puts a NUL after the filename (instead of ':') so a path
// containing ':' still parses correctly; the remaining "<lineno>:<text>" is
// unambiguous since line numbers are always digits.

function searchWithGrep(cwd, opts) {
  const { query, isRegex, caseSensitive, wholeWord, include, exclude, maxResults } = opts;
  const args = ["-r", "-n", "-I", "--null"];
  if (!caseSensitive) args.push("-i");
  if (wholeWord) args.push("-w");
  args.push(isRegex ? "-E" : "-F");
  for (const g of include) args.push(`--include=${g}`);
  for (const g of exclude) {
    args.push(`--exclude=${g}`);
    args.push(`--exclude-dir=${g}`);
  }
  args.push("--", query, ".");

  let jsRegex;
  try {
    jsRegex = buildJsRegex(query, isRegex, caseSensitive, wholeWord, true);
  } catch (err) {
    return Promise.reject(new Error(`Invalid pattern: ${err.message}`));
  }

  return new Promise((resolve, reject) => {
    const child = spawn("grep", args, { cwd });
    const rl = createInterface({ input: child.stdout });
    const byFile = new Map();
    let total = 0;
    let limitHit = false;
    let timedOut = false;
    let stderr = "";
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, SEARCH_TIMEOUT);

    rl.on("line", (raw) => {
      if (limitHit) return;
      const nulIdx = raw.indexOf("\0");
      if (nulIdx === -1) return;
      const file = raw.slice(0, nulIdx).replace(/^\.\//, "");
      const rest = raw.slice(nulIdx + 1);
      const m = rest.match(/^(\d+):([\s\S]*)$/);
      if (!m) return;
      const rawLineText = m[2];
      jsRegex.lastIndex = 0;
      const submatchesRaw = [];
      let match;
      while ((match = jsRegex.exec(rawLineText)) && submatchesRaw.length < MAX_SUBMATCHES_PER_LINE) {
        submatchesRaw.push({ start: match.index, end: match.index + match[0].length });
        if (match[0].length === 0) jsRegex.lastIndex++;
      }
      if (submatchesRaw.length === 0) return;
      const trimmed = trimLeadingWhitespace(rawLineText, submatchesRaw);
      const { lineText, submatches } = truncateLine(trimmed.lineText, trimmed.submatches);
      if (submatches.length === 0) return;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push({ line: Number(m[1]), column: submatches[0].start + 1, lineText, submatches });
      total++;
      if (total >= maxResults) {
        limitHit = true;
        child.kill();
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut && !limitHit) {
        reject(new Error("Search timed out."));
        return;
      }
      if (code === 2 && !limitHit) {
        reject(new Error(stderr.trim() || "grep failed"));
        return;
      }
      resolve({ results: toResultArray(byFile), limitHit });
    });
  });
}

// ---- built-in search ----

const BUILTIN_MAX_FILE_BYTES = 2 * 1024 * 1024;
const WALK_SKIP = new Set([".git", "node_modules"]);

// A simple glob ("*.ts", "src/**", "dist") as a RegExp over forward-slash
// relative paths. A pattern without "/" matches any path segment, the way
// grep's --include/--exclude-dir read a bare name.
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += escapeRegExp(ch);
  }
  return glob.includes("/") ? new RegExp(`^${out}(?:/.*)?$`) : new RegExp(`(?:^|/)${out}(?:/.*)?$`);
}

async function builtinFileList(cwd, respectGitignore) {
  if (respectGitignore) {
    try {
      const { stdout } = await execFileP("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 10000,
      });
      return stdout.split("\0").filter(Boolean);
    } catch {
      // Not a repository, or no git: walk instead.
    }
  }
  const files = [];
  const walk = async (rel) => {
    let entries;
    try {
      entries = await fs.readdir(path.join(cwd, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) await walk(childRel);
      } else if (entry.isFile()) {
        files.push(childRel);
      }
    }
  };
  await walk("");
  return files;
}

export async function searchWithBuiltin(cwd, opts) {
  const { query, isRegex, caseSensitive, wholeWord, include, exclude, maxResults, respectGitignore } = opts;
  let jsRegex;
  try {
    jsRegex = buildJsRegex(query, isRegex, caseSensitive, wholeWord, true);
  } catch (err) {
    throw new Error(`Invalid pattern: ${err.message}`);
  }
  const includes = include.map(globToRegExp);
  const excludes = exclude.map(globToRegExp);
  const deadline = Date.now() + SEARCH_TIMEOUT;
  const byFile = new Map();
  let total = 0;

  const files = (await builtinFileList(cwd, respectGitignore)).map((f) => f.replace(/\\/g, "/")).sort();
  for (const file of files) {
    if (includes.length > 0 && !includes.some((re) => re.test(file))) continue;
    if (excludes.some((re) => re.test(file))) continue;
    if (Date.now() > deadline) throw new Error("Search timed out.");
    let buf;
    try {
      const info = await fs.stat(path.join(cwd, file));
      if (!info.isFile() || info.size > BUILTIN_MAX_FILE_BYTES) continue;
      buf = await fs.readFile(path.join(cwd, file));
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const rawLineText = lines[i].replace(/\r$/, "");
      jsRegex.lastIndex = 0;
      const submatchesRaw = [];
      let match;
      while ((match = jsRegex.exec(rawLineText)) && submatchesRaw.length < MAX_SUBMATCHES_PER_LINE) {
        submatchesRaw.push({ start: match.index, end: match.index + match[0].length });
        if (match[0].length === 0) jsRegex.lastIndex++;
      }
      if (submatchesRaw.length === 0) continue;
      const trimmed = trimLeadingWhitespace(rawLineText, submatchesRaw);
      const { lineText, submatches } = truncateLine(trimmed.lineText, trimmed.submatches);
      if (submatches.length === 0) continue;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push({ line: i + 1, column: submatches[0].start + 1, lineText, submatches });
      total++;
      if (total >= maxResults) return { results: toResultArray(byFile), limitHit: true };
    }
  }
  return { results: toResultArray(byFile), limitHit: false };
}

// ---- Replace ----

// Rejects absolute paths and any ".." segment so a target can't escape cwd.
function safeRelPath(file) {
  if (typeof file !== "string" || !file) return null;
  const normalized = path.normalize(file);
  if (path.isAbsolute(normalized) || normalized.split(path.sep).includes("..")) return null;
  return normalized;
}

function looksBinary(buf) {
  const len = Math.min(buf.length, BINARY_SNIFF_LEN);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

async function replaceInFile(cwd, target, matchRegexGlobal, matchRegexSingle, isRegex, replacement) {
  const relPath = safeRelPath(target?.file);
  if (!relPath) return { file: String(target?.file ?? "?"), replaced: 0, skipped: 0, error: "invalid path" };

  const absPath = path.join(cwd, relPath);
  let buf;
  try {
    buf = await fs.readFile(absPath);
  } catch (err) {
    return { file: relPath, replaced: 0, skipped: 0, error: err.message };
  }
  if (looksBinary(buf)) return { file: relPath, replaced: 0, skipped: 0, error: "binary file" };

  const lines = buf.toString("utf8").split("\n");
  const wantedLines = Array.isArray(target.lines) ? new Set(target.lines) : null;
  // Precise per-occurrence targeting (used by "replace this match" /
  // "replace this file"'s remaining matches) — keyed by "line:startOffset"
  // against the CURRENT file content, so a stale offset simply won't be
  // found and is counted as skipped rather than corrupting the file.
  const wantedStarts = Array.isArray(target.matches)
    ? new Set(target.matches.map((m) => `${m.line}:${m.start}`))
    : null;

  let replaced = 0;
  let skipped = 0;
  let dirty = false;

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    if (wantedLines && !wantedLines.has(lineNumber)) continue;
    if (wantedStarts && ![...wantedStarts].some((k) => k.startsWith(`${lineNumber}:`))) continue;

    const line = lines[i];
    matchRegexGlobal.lastIndex = 0;
    const submatches = [];
    let m;
    while ((m = matchRegexGlobal.exec(line))) {
      submatches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
      if (m[0].length === 0) matchRegexGlobal.lastIndex++;
    }
    if (submatches.length === 0) continue;

    let toApply = submatches;
    if (wantedStarts) {
      const wantedForLine = [...wantedStarts].filter((k) => k.startsWith(`${lineNumber}:`)).length;
      toApply = submatches.filter((sm) => wantedStarts.has(`${lineNumber}:${sm.start}`));
      skipped += wantedForLine - toApply.length;
    }
    if (toApply.length === 0) continue;

    // Rightmost-first so earlier offsets in the same line stay valid even
    // when the replacement text is a different length than the match.
    let newLine = line;
    for (let j = toApply.length - 1; j >= 0; j--) {
      const sm = toApply[j];
      let replText = replacement;
      if (isRegex) {
        try {
          replText = sm.text.replace(matchRegexSingle, replacement);
        } catch {
          skipped++;
          continue;
        }
      }
      newLine = newLine.slice(0, sm.start) + replText + newLine.slice(sm.end);
      replaced++;
    }
    if (newLine !== line) {
      lines[i] = newLine;
      dirty = true;
    }
  }

  if (dirty) {
    try {
      await fs.writeFile(absPath, lines.join("\n"));
    } catch (err) {
      return { file: relPath, replaced: 0, skipped: replaced + skipped, error: err.message };
    }
  }
  return { file: relPath, replaced, skipped };
}

export function activate({ router, log, getSettings }) {
  router.get("/capabilities", async (_req, res) => {
    res.json(await detectEngine());
  });

  router.post("/search", async (req, res) => {
    const cwd = typeof req.body?.cwd === "string" ? req.body.cwd : "";
    if (!cwd) {
      res.status(400).json({ error: "cwd is required" });
      return;
    }
    const caps = await detectEngine();
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (!query) {
      res.json({ results: [], limitHit: false, engine: caps.engine });
      return;
    }
    if (caps.engine === "none") {
      res.status(500).json({ error: "Neither ripgrep (rg) nor grep is available on this system." });
      return;
    }

    const isRegex = !!req.body?.isRegex;
    const caseSensitive = !!req.body?.caseSensitive;
    const wholeWord = !!req.body?.wholeWord;
    const include = parseGlobs(req.body?.include);
    // "Use Exclude Settings and Ignore Files" (VS Code's term) — on by
    // default, independent of whether the client's glob panel is open, so
    // toggling it off requires an explicit action rather than opting in by
    // just opening the panel. Off means: skip the configured default
    // excludes AND (ripgrep only — grep never respects gitignore) search
    // files a .gitignore/.ignore would normally hide.
    const useExcludeSettings = req.body?.useExcludeSettings !== false;
    const settings = await getSettings();
    const defaultExcludes = useExcludeSettings ? parseGlobs(settings["search.excludeGlobs"]) : [];
    const exclude = [...new Set([...defaultExcludes, ...parseGlobs(req.body?.exclude)])];
    const maxResults = Math.min(Math.max(Number(settings["search.maxResults"]) || 2000, 1), 20000);

    try {
      const searchFn = caps.engine === "ripgrep" ? searchWithRg : caps.engine === "grep" ? searchWithGrep : searchWithBuiltin;
      const { results, limitHit } = await searchFn(cwd, {
        query,
        isRegex,
        caseSensitive,
        respectGitignore: useExcludeSettings,
        wholeWord,
        include,
        exclude,
        maxResults,
      });
      res.json({ results, limitHit, engine: caps.engine });
    } catch (err) {
      res.status(400).json({ error: err.message, engine: caps.engine });
    }
  });

  router.post("/replace", async (req, res) => {
    const cwd = typeof req.body?.cwd === "string" ? req.body.cwd : "";
    if (!cwd) {
      res.status(400).json({ error: "cwd is required" });
      return;
    }
    const query = typeof req.body?.query === "string" ? req.body.query : "";
    if (!query) {
      res.status(400).json({ error: "query is required" });
      return;
    }
    const targets = Array.isArray(req.body?.targets) ? req.body.targets : null;
    if (!targets || targets.length === 0) {
      res.status(400).json({ error: "targets must be a non-empty array" });
      return;
    }
    const isRegex = !!req.body?.isRegex;
    const caseSensitive = !!req.body?.caseSensitive;
    const wholeWord = !!req.body?.wholeWord;
    const replacement = typeof req.body?.replacement === "string" ? req.body.replacement : "";

    let matchRegexGlobal;
    let matchRegexSingle;
    try {
      matchRegexGlobal = buildJsRegex(query, isRegex, caseSensitive, wholeWord, true);
      matchRegexSingle = buildJsRegex(query, isRegex, caseSensitive, wholeWord, false);
    } catch (err) {
      res.status(400).json({ error: `Invalid pattern: ${err.message}` });
      return;
    }

    const results = [];
    for (const target of targets) {
      results.push(await replaceInFile(cwd, target, matchRegexGlobal, matchRegexSingle, isRegex, replacement));
    }

    res.json({
      results,
      totalReplaced: results.reduce((s, f) => s + f.replaced, 0),
      totalSkipped: results.reduce((s, f) => s + f.skipped, 0),
    });
  });

  log("search server hook active");
}

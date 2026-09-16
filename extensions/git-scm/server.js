// Server hook for the git-scm extension — a VS Code-style SOURCE CONTROL
// panel. Plain ESM (no build step), like live-preview's server hook: the
// server runs under tsx in both dev and prod, so this loads as-is.
//
// cwd trusted the same way /api/fs is: this is a single-user local dev
// tool gated on Host/Origin (see server/src/security.ts), and the client
// always supplies cwd from its own already-trusted active context — no
// extra path allowlisting is layered on top here.
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { buildDirStatuses, classify } from "./statusModel.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASKPASS_PATH = path.join(__dirname, "askpass.cjs");

const DEFAULT_TIMEOUT = 15000;

// ---- AI commit messages ----
// The provider, binary, model and any API key all live in core (Settings →
// AI, see server/src/ai.ts) — this extension only writes the prompt and hands
// it to ctx.ai. Nothing here executes any part of the reply; it comes back as
// plain text that lands in the commit box for the user to read and edit.
//
// The patch is what costs tokens and wall-clock, so it is truncated, while
// --stat always goes along in full: a change too large to send verbatim still
// gets an accurate file list instead of a message written from a truncated
// first half.
const MAX_DIFF_CHARS = 60_000;
const RECENT_SUBJECTS = 10;

const DEFAULT_COMMIT_INSTRUCTION =
  "Write a git commit message for the staged changes below. " +
  "Reply with ONLY the commit message - no preamble, no commentary, no code fences. " +
  "First line: an imperative subject under 72 characters, capitalized, with no trailing period. " +
  "If the change needs explaining, add a blank line and then a body of prose paragraphs wrapped at 76 " +
  "characters that says what changed and why, not how. Describe only what the diff actually shows.";


// opts.allowNonZeroExit: `git diff --no-index` exits 1 (not 0) when it
// finds differences — the expected case, not a failure — so the diff
// endpoint opts out of the reject-on-nonzero-exit default. Network ops
// (push/pull/sync) don't come through here — see gitNetwork in activate,
// which wires up the interactive askpass relay instead of a fixed timeout.
function git(args, cwd, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        timeout: opts.timeout ?? DEFAULT_TIMEOUT,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        if (err && !(opts.allowNonZeroExit && err.code === 1)) {
          const wrapped = new Error(stderr.trim() || err.message);
          wrapped.stderr = stderr;
          reject(wrapped);
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

// How long a network op may run with nothing interactive going on before
// its git child is killed; while a prompt is open the watchdog is paused
// and the prompt's own expiry takes over.
const IDLE_TIMEOUT = 30000;
const PROMPT_TIMEOUT = 120000;

// Prompt-kind classification, ordered so "Enter passphrase for key ..."
// (which never says "password") wins over the username/password pair and
// ssh's host-key confirmation is recognized by either of its stable
// clauses. Anything unmatched degrades to a "generic" free-text ask (and
// is logged verbatim so future versions can tighten these from real data).
function classifyPrompt(prompt) {
  if (/passphrase/i.test(prompt)) return "passphrase";
  if (/username/i.test(prompt)) return "username";
  if (/password/i.test(prompt)) return "password";
  if (/continue connecting|authenticity of host/i.test(prompt)) return "hostkey";
  return "generic";
}

// Pulls protocol/host (and an embedded username, if the remote URL carries
// one) out of git's own prompt text — "Password for 'https://me@host':" —
// which is the exact origin git is authenticating against, more reliable
// than re-deriving it from remote config.
function parsePromptOrigin(prompt) {
  const m = prompt.match(/'([a-z][a-z0-9+.-]*):\/\/(?:([^@']*)@)?([^/']+)/i);
  if (!m) return null;
  let username = null;
  if (m[2]) {
    try {
      username = decodeURIComponent(m[2]);
    } catch {
      username = m[2];
    }
  }
  return { protocol: m[1].toLowerCase(), username, host: m[3] };
}

// Git's exact wording varies by version/host; matching the common cases and
// degrading to a plain error display otherwise (see the plan's confirmed
// trade-off) rather than trying to enumerate every phrasing.
function isAuthFailure(message) {
  return /could not read (username|password)|authentication failed|terminal prompts disabled|invalid username or password|permission denied \(publickey|host key verification failed/i.test(
    message,
  );
}

// Answers travel back to git/ssh as a single stdout line and remembered
// credentials go through `git credential approve`'s line-oriented protocol
// — an embedded newline/CR/NUL would break both, and no legitimate value
// contains one.
function isCleanValue(value) {
  return typeof value === "string" && !/[\r\n\0]/.test(value);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const STATUS_LETTERS = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "added", T: "modified" };

function classifyChar(ch) {
  return STATUS_LETTERS[ch] || "modified";
}

// Consumes exactly `count` space-separated fields from the front of a
// porcelain-v2 -z record, returning [fields, remainder] — the remainder is
// the path, which is itself never split further since it may legitimately
// contain spaces (porcelain -z never quotes paths).
function takeFields(token, count) {
  const fields = [];
  let rest = token;
  for (let i = 0; i < count; i++) {
    const sp = rest.indexOf(" ");
    if (sp === -1) {
      fields.push(rest);
      rest = "";
    } else {
      fields.push(rest.slice(0, sp));
      rest = rest.slice(sp + 1);
    }
  }
  return [fields, rest];
}

// Parses `git status --porcelain=v2 --branch -z` output. Record shapes
// (verified empirically against git 2.47, including a real merge conflict
// and a real ahead/behind upstream — porcelain v2's docs are terse enough
// that field counts are worth confirming rather than assuming):
//   "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"                (ordinary)
//   "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <score> <path>" + NUL + origPath
//   "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"      (conflict)
//   "? <path>"                                                     (untracked)
// A file can appear in both staged and unstaged (e.g. "MM": staged
// modification with further unstaged edits on top) — X and Y are recorded
// independently rather than picking one "winning" status.
function parseStatus(raw) {
  const tokens = raw.split("\0").filter((t) => t.length > 0);
  let branch = null;
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  const staged = [];
  const unstaged = [];
  const conflicted = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("# branch.head ")) {
      const name = token.slice("# branch.head ".length);
      branch = name === "(detached)" ? null : name;
    } else if (token.startsWith("# branch.upstream ")) {
      upstream = token.slice("# branch.upstream ".length);
    } else if (token.startsWith("# branch.ab ")) {
      const m = token.match(/\+(\d+) -(\d+)/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (token.startsWith("#")) {
      // branch.oid or an unrecognized header — nothing this panel needs.
    } else if (token[0] === "1") {
      const [fields, filePath] = takeFields(token.slice(2), 7);
      const [x, y] = fields[0];
      if (x !== ".") staged.push({ path: filePath, status: classifyChar(x) });
      if (y !== ".") unstaged.push({ path: filePath, status: classifyChar(y) });
    } else if (token[0] === "2") {
      const [fields, filePath] = takeFields(token.slice(2), 8);
      const [x, y] = fields[0];
      // The orig path is a separate NUL-terminated token immediately
      // following this one, not embedded in it — confirmed empirically.
      const origPath = tokens[++i];
      if (x !== ".") {
        staged.push({
          path: filePath,
          origPath: x === "R" || x === "C" ? origPath : undefined,
          status: classifyChar(x),
        });
      }
      if (y !== ".") unstaged.push({ path: filePath, status: classifyChar(y) });
    } else if (token[0] === "u") {
      const [, filePath] = takeFields(token.slice(2), 9);
      conflicted.push({ path: filePath, status: "conflicted" });
    } else if (token[0] === "?") {
      unstaged.push({ path: token.slice(2), status: "untracked" });
    }
    // "!" (ignored) never appears — --ignored is never passed.
  }

  const byPath = (a, b) => a.path.localeCompare(b.path);
  return {
    branch,
    upstream,
    ahead,
    behind,
    staged: staged.sort(byPath),
    unstaged: unstaged.sort(byPath),
    conflicted: conflicted.sort(byPath),
  };
}

function requireCwd(req, res) {
  const cwd = typeof req.query.cwd === "string" ? req.query.cwd : req.body?.cwd;
  if (!cwd || typeof cwd !== "string") {
    res.status(400).json({ error: "cwd is required" });
    return null;
  }
  return cwd;
}

function requirePaths(req, res) {
  const paths = req.body?.paths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string")) {
    res.status(400).json({ error: "paths must be a non-empty array of strings" });
    return null;
  }
  return paths;
}

// Resolves a repo-relative path against root, rejecting anything that
// escapes it (a leading "..", a symlink hop, etc.) — the client only ever
// supplies paths it read back from /status, but /conflict and /resolve
// write/read raw file bytes, so this boundary is enforced server-side too.
function resolveSafePath(root, relPath) {
  const resolved = path.resolve(root, relPath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

// Detects an in-progress merge/rebase/cherry-pick/revert by checking the
// well-known marker files/dirs under .git (or the submodule/worktree
// equivalent via --git-dir, which may be relative to root or absolute).
// Mirrors what `git status` itself reports in its "You have unmerged
// paths"/"interrupted" banners, but as a stable machine-readable value.
async function detectOperation(root) {
  let gitDir;
  try {
    gitDir = (await git(["rev-parse", "--git-dir"], root)).trim();
  } catch {
    return { operation: null, mergeMsg: null };
  }
  const gd = path.isAbsolute(gitDir) ? gitDir : path.join(root, gitDir);
  const exists = (p) => fs.existsSync(path.join(gd, p));
  let operation = null;
  if (exists("MERGE_HEAD")) operation = "merge";
  else if (exists("CHERRY_PICK_HEAD")) operation = "cherry-pick";
  else if (exists("REVERT_HEAD")) operation = "revert";
  else if (exists("rebase-merge") || exists("rebase-apply")) operation = "rebase";

  let mergeMsg = null;
  if (operation) {
    try {
      mergeMsg = fs.readFileSync(path.join(gd, "MERGE_MSG"), "utf8");
    } catch {
      mergeMsg = null;
    }
  }
  return { operation, mergeMsg };
}

const ABORT_COMMAND = {
  merge: ["merge", "--abort"],
  rebase: ["rebase", "--abort"],
  "cherry-pick": ["cherry-pick", "--abort"],
  revert: ["revert", "--abort"],
};

// 5MB is comfortably above any real conflicted source file while still
// ruling out accidentally opening a huge generated/binary blob in the
// conflict-block parser, which builds the whole file into a JS string.
const MAX_CONFLICT_FILE_SIZE = 5 * 1024 * 1024;

function looksBinary(buf) {
  // A NUL byte anywhere in the first chunk is git's own heuristic for
  // "binary" (core.bigFileThreshold aside) — cheap and matches what
  // `git diff` would otherwise report as "Binary files differ".
  const scanLen = Math.min(buf.length, 8000);
  for (let i = 0; i < scanLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ---- File-tree decorations (ported from core server/src/git.ts) ----
//
// A repo scan is whole-repo work keyed by the repo ROOT, so every directory
// in the same repo produces the identical answer — the FILES tree polls its
// root plus every expanded folder every 3s, in every open tab, so the scan
// is cached per root, briefly, with one in-flight scan shared among every
// caller that asks while it runs. Any mutation the core server performs
// drops the cache outright (host.events.onApiMutation, the extension-facing
// successor of core invalidateGitCache), so an edit made through the UI
// shows up immediately rather than waiting out the TTL.
const STATUS_TTL_MS = 1000;
// dir -> repo root. Effectively immutable for a given directory, so this is
// cached far longer; it exists to kill the `git rev-parse` fork per call.
const ROOT_TTL_MS = 30_000;
// getTrackedDirs' answer (a full `git ls-files` walk) only affects the
// "fully ignored vs. mixed" dimming distinction, and only changes when the
// index changes — a much longer TTL than STATUS_TTL_MS is safe here.
const TRACKED_DIRS_TTL_MS = 30_000;

const rootCache = new Map();
const statusScanCache = new Map();
const statusScanInFlight = new Map();
const trackedDirsCache = new Map();

function invalidateDecorationCaches() {
  statusScanCache.clear();
  trackedDirsCache.clear();
}

async function repoRootOf(anyDirInRepo) {
  const cached = rootCache.get(anyDirInRepo);
  if (cached && Date.now() - cached.at < ROOT_TTL_MS) return cached.root;
  let root;
  try {
    root = (await git(["rev-parse", "--show-toplevel"], anyDirInRepo)).trim() || null;
  } catch {
    root = null;
  }
  rootCache.set(anyDirInRepo, { at: Date.now(), root });
  return root;
}

// "branch --show-current" prints nothing (without erroring) for a detached
// HEAD, so fall back to a short commit hash in that case.
async function branchOf(root) {
  let branch;
  try {
    branch = (await git(["branch", "--show-current"], root)).trim();
  } catch {
    return null;
  }
  if (branch) return branch;
  try {
    return (await git(["rev-parse", "--short", "HEAD"], root)).trim();
  } catch {
    return null;
  }
}

// Every ancestor directory (relative to root, no trailing slash) that
// contains at least one tracked file — tells a genuinely fully-ignored
// directory apart from one with ignored content mixed into tracked files.
async function getTrackedDirs(root) {
  const cached = trackedDirsCache.get(root);
  if (cached && Date.now() - cached.at < TRACKED_DIRS_TTL_MS) return cached.dirs;
  const dirs = new Set();
  try {
    const out = await git(["ls-files", "-z"], root);
    for (const token of out.split("\0")) {
      if (!token) continue;
      let idx = token.lastIndexOf("/");
      while (idx !== -1) {
        const dir = token.slice(0, idx);
        if (dirs.has(dir)) break;
        dirs.add(dir);
        idx = dir.lastIndexOf("/");
      }
    }
  } catch {
    // Not a repo / git failed — empty set degrades to "no dimming nuance".
  }
  trackedDirsCache.set(root, { at: Date.now(), dirs });
  return dirs;
}

// Two separate git calls instead of one to avoid blowing past execFile's
// maxBuffer: `status --porcelain=v1 -z -uall` (changes; -uall recurses into
// untracked dirs but NOT ignored ones, so output stays tiny) plus
// `ls-files -i --others --directory` (ignored directories only, collapsed
// to one entry each). A single `status -uall --ignored` would expand every
// file inside node_modules/dist into "!! …" lines — 1 MB+ of output.
async function scanRepoStatuses(root) {
  let statusOut;
  try {
    statusOut = await git(["status", "--porcelain=v1", "-z", "-uall"], root);
  } catch {
    return null;
  }

  const statuses = new Map();
  const tokens = statusOut.split("\0").filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const code = token.slice(0, 2);
    const filePath = token.slice(3).replace(/\/$/, "");
    statuses.set(filePath, classify(code));
    // Renames/copies emit the original path as a separate NUL-terminated
    // token right after; skip it so it isn't misread as its own entry.
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") {
      i++;
    }
  }

  try {
    const ignoredOut = await git(
      ["ls-files", "-i", "--others", "--directory", "--exclude-standard", "-z"],
      root,
    );
    for (const token of ignoredOut.split("\0")) {
      if (!token) continue;
      // Strip trailing slash so directory keys match the rest of the map.
      statuses.set(token.replace(/\/$/, ""), "ignored");
    }
  } catch {
    // Ignored-dir detection is best-effort; a failure here doesn't break
    // the main status display.
  }

  const [branch, trackedDirs] = await Promise.all([branchOf(root), getTrackedDirs(root)]);
  return { branch, statuses, dirStatuses: buildDirStatuses(statuses), trackedDirs };
}

async function getRepoDecorations(anyDirInRepo) {
  const root = await repoRootOf(anyDirInRepo);
  if (!root) return null;
  const cached = statusScanCache.get(root);
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
  const pending = statusScanInFlight.get(root);
  if (pending) return pending;
  const scan = scanRepoStatuses(root)
    .then((value) => {
      const result = value ? { root, ...value } : null;
      statusScanCache.set(root, { at: Date.now(), value: result });
      return result;
    })
    .finally(() => {
      statusScanInFlight.delete(root);
    });
  statusScanInFlight.set(root, scan);
  return scan;
}

export function activate({ router, log, host, getSettings, ai }) {
  // Core file mutations (write/rename/delete/paste/upload) must show up in
  // tree badges immediately, same as when the scan lived in core.
  host?.events?.onApiMutation?.(invalidateDecorationCaches);

  // File-tree decoration data for the FILES tree's root directory: the repo
  // branch plus the per-path status maps, serialized flat — the client
  // resolves each visible entry against them with statusModel.mjs's
  // statusForEntry (same code the scan's own rollup uses).
  router.get("/decorations", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    try {
      const repo = await getRepoDecorations(cwd);
      if (!repo) {
        res.json({ root: null });
        return;
      }
      res.json({
        root: repo.root,
        branch: repo.branch,
        statuses: Object.fromEntries(repo.statuses),
        dirStatuses: Object.fromEntries(repo.dirStatuses),
        trackedDirs: [...repo.trackedDirs],
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Interactive auth-prompt relay ----
  // git/ssh children get GIT_ASKPASS/SSH_ASKPASS pointed at askpass.cjs,
  // which forwards every prompt here over a token-guarded unix socket. The
  // prompt is parked per-op until the panel (polling GET /prompt while its
  // network request is in flight) answers via POST /prompt-reply. All
  // credential policy lives here: askpass.cjs is a dumb pipe, and a fresh
  // process per question can't track retries anyway — the relay can (a
  // second ask of the same kind for the same host within one op means git
  // rejected the previous pair).
  const relayDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-scm-"));
  // Windows has no unix sockets: a named pipe, which Node's HTTP server and
  // client accept in the same place.
  const relaySocket = process.platform === "win32"
    ? `\\\\.\\pipe\\git-scm-${randomBytes(8).toString("hex")}`
    : path.join(relayDir, "askpass.sock");
  // git and ssh exec the askpass program directly. askpass.cjs runs by its
  // #! line elsewhere; Windows needs a .cmd that starts it with node.
  const askpassProgram = process.platform === "win32" ? path.join(relayDir, "askpass.cmd") : ASKPASS_PATH;
  if (process.platform === "win32") {
    fs.writeFileSync(askpassProgram, `@echo off\r\n"${process.execPath}" "${ASKPASS_PATH}" %*\r\n`);
  }
  const relayToken = randomBytes(32).toString("hex");
  const ops = new Map();
  // In-memory per-origin credentials, populated on every interactive
  // username/password answer and kept for the server's lifetime — never
  // written to disk by this extension. Opt-in persistence goes through
  // `git credential approve` into the user's own helper instead.
  const credCache = new Map(); // "protocol//host" -> { username, password }

  function relayEnv(opId) {
    return {
      GIT_ASKPASS: askpassProgram,
      SSH_ASKPASS: askpassProgram,
      // OpenSSH ≥ 8.4 routes passphrase AND host-key confirmation through
      // SSH_ASKPASS when forced; DISPLAY is the pre-8.4 precondition, set
      // to a dummy only when the server itself has none.
      SSH_ASKPASS_REQUIRE: "force",
      ...(process.env.DISPLAY ? {} : { DISPLAY: ":0" }),
      GIT_SCM_RELAY_SOCKET: relaySocket,
      GIT_SCM_RELAY_TOKEN: relayToken,
      GIT_SCM_OP_ID: opId,
    };
  }

  function createOp(id) {
    const op = {
      id,
      child: null,
      abort: null, // set by gitNetwork; rejects the in-flight promise on watchdog timeout
      watchdog: null,
      expiry: null,
      pending: null, // { id, kind, prompt, origin, res } — one at a time; git asks serially
      heldPassword: null, // second half of a combined username+password answer
      authAsks: new Map(), // "protocol//host" -> { username: n, password: n }
      authTouched: new Set(), // origins to invalidate if the op ends in auth failure
      remember: null, // { protocol, host, username, password } pending `credential approve`
      cancelled: false,
      timedOut: false,
    };
    ops.set(id, op);
    return op;
  }

  function armWatchdog(op) {
    clearTimeout(op.watchdog);
    op.watchdog = setTimeout(() => {
      op.timedOut = true;
      // Kill the whole process group (gitNetwork spawns detached): a plain
      // child.kill only reaches `git` itself, whose transport helper
      // (git-remote-https, ssh) survives holding the stdio pipes open until
      // its own network timeout — observed adding ~100s to a blackholed
      // remote. op.abort rejects the pending gitNetwork promise right away
      // so the panel hears about the timeout at 30s, not at pipe close.
      const child = op.child;
      if (child) {
        if (process.platform === "win32") {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } else {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        }
      }
      op.abort?.();
    }, IDLE_TIMEOUT);
  }

  // Resolves the parked askpass HTTP request: 200 + body = the answer git
  // reads from askpass stdout; anything else makes askpass exit 1, which
  // aborts the git/ssh operation.
  function settlePending(op, { answer = null, cancelled = false } = {}) {
    const p = op.pending;
    if (!p) return;
    op.pending = null;
    clearTimeout(op.expiry);
    if (cancelled) op.cancelled = true;
    try {
      if (answer !== null) {
        p.res.statusCode = 200;
        p.res.end(answer);
      } else {
        p.res.statusCode = 410;
        p.res.end();
      }
    } catch {
      // The askpass process may already be gone (its git parent was killed).
    }
    armWatchdog(op);
  }

  function destroyOp(op) {
    settlePending(op);
    clearTimeout(op.watchdog);
    clearTimeout(op.expiry);
    ops.delete(op.id);
  }

  const relay = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/ask") {
      res.statusCode = 404;
      res.end();
      return;
    }
    let payload;
    try {
      payload = JSON.parse(await readRawBody(req));
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (payload?.token !== relayToken) {
      res.statusCode = 403;
      res.end();
      return;
    }
    const op = ops.get(payload.op);
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    if (!op) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const kind = classifyPrompt(prompt);
    if (kind === "generic") log(`unrecognized auth prompt: ${JSON.stringify(prompt)}`);

    // The combined username+password form answered both halves at once;
    // git asks for them as two separate prompts, so the password half was
    // held back for this follow-up ask.
    if (kind === "password" && op.heldPassword !== null) {
      const pw = op.heldPassword;
      op.heldPassword = null;
      armWatchdog(op);
      res.statusCode = 200;
      res.end(pw);
      return;
    }

    const origin = kind === "username" || kind === "password" ? parsePromptOrigin(prompt) : null;
    if (origin) {
      const key = `${origin.protocol}//${origin.host}`;
      op.authTouched.add(key);
      const asks = op.authAsks.get(key) ?? { username: 0, password: 0 };
      asks[kind] += 1;
      op.authAsks.set(key, asks);
      if (asks[kind] > 1) {
        // git asking the same question again within one op = the previous
        // pair was rejected — drop it and go interactive.
        credCache.delete(key);
      } else {
        const cached = credCache.get(key);
        if (cached) {
          armWatchdog(op);
          res.statusCode = 200;
          res.end(kind === "username" ? cached.username : cached.password);
          return;
        }
      }
    }

    if (op.pending) {
      // One prompt per op — git asks serially, so a second concurrent ask
      // is a relay bug or a killed-and-retried child; refuse it.
      res.statusCode = 409;
      res.end();
      return;
    }
    op.pending = { id: randomUUID(), kind, prompt, origin, res };
    clearTimeout(op.watchdog);
    op.expiry = setTimeout(() => settlePending(op, { cancelled: true }), PROMPT_TIMEOUT);
  });
  relay.listen(relaySocket);

  router.get("/prompt", (req, res) => {
    const op = typeof req.query.op === "string" ? ops.get(req.query.op) : null;
    const p = op?.pending;
    res.json({ prompt: p ? { id: p.id, kind: p.kind, prompt: p.prompt } : null });
  });

  router.post("/prompt-reply", (req, res) => {
    const { op: opId, id, cancel, username, password, answer, remember } = req.body ?? {};
    const op = typeof opId === "string" ? ops.get(opId) : null;
    const p = op?.pending;
    if (!op || !p || p.id !== id) {
      res.status(410).json({ error: "That prompt is no longer pending." });
      return;
    }
    if (cancel === true) {
      settlePending(op, { cancelled: true });
      res.json({ ok: true });
      return;
    }
    let text;
    if (p.kind === "username") {
      if (!isCleanValue(username) || !isCleanValue(password)) {
        res.status(400).json({ error: "username and password are required" });
        return;
      }
      text = username;
      op.heldPassword = password;
      if (p.origin) {
        const key = `${p.origin.protocol}//${p.origin.host}`;
        credCache.set(key, { username, password });
        if (remember === true) {
          op.remember = { protocol: p.origin.protocol, host: p.origin.host, username, password };
        }
      }
    } else {
      if (!isCleanValue(answer)) {
        res.status(400).json({ error: "answer is required" });
        return;
      }
      text = answer;
      if (p.kind === "password" && p.origin?.username) {
        credCache.set(`${p.origin.protocol}//${p.origin.host}`, {
          username: p.origin.username,
          password: answer,
        });
      }
    }
    settlePending(op, { answer: text });
    res.json({ ok: true });
  });

  router.get("/status", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    try {
      const root = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
      // -uall recurses into untracked directories so each file inside gets
      // its own row — default (--untracked-files=normal) collapses a whole
      // new directory into one "? dir/" entry instead, same trap the core
      // FILES tree's status call (server/src/git.ts) already works around.
      const raw = await git(["status", "--porcelain=v2", "--branch", "-uall", "-z"], root);
      const { operation, mergeMsg } = await detectOperation(root);
      // %B is the raw, unwrapped subject+body — what Amend's prefill should
      // show back verbatim. Absent (rather than erroring) on an unborn
      // branch, where there's no commit yet to amend.
      let lastCommitMessage = null;
      try {
        lastCommitMessage = (await git(["log", "-1", "--format=%B"], root)).replace(/\n+$/, "");
      } catch {
        // No commits yet.
      }
      // Drives the More Actions menu's "Pop Latest Stash" enabled state.
      // refs/stash doesn't exist until the first stash, which makes
      // rev-list fail (not return 0) — caught and treated as "no stashes".
      let stashCount = 0;
      try {
        stashCount = Number((await git(["rev-list", "--walk-reflogs", "--count", "refs/stash"], root)).trim());
      } catch {
        // No stashes yet.
      }
      res.json({ root, operation, mergeMsg, lastCommitMessage, stashCount, ...parseStatus(raw) });
    } catch {
      // Not a git repository — a plain empty-state response, not an error
      // (confirmed: no "Initialize Repository" affordance for v1).
      res.json({ root: null });
    }
  });

  // Resolves cwd (which may be any directory inside the repo, e.g. the
  // active pane's subdirectory) to the repo root so root-relative paths
  // (as returned by /status and echoed back by the client) always match
  // what git sees — a bare pathspec resolved against a subdirectory cwd
  // either 404s ("did not match any files") or silently matches nothing.
  async function requireRoot(cwd, res) {
    const root = await repoRootOf(cwd);
    if (!root) {
      res.status(400).json({ error: "Not a git repository." });
      return null;
    }
    return root;
  }

  router.post("/stage", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const paths = requirePaths(req, res);
    if (!paths) return;
    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;
      await git(["add", "-A", "--", ...paths], root);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/unstage", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const paths = requirePaths(req, res);
    if (!paths) return;
    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;
      try {
        await git(["reset", "-q", "HEAD", "--", ...paths], root);
      } catch {
        // Defensive fallback for git versions where HEAD doesn't resolve on
        // an unborn branch — the repo-with-no-commits-yet case.
        await git(["rm", "--cached", "-r", "--", ...paths], root);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Scoped to unstaged (working-tree + untracked) changes only, matching
  // VS Code: a Staged Changes row offers Unstage, not Discard.
  router.post("/discard", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const paths = requirePaths(req, res);
    if (!paths) return;
    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;
      // Untracked paths can't be `restore`d (they're not in the index or
      // HEAD); the client tells us which of the requested paths are
      // untracked so each gets the right command.
      const untracked = Array.isArray(req.body?.untracked)
        ? req.body.untracked.filter((p) => typeof p === "string")
        : [];
      const tracked = paths.filter((p) => !untracked.includes(p));
      if (tracked.length > 0) await git(["restore", "--worktree", "--", ...tracked], root);
      if (untracked.length > 0) await git(["clean", "-f", "--", ...untracked], root);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Returns the working-tree file's raw content (plus a hash for /resolve's
  // optimistic-concurrency check) so ConflictView can parse conflict markers
  // client-side. Not a diff — there's no meaningful "before" side to diff
  // against for a path with live conflict markers in it.
  router.get("/conflict", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const relPath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    try {
      const root = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
      const abs = resolveSafePath(root, relPath);
      if (!abs) {
        res.status(400).json({ error: "path escapes the repository root" });
        return;
      }
      const stat = fs.statSync(abs);
      if (stat.size > MAX_CONFLICT_FILE_SIZE) {
        res.json({ content: null, binary: false, tooLarge: true, hash: null });
        return;
      }
      const buf = fs.readFileSync(abs);
      if (looksBinary(buf)) {
        res.json({ content: null, binary: true, tooLarge: false, hash: null });
        return;
      }
      const content = buf.toString("utf8");
      const hash = createHash("sha256").update(buf).digest("hex");
      res.json({ content, binary: false, tooLarge: false, hash });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The three merge stages of a conflicted path as plain text, for whichever
  // editor the app's `editor` setting selects (ctx.app.openMerge). The editor
  // edits the *working file* — markers and all, as VS Code does — and these are
  // what its "compare the two sides" action shows. /conflict above stays for
  // git-scm's own block-list resolver, the fallback and secondary action.
  router.get("/conflict-stages", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const relPath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;
      if (!resolveSafePath(root, relPath)) {
        res.status(400).json({ error: "path escapes the repository root" });
        return;
      }
      // Stage 1 is the common ancestor and is absent for an add/add conflict;
      // 2 and 3 are ours and theirs, and a missing one there means the side
      // deleted the file (a modify/delete conflict), which reads as empty.
      const stage = async (n) => {
        try {
          return await git(["show", `:${n}:${relPath}`], root);
        } catch {
          return null;
        }
      };
      const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)]);
      if (ours === null && theirs === null) {
        res.status(400).json({ error: "path has no merge stages — is it actually conflicted?" });
        return;
      }
      const guard = (text, what) => {
        const buf = Buffer.from(text, "utf8");
        if (buf.length > MAX_CONFLICT_FILE_SIZE) return `${what} is too large to merge here`;
        if (looksBinary(buf)) return `${what} looks binary`;
        return null;
      };
      const refusal =
        guard(ours ?? "", "The current side") ??
        guard(theirs ?? "", "The incoming side") ??
        (base === null ? null : guard(base, "The base"));
      if (refusal) {
        res.status(415).json({ error: refusal });
        return;
      }
      res.json({
        base: base === null ? null : { content: base, label: "Base" },
        ours: { content: ours ?? "", label: "Current" },
        theirs: { content: theirs ?? "", label: "Incoming" },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Overwrites a conflicted file's working-tree content with the resolved
  // text. expectedHash must match /conflict's hash of the content this
  // resolution was computed from — guards against clobbering a change made
  // (in nvim, say) since the ConflictView tab last fetched, same rationale
  // as an HTTP If-Match precondition.
  router.post("/resolve", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const relPath = typeof req.body?.path === "string" ? req.body.path : "";
    const content = typeof req.body?.content === "string" ? req.body.content : null;
    const expectedHash = typeof req.body?.expectedHash === "string" ? req.body.expectedHash : "";
    if (!relPath || content === null || !expectedHash) {
      res.status(400).json({ error: "path, content, and expectedHash are required" });
      return;
    }
    try {
      const root = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
      const abs = resolveSafePath(root, relPath);
      if (!abs) {
        res.status(400).json({ error: "path escapes the repository root" });
        return;
      }
      const current = fs.readFileSync(abs);
      const currentHash = createHash("sha256").update(current).digest("hex");
      if (currentHash !== expectedHash) {
        res.status(409).json({ error: "File changed on disk since it was loaded — reopen to see the latest version." });
        return;
      }
      fs.writeFileSync(abs, content, "utf8");
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/abort", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    try {
      const root = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
      // Re-detect server-side rather than trusting a client-supplied
      // operation — the client's view can be a poll interval stale (e.g.
      // the merge already concluded in another terminal).
      const { operation } = await detectOperation(root);
      const command = operation && ABORT_COMMAND[operation];
      if (!command) {
        res.status(400).json({ error: "No merge, rebase, cherry-pick, or revert is in progress." });
        return;
      }
      await git(command, root);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/commit", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
      res.status(400).json({ error: "commit message is required" });
      return;
    }
    const amend = req.body?.amend === true;
    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;
      const args = amend ? ["commit", "--amend", "-m", message] : ["commit", "-m", message];
      await git(args, root);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  async function currentBranch(cwd) {
    return (await git(["branch", "--show-current"], cwd)).trim();
  }

  // Network git calls run without a fixed exec timeout — an interactive
  // prompt can legitimately hold the op open for minutes — bounded instead
  // by the op's watchdog (30s of non-interactive time; paused while a
  // prompt is parked, whose own 2-minute expiry then takes over).
  function gitNetwork(args, cwd, op) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        op.abort = null;
        fn(value);
      };
      op.abort = () =>
        settle(reject, new Error("Timed out waiting for git — check the remote and try again."));
      const child = execFile(
        "git",
        args,
        {
          cwd,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          // detached puts git and its transport helpers in their own
          // process group so the watchdog can kill the whole tree at once.
          // Not on Windows, where it opens a console window instead (the
          // watchdog uses taskkill /T there).
          detached: process.platform !== "win32",
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...relayEnv(op.id) },
        },
        (err, stdout, stderr) => {
          op.child = null;
          clearTimeout(op.watchdog);
          if (err) {
            const wrapped = new Error(stderr.trim() || err.message);
            wrapped.stderr = stderr;
            settle(reject, wrapped);
          } else {
            settle(resolve, stdout);
          }
        },
      );
      op.child = child;
      armWatchdog(op);
    });
  }

  async function runNetworkOp(cwd, op, kind) {
    if (kind === "pull") {
      await gitNetwork(["pull", "--ff-only"], cwd, op);
      return;
    }
    // push: auto-publish (`-u origin <branch>`) when no upstream is set yet
    // and an "origin" remote exists — mirrors VS Code's default publish
    // behavior — otherwise a plain push against the configured upstream.
    const status = parseStatus(await git(["status", "--porcelain=v2", "--branch", "-z"], cwd));
    if (!status.upstream) {
      try {
        await git(["remote", "get-url", "origin"], cwd);
      } catch {
        throw new Error("No upstream branch is configured, and no 'origin' remote exists to publish to.");
      }
      const branch = await currentBranch(cwd);
      await gitNetwork(["push", "-u", "origin", branch], cwd, op);
    } else {
      await gitNetwork(["push"], cwd, op);
    }
  }

  // Runs only after the op *succeeded*: hands the remembered pair to
  // whatever credential helper the user has configured. With none
  // configured this is a silent no-op — the in-memory cache still covers
  // the server's lifetime — and this extension never writes secrets to
  // disk itself.
  function approveRemembered(op, cwd) {
    if (!op.remember) return Promise.resolve();
    const { protocol, host, username, password } = op.remember;
    return new Promise((resolve) => {
      const child = execFile(
        "git",
        ["credential", "approve"],
        { cwd, timeout: DEFAULT_TIMEOUT },
        () => resolve(),
      );
      child.stdin.write(`protocol=${protocol}\nhost=${host}\nusername=${username}\npassword=${password}\n\n`);
      child.stdin.end();
    });
  }

  function networkHandler(kind) {
    return async (req, res) => {
      const cwd = requireCwd(req, res);
      if (!cwd) return;
      const opId = typeof req.body?.opId === "string" ? req.body.opId : "";
      if (!opId) {
        res.status(400).json({ error: "opId is required" });
        return;
      }
      const op = createOp(opId);
      try {
        if (kind === "sync") {
          await runNetworkOp(cwd, op, "pull");
          await runNetworkOp(cwd, op, "push");
        } else {
          await runNetworkOp(cwd, op, kind);
        }
        await approveRemembered(op, cwd);
        res.json({ ok: true });
      } catch (err) {
        const message = (err.stderr || err.message || "").toString().trim();
        if (op.cancelled) {
          res.status(400).json({ error: "Authentication cancelled", cancelled: true });
        } else if (op.timedOut) {
          res.status(500).json({ error: "Timed out waiting for git — check the remote and try again." });
        } else if (isAuthFailure(message)) {
          for (const key of op.authTouched) credCache.delete(key);
          res.status(401).json({ error: message || "Authentication failed" });
        } else {
          res.status(500).json({ error: message });
        }
      } finally {
        destroyOp(op);
      }
    };
  }

  // Amending rewrites HEAD, so the change to describe is HEAD's own diff plus
  // whatever is staged on top — that is HEAD~1..index. A root commit has no
  // HEAD~1; there the staged diff alone is the best available answer.
  async function amendBase(root) {
    try {
      await git(["rev-parse", "--verify", "--quiet", "HEAD~1"], root);
      return "HEAD~1";
    } catch {
      return null;
    }
  }

  router.post("/generate-message", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const amend = req.body?.amend === true;
    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;

      const base = amend ? await amendBase(root) : null;
      const diffArgs = base ? ["diff", "--cached", base] : ["diff", "--cached"];
      const [stat, rawDiff] = await Promise.all([
        git([...diffArgs, "--stat"], root),
        git(diffArgs, root),
      ]);
      if (!rawDiff.trim()) {
        res.status(400).json({ error: amend ? "Nothing to amend." : "No staged changes to describe." });
        return;
      }
      const truncated = rawDiff.length > MAX_DIFF_CHARS;
      const diff = truncated ? `${rawDiff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated]` : rawDiff;

      // Recent subjects let the model match this repository's own conventions
      // instead of defaulting to Conventional Commits. Absent on an unborn
      // branch, which is fine — the instruction alone still applies.
      let recent = "";
      try {
        recent = await git(["log", `--format=%s`, "-n", String(RECENT_SUBJECTS)], root);
      } catch {
        recent = "";
      }

      const settings = (await getSettings?.()) ?? {};
      const configured =
        typeof settings["gitScm.aiCommitInstruction"] === "string"
          ? settings["gitScm.aiCommitInstruction"].trim()
          : "";
      const sections = [configured || DEFAULT_COMMIT_INSTRUCTION];
      if (recent.trim()) {
        sections.push(`Recent commit subjects in this repository, for style:\n${recent.trim()}`);
      }
      if (truncated) {
        sections.push(
          "The patch below is truncated; the file statistics above it are complete. " +
            "Describe the change as a whole, and do not claim to have seen every hunk.",
        );
      }
      sections.push(`Files changed:\n${stat.trim()}`, `Diff:\n${diff}`);

      // gitScm.aiProfile names one of the AIs configured in Settings → AI Providers;
      // empty (the default) lets the app's own default profile answer.
      const profileId =
        typeof settings["gitScm.aiProfile"] === "string" ? settings["gitScm.aiProfile"].trim() : "";
      // Empty falls back to that profile's own model (ai.ts's runAi), which
      // is what "use the provider's setting" means here.
      const model =
        typeof settings["gitScm.aiModel"] === "string" ? settings["gitScm.aiModel"].trim() : "";
      // cwd matters to some CLI providers' trust checks (codex refuses to run
      // outside a trusted directory), so run it in the repository itself
      // rather than wherever the server was started.
      const message = await ai.run(sections.join("\n\n---\n\n"), {
        cwd: root,
        ...(profileId ? { profileId } : {}),
        ...(model ? { model } : {}),
      });
      res.json({ message });
    } catch (err) {
      // ai.run's AiError codes distinguish "not configured yet" from "the
      // provider broke" — both read better as guidance than as a 500.
      const code = err?.code;
      const configIssue =
        code === "missing-binary" || code === "missing-key" || code === "missing-model" || code === "missing-command";
      res.status(configIssue ? 400 : 502).json({ error: String(err?.message ?? err) });
    }
  });

  router.post("/push", networkHandler("push"));
  router.post("/pull", networkHandler("pull"));
  router.post("/sync", networkHandler("sync"));

  // Non-interactive fetch: no askpass relay env, so a repo whose remote
  // needs auth just fails fast (GIT_TERMINAL_PROMPT=0) instead of parking a
  // credential prompt nobody's watching — this is the one network op the
  // background timer calls unattended (see gitScm.fetchInterval), and the
  // manual "Fetch" menu entry reuses it for consistency rather than routing
  // through the interactive gitNetwork/askpass path push/pull/sync use.
  router.post("/fetch", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;
      await git(["fetch"], root, { timeout: 30000 });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/diff", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!filePath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    const staged = req.query.staged === "1";
    const untracked = req.query.untracked === "1";
    const origPath = typeof req.query.origPath === "string" ? req.query.origPath : undefined;
    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;
      let diff;
      if (staged) {
        // Both pathspecs are required for a rename to actually render as a
        // rename — `git diff --cached -- newpath` alone shows a plain
        // "new file" diff instead, confirmed empirically.
        const pathArgs = origPath ? [origPath, filePath] : [filePath];
        diff = await git(["diff", "--cached", "--", ...pathArgs], root);
      } else if (untracked) {
        // An untracked file diffs against the null device, which Windows calls NUL.
        diff = await git(["diff", "--no-index", "--", process.platform === "win32" ? "NUL" : "/dev/null", filePath], root, {
          allowNonZeroExit: true,
        });
      } else {
        diff = await git(["diff", "--", filePath], root);
      }
      res.json({ diff });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // \x1f (field) / \x1e (record) separators — never legitimately present in
  // a hash, name, timestamp, or single-line subject, so no escaping needed
  // to split back apart. Fails (not empty-result) on an unborn branch —
  // caught and turned into an empty list below, same "no error, empty
  // state" convention /status already uses for "not a git repository".
  const LOG_FORMAT = "%H%x1f%an%x1f%at%x1f%s%x1e";

  // Both sides of a file's diff as plain text, for whichever editor the app's
  // `editor` setting selects (ctx.app.openDiff — see docs/EXTENSION_API.md).
  // The unified /diff above stays for git-scm's own DiffView, which is both
  // the fallback when no editor claims the capability and the secondary
  // action either way; this route exists because a real editor wants two
  // documents, not a patch.
  //
  // Which two documents mirrors what /diff shows for the same row:
  //   unstaged  index (:0) -> working file      (working file is editable)
  //   staged    HEAD       -> index (:0)
  //   untracked (empty)    -> working file      (editable)
  // A rename reads its original side from origPath, same as /diff does.
  router.get("/diff-sides", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const relPath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    const staged = req.query.staged === "1";
    const untracked = req.query.untracked === "1";
    const origPath = typeof req.query.origPath === "string" && req.query.origPath ? req.query.origPath : relPath;

    // A side is refused rather than truncated: an editor showing half a file
    // would be worse than falling back to the unified patch view.
    const guard = (text, what) => {
      const buf = Buffer.from(text, "utf8");
      if (buf.length > MAX_CONFLICT_FILE_SIZE) return `${what} is too large to diff here`;
      if (looksBinary(buf)) return `${what} looks binary`;
      return null;
    };

    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;
      const abs = resolveSafePath(root, relPath);
      if (!abs) {
        res.status(400).json({ error: "path escapes the repository root" });
        return;
      }

      // git show exits non-zero when the path isn't in that tree yet (a file
      // staged as new has no HEAD blob) — that's an empty original side, not
      // an error.
      const showOrEmpty = async (rev) => {
        try {
          return { content: await git(["show", rev], root), missing: false };
        } catch {
          return { content: "", missing: true };
        }
      };

      let original;
      let modified;
      if (untracked) {
        original = { content: "", label: "Empty" };
        modified = { content: fs.readFileSync(abs, "utf8"), label: "Working Tree", path: abs };
      } else if (staged) {
        const head = await showOrEmpty(`HEAD:${origPath}`);
        const index = await git(["show", `:0:${relPath}`], root);
        original = { content: head.content, label: head.missing ? "HEAD (new file)" : "HEAD" };
        modified = { content: index, label: "Index" };
        // The right side is index content, which isn't a file on disk. Saving
        // is still useful — but only when the working tree still matches the
        // index, where writing it back changes nothing the user didn't type.
        // Once the working tree has drifted, writing index-based text over it
        // would silently discard those unstaged changes, so the side is
        // read-only and says why.
        const working = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
        if (working !== null && working === index) {
          modified.path = abs;
        } else {
          modified.readOnlyReason =
            "The working tree has unstaged changes beyond the index — open the Working Tree diff to edit.";
        }
      } else {
        const index = await showOrEmpty(`:0:${origPath}`);
        original = { content: index.content, label: index.missing ? "Index (new file)" : "Index" };
        modified = { content: fs.readFileSync(abs, "utf8"), label: "Working Tree", path: abs };
      }

      const refusal = guard(original.content, "The original side") ?? guard(modified.content, "The modified side");
      if (refusal) {
        res.status(415).json({ error: refusal });
        return;
      }
      res.json({ original, modified });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/log", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const rawLimit = Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(200, Math.floor(rawLimit)) : 20;
    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;
      let raw;
      try {
        raw = await git(["log", `--format=${LOG_FORMAT}`, "-n", String(limit)], root);
      } catch {
        res.json({ commits: [] });
        return;
      }
      const commits = raw
        .split("\x1e")
        .map((record) => record.replace(/^\n/, ""))
        .filter((record) => record.length > 0)
        .map((record) => {
          const [hash, author, timestamp, subject] = record.split("\x1f");
          return { hash, author, timestamp: Number(timestamp), subject };
        });
      res.json({ commits });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const COMMIT_HASH_RE = /^[0-9a-f]{4,40}$/i;

  router.get("/commit-diff", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const hash = typeof req.query.hash === "string" ? req.query.hash : "";
    if (!COMMIT_HASH_RE.test(hash)) {
      res.status(400).json({ error: "hash must be a hex commit SHA" });
      return;
    }
    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;
      // firstParent: a stash entry is a merge commit (work tree + index,
      // and with -u a third untracked parent), which `git show` renders as
      // a combined "diff --cc" against every parent at once. Against the
      // first parent alone it's the ordinary patch the stash actually
      // holds. Both flags are no-ops on a single-parent commit, but they're
      // still opt-in: an ordinary merge's COMMITS row keeps the combined
      // diff it has always shown.
      const showArgs = req.query.firstParent === "1" ? ["show", "-m", "--first-parent", hash] : ["show", hash];
      const diff = await git([...showArgs, "--format=fuller", "--patch"], root);
      res.json({ diff });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/branches", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;
      const [raw, current] = await Promise.all([
        git(["for-each-ref", "refs/heads", "--format=%(refname:short)%00"], root),
        currentBranch(root),
      ]);
      // Same NUL-plus-git's-own-trailing-newline shape as /log's record
      // separator — see that route's comment for why the leading "\n"
      // strip is needed.
      const branches = raw
        .split("\0")
        .map((b) => b.replace(/^\n/, ""))
        .filter((b) => b.length > 0);
      res.json({ branches, current });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Rejects a branch name starting with "-" — passed straight through to
  // `git switch` as a positional argument otherwise, where a leading dash
  // would be parsed as an option instead of a ref name.
  const SAFE_BRANCH_RE = /^[^-]/;

  router.post("/checkout", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const branch = typeof req.body?.branch === "string" ? req.body.branch.trim() : "";
    const create = req.body?.create === true;
    if (!branch || !SAFE_BRANCH_RE.test(branch)) {
      res.status(400).json({ error: "branch is required and cannot start with '-'" });
      return;
    }
    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;
      // Errors (dirty working tree blocking the switch, branch already
      // exists on create, invalid ref name) pass through as git wrote them
      // — no attempt to reword git's own messages here.
      await git(create ? ["switch", "-c", branch] : ["switch", branch], root);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/stash", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const includeUntracked = req.body?.includeUntracked === true;
    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;
      await git(includeUntracked ? ["stash", "push", "-u"] : ["stash", "push"], root);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // "stash@{3}" and nothing else. git args go through execFile (no shell),
  // so this isn't about quoting — it's about a ref starting with "-" being
  // read as an option by whichever git command it reaches.
  const STASH_REF_RE = /^stash@\{\d+\}$/;

  // undefined = already answered 400; null = no ref given, which every
  // caller here reads as "the latest entry".
  function requireStashRef(req, res) {
    const ref = req.body?.ref;
    if (ref === undefined || ref === null) return null;
    if (typeof ref === "string" && STASH_REF_RE.test(ref)) return ref;
    res.status(400).json({ error: "Invalid stash ref." });
    return undefined;
  }

  // `git stash apply/pop` exits 1 both for a real failure (no such entry —
  // the message lands on stderr) and for a structurally-successful but
  // CONFLICTING restore (narration on stdout, stderr empty, and the entry
  // itself kept). Only the latter is tolerated: the panel's next status
  // refresh renders the conflict as an ordinary Merge Changes entry, the
  // same as any other conflicted path, with no dedicated stash-conflict UI.
  function stashRestore(root, args) {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd: root,
          encoding: "utf8",
          timeout: DEFAULT_TIMEOUT,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
        (err, stdout, stderr) => {
          if (err && !(err.code === 1 && stderr.trim() === "")) {
            const wrapped = new Error(stderr.trim() || err.message);
            wrapped.stderr = stderr;
            reject(wrapped);
          } else {
            resolve();
          }
        },
      );
    });
  }

  // Same record/field separators as LOG_FORMAT above. %gd is the entry's
  // ref ("stash@{0}"), %gs its reflog subject ("WIP on main: 3445ac1 …"),
  // and %H the commit the entry IS — which is what lets a row open through
  // the ordinary commit-diff path instead of a stash-specific viewer.
  const STASH_FORMAT = "%H%x1f%gd%x1f%ct%x1f%gs%x1e";

  router.get("/stashes", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;
      let raw;
      try {
        raw = await git(["stash", "list", `--format=${STASH_FORMAT}`], root);
      } catch {
        // refs/stash doesn't exist until the first stash — the same "none
        // yet" non-error /status's own count already swallows.
        res.json({ stashes: [] });
        return;
      }
      const stashes = raw
        .split("\x1e")
        .map((record) => record.replace(/^\n/, ""))
        .filter((record) => record.length > 0)
        .map((record) => {
          const [hash, ref, timestamp, subject] = record.split("\x1f");
          return { hash, ref, timestamp: Number(timestamp), subject };
        });
      res.json({ stashes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Apply without dropping — the non-destructive half of pop, for reusing
  // one entry across several branches.
  router.post("/stash-apply", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const ref = requireStashRef(req, res);
    if (ref === undefined) return;
    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;
      await stashRestore(root, ref ? ["stash", "apply", ref] : ["stash", "apply"]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Unrecoverable through the UI once done (the dropped commit is only
  // reachable by hash afterwards), so the pane confirms first.
  router.post("/stash-drop", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const ref = requireStashRef(req, res);
    if (ref === undefined) return;
    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;
      await git(ref ? ["stash", "drop", ref] : ["stash", "drop"], root);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // No ref pops the latest, which is what the panel's More Actions entry
  // sends; the STASH pane's rows name the entry they mean.
  router.post("/stash-pop", async (req, res) => {
    const cwd = requireCwd(req, res);
    if (!cwd) return;
    const ref = requireStashRef(req, res);
    if (ref === undefined) return;
    try {
      const root = await requireRoot(cwd, res);
      if (!root) return;
      await stashRestore(root, ref ? ["stash", "pop", ref] : ["stash", "pop"]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  log("git-scm server hook active");
}

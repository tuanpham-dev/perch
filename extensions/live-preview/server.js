// Server hook for the live-preview extension — serves an HTML file (and its
// sibling assets) by absolute path, and reports the mtimes of the files the
// preview has actually loaded for the client's reload-on-change poll. Plain ESM: the server runs under
// tsx in both dev and prod (see server/package.json), so no build step is
// needed here, unlike the client entry (see extensions/build.mjs).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { mountScreenshotRoutes } from "../_shared/screenshotRoutes.mjs";
import { mountAgentStateRoutes } from "../_shared/agentStateRoutes.mjs";

// Paths from the page may arrive "~"-shortened, the way core shows them
// (server files.ts's shortenHome) - expand before touching the filesystem
// (docs/EXTENSION_API.md, server entry rules).
function expandHome(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir(), p.slice(2));
  return p;
}

// Injected into HTML responses so the previewed page can report its scroll
// position to the host tab and accept a restore command after a reload —
// sessionStorage isn't usable here since the iframe (sandbox="allow-scripts"
// only, no allow-same-origin — see client.tsx) has an opaque origin where
// storage access throws.
const SCROLL_SCRIPT = `<script>(function(){
  var last = [0, 0];
  window.addEventListener("scroll", function() {
    var next = [window.scrollX, window.scrollY];
    if (next[0] === last[0] && next[1] === last[1]) return;
    last = next;
    window.parent.postMessage({ __livePreviewScroll: next }, "*");
  }, { passive: true });
  window.addEventListener("message", function(e) {
    var pos = e && e.data && e.data.__livePreviewRestore;
    if (Array.isArray(pos)) window.scrollTo(pos[0], pos[1]);
  });
})();</script>`;

// The page bootstrap (../_shared/pageBootstrap.js): starts the page's error
// log before its own scripts run, and installs the page agent (element
// picking, badges that follow the page, screenshots) when the preview tab
// sends it. Read once; it ships with the bundled extensions.
const BOOTSTRAP_SCRIPT = `<script>${readFileSync(new URL("../_shared/pageBootstrap.js", import.meta.url), "utf8")}</script>`;

function injectScripts(html) {
  const combined = BOOTSTRAP_SCRIPT + SCROLL_SCRIPT;
  const headClose = html.search(/<\/head\s*>/i);
  if (headClose !== -1) return html.slice(0, headClose) + combined + html.slice(headClose);
  const bodyClose = html.search(/<\/body\s*>/i);
  if (bodyClose !== -1) return html.slice(0, bodyClose) + combined + html.slice(bodyClose);
  return html + combined;
}

// Joins root + relPath, rejecting anything that escapes root — same
// approach as server/src/files.ts's resolveDestination, reimplemented here
// since extension server hooks can't import server-core internals.
function resolveWithinRoot(root, relPath) {
  if (path.isAbsolute(relPath)) return null;
  const resolved = path.resolve(root, relPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

// dir -> token (reused so re-previewing the same folder doesn't keep minting
// fresh ones) and token -> dir (what /public/* actually authorizes against).
// No expiry: this is a single-user local dev tool, and each entry is just
// two short strings, bounded by how many distinct folders are ever
// previewed in the process's lifetime.
const dirTokens = new Map();
const tokenDirs = new Map();
// A preview of an HTML file sitting directly in the home folder or a
// filesystem root reaches only that file: a token for the whole folder
// would let an untrusted page fetch anything under ~. token -> the one
// root-relative path it may serve.
const tokenOnlyFile = new Map();

// The home folder, or the top of a filesystem ("/", "C:\\").
function isBroadFolder(dir) {
  const resolved = path.resolve(dir);
  return resolved === path.resolve(homedir()) || path.dirname(resolved) === resolved;
}

// Hidden files and folders (.ssh, .env, .git, …) are never served.
function hasHiddenSegment(relPath) {
  return relPath.split(/[\\/]/).some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");
}

// token -> the root-relative paths the preview has requested through
// /public/serve: the HTML, and every stylesheet, script, image or fetch it
// made. These, and only these, are what the reload poll watches. Watching
// the whole folder reloaded the page whenever anything else in it changed -
// a log, an agent's notes, a build writing next door - and a reload throws
// away the page's own state (an open popup, a filled form) every few
// seconds. A path that 404ed is kept too, so creating it reloads the page
// that wanted it. Shared by every preview of the same folder, since they
// share the token; capped so a page that fetches endlessly-new URLs can't
// grow it without bound.
const servedPaths = new Map();
const MAX_WATCHED = 500;

function noteServed(token, relPath) {
  let paths = servedPaths.get(token);
  if (!paths) {
    paths = new Set();
    servedPaths.set(token, paths);
  }
  if (paths.size < MAX_WATCHED) paths.add(relPath);
}

export function activate({ router, host }) {
  mountScreenshotRoutes(router);
  mountAgentStateRoutes(router, host);
  // Origin-checked normally (not under /public/) — see
  // server/src/security.ts's isOriginExemptPath for why that matters: this
  // is the only way a token can come into existence, so an attacker's page
  // (which fails the app's normal Origin check) can never mint one.
  router.get("/token", async (req, res) => {
    const dir = typeof req.query.dir === "string" ? expandHome(req.query.dir) : "";
    if (!dir) {
      res.status(400).json({ error: "dir is required" });
      return;
    }
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) throw new Error("not a directory");
    } catch {
      res.status(400).json({ error: "dir does not exist" });
      return;
    }
    const file = typeof req.query.file === "string" ? path.basename(req.query.file) : "";
    if (isBroadFolder(dir)) {
      // Scoped to the one file, so a fresh token per file rather than the
      // folder's shared one.
      if (!file) {
        res.status(400).json({ error: "file is required for a file in this folder" });
        return;
      }
      const key = `${dir}\0${file}`;
      let token = dirTokens.get(key);
      if (!token) {
        token = randomBytes(24).toString("base64url");
        dirTokens.set(key, token);
        tokenDirs.set(token, dir);
        tokenOnlyFile.set(token, file);
      }
      res.json({ token });
      return;
    }
    let token = dirTokens.get(dir);
    if (!token) {
      token = randomBytes(24).toString("base64url");
      dirTokens.set(dir, token);
      tokenDirs.set(token, dir);
    }
    res.json({ token });
  });

  // Origin-exempt (see isOriginExemptPath) — the sandboxed preview iframe's
  // opaque origin sends Origin: null on these requests, which the app's
  // global gate would otherwise reject. Authorization here is the token
  // itself, not Origin: only a request that already passed the normal
  // Origin check (via /token above) can have obtained one.
  router.get("/public/serve/:token/*", async (req, res) => {
    const root = tokenDirs.get(req.params.token);
    if (!root) {
      res.status(404).json({ error: "unknown or expired preview" });
      return;
    }
    const relPath = req.params[0] ?? "";
    const target = resolveWithinRoot(root, relPath);
    if (!target) {
      res.status(400).json({ error: "path escapes preview root" });
      return;
    }
    const onlyFile = tokenOnlyFile.get(req.params.token);
    if (hasHiddenSegment(path.relative(root, target)) || (onlyFile && path.relative(root, target) !== onlyFile)) {
      res.status(404).json({ error: "file not found" });
      return;
    }
    noteServed(req.params.token, path.relative(root, target));
    // ORB (Chrome's Opaque Response Blocking) requires an explicit opt-in
    // for subresource loads made from an opaque-origin (sandboxed iframe)
    // context, even when served by this same process. Module scripts
    // (<script type="module">, and anything they import) go further and
    // fetch in CORS mode regardless of same-origin-ness, sending
    // "Origin: null" for this opaque-origin iframe — without an explicit
    // Access-Control-Allow-Origin the browser discards the response before
    // it ever reaches the module loader, so e.g. a subfolder entry point
    // like src/main.js silently fails while a same-folder classic <script>
    // works. No credentials are ever sent from an opaque origin, so the
    // wildcard is safe here (browsers reject "*" only when a request
    // carries credentials).
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    res.set("Access-Control-Allow-Origin", "*");
    const ext = path.extname(target).toLowerCase();
    if (ext === ".html" || ext === ".htm") {
      try {
        const html = await readFile(target, "utf8");
        res.type("html").send(injectScripts(html));
      } catch {
        res.status(404).json({ error: "file not found" });
      }
      return;
    }
    res.sendFile(target, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: "file not found" });
    });
  });

  // Each watched file's mtime, -1 when it doesn't exist. The client reloads
  // when a file it saw before now reads differently; a path that is new to
  // the list is just the page loading something, not a change.
  router.get("/public/mtime", async (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const dir = tokenDirs.get(token);
    if (!dir) {
      res.status(404).json({ error: "unknown or expired preview" });
      return;
    }
    const files = {};
    await Promise.all(
      [...(servedPaths.get(token) ?? [])].map(async (relPath) => {
        try {
          files[relPath] = (await stat(path.join(dir, relPath))).mtimeMs;
        } catch {
          files[relPath] = -1;
        }
      }),
    );
    res.json({ files });
  });
}

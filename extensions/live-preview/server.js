// Server hook for the live-preview extension — serves an HTML file (and its
// sibling assets) by absolute path, and reports the max mtime of that folder
// for the client's reload-on-change poll. Plain ESM: the server runs under
// tsx in both dev and prod (see server/package.json), so no build step is
// needed here, unlike the client entry (see extensions/build.mjs).
import { randomBytes } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

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

// The element picker (Orca-style "Design Mode", scoped to live-preview's own
// sandboxed HTML files only — see plans/orca-features-implementation.md's
// Approach on why a proxied dev-server response is a different risk class
// and out of scope here). Armed/disarmed by a postMessage from the parent
// tab (client.tsx's inspect toggle); while armed, mousemove outlines the
// hovered element with one shared overlay box (no per-element style writes,
// so hovering doesn't fight the page's own styles) and a capture-phase click
// (preventDefault'd so the page's own click handlers never fire while
// picking) posts the selector/outerHTML/computed-styles back to the parent.
const INSPECT_SCRIPT = `<script>(function(){
  var armed = false;
  var hovered = null;
  var overlay = null;
  var STYLE_PROPS = ["display","position","top","right","bottom","left","width","height",
    "margin","padding","boxSizing","color","backgroundColor","fontFamily","fontSize",
    "fontWeight","lineHeight","flexDirection","justifyContent","alignItems"];

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;" +
      "background:rgba(79,168,255,0.25);border:1px solid rgba(79,168,255,0.9);display:none;";
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  // Walks up from el to (not including) <body>, building a short CSS-like
  // path: tag#id (stops climbing once an id is hit — ids are unique enough
  // to anchor the whole path), else tag.class1.class2 plus :nth-of-type(n)
  // when siblings share the same tag. A rough locator for a human or an
  // agent to find the element again, not a guaranteed-unique selector.
  function selectorFor(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(part + "#" + node.id);
        break;
      }
      if (typeof node.className === "string" && node.className.trim()) {
        var cls = node.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2);
        if (cls.length) part += "." + cls.join(".");
      }
      var parent = node.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (siblings.length > 1) {
          part += ":nth-of-type(" + (Array.prototype.indexOf.call(siblings, node) + 1) + ")";
        }
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function onMouseMove(e) {
    if (!armed) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay) return;
    hovered = el;
    var r = el.getBoundingClientRect();
    var o = ensureOverlay();
    o.style.left = r.left + "px";
    o.style.top = r.top + "px";
    o.style.width = r.width + "px";
    o.style.height = r.height + "px";
    o.style.display = "block";
  }

  function onClick(e) {
    if (!armed) return;
    e.preventDefault();
    e.stopPropagation();
    var el = hovered || document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    var cs = window.getComputedStyle(el);
    var styles = {};
    STYLE_PROPS.forEach(function (p) { styles[p] = cs[p]; });
    var html = el.outerHTML;
    if (html.length > 4000) html = html.slice(0, 4000) + "…";
    // Viewport-relative rect — the host positions its comment popover with
    // this directly (live-preview-frame fills its host 1:1, no offset math
    // needed on the host side, see client.tsx).
    var r = el.getBoundingClientRect();
    window.parent.postMessage(
      {
        __livePreviewPicked: {
          selector: selectorFor(el),
          outerHTML: html,
          styles: styles,
          rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        },
      },
      "*",
    );
  }

  window.addEventListener("message", function (e) {
    var val = e && e.data && e.data.__livePreviewInspect;
    if (typeof val !== "boolean") return;
    armed = val;
    if (!armed && overlay) overlay.style.display = "none";
  });
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("click", onClick, true);
})();</script>`;

function injectScripts(html) {
  const combined = SCROLL_SCRIPT + INSPECT_SCRIPT;
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

export function activate({ router }) {
  // Origin-checked normally (not under /public/) — see
  // server/src/security.ts's isOriginExemptPath for why that matters: this
  // is the only way a token can come into existence, so an attacker's page
  // (which fails the app's normal Origin check) can never mint one.
  router.get("/token", async (req, res) => {
    const dir = typeof req.query.dir === "string" ? req.query.dir : "";
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

  router.get("/public/mtime", async (req, res) => {
    const dir = tokenDirs.get(typeof req.query.token === "string" ? req.query.token : "");
    if (!dir) {
      res.status(404).json({ error: "unknown or expired preview" });
      return;
    }
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      let max = 0;
      for (const entry of entries) {
        if (!entry.isFile() || entry.name === ".git") continue;
        const s = await stat(path.join(dir, entry.name));
        if (s.mtimeMs > max) max = s.mtimeMs;
      }
      res.json({ mtime: max });
    } catch {
      res.status(400).json({ error: "cannot read directory" });
    }
  });
}

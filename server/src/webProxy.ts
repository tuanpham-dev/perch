import { Router, type Request } from "express";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import zlib from "node:zlib";
import { readSettingsDoc } from "./settingsStore.js";
import { type CookieStore, type SameSiteContext, webPreviewCookies } from "./webProxyCookies.js";
import { type AllowList, BlockedAddressError, assertLiteralAllowed, guardedLookup, parseAllowList } from "./webProxyGuard.js";
import { rewriteCss, rewriteHtml, rewriteJsModuleSpecifiers } from "./webProxyRewrite.js";
import { consumeCrossSiteEntry, getToken, mintToken } from "./webProxyTokens.js";
import {
  type ProxiedAddress,
  WEB_PREFIX,
  WP_PARAM,
  fromAnyProxyPath,
  fromDocumentPath,
  fromProxyPath,
  siteOf,
  toDocumentPath,
  toProxyPath,
} from "./webProxyUrls.js";

// The web preview: any site, loaded through this server into a sandboxed
// frame in a Perch tab, so its elements can be picked and commented on like a
// local HTML file's. Everything the page loads comes back here (the URL forms
// are in webProxyUrls.ts) and goes out to the site from this server — when the
// app is connected to a remote Perch, the site is reached from that server's
// network, never from the viewer's machine.
//
// Authorization is the token in every proxied URL (webProxyTokens.ts), minted
// only by POST /api/web-preview/open, which passes the app's Origin and
// sign-in checks. The /web/ routes skip both — the frame's opaque origin sends
// Origin: null and no cookies — which is safe for the same reason
// live-preview's /public/ routes are (security.ts's isOriginExemptPath).

const MAX_REWRITE_BYTES = 15 * 1024 * 1024;
const MAX_COOKIE_WRITE_BYTES = 8 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
const ALLOW_TTL_MS = 5_000;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// Request headers that describe this server or the frame rather than the
// site: the site gets its own values (or none) instead.
const DROP_REQUEST = new Set([
  "host",
  "cookie",
  "origin",
  "referer",
  "x-auth-token",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
  "accept-encoding",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
  "sec-fetch-storage-access",
  "upgrade-insecure-requests",
]);

// Response headers that would stop the page loading in the frame, pin
// things to the real origin, or reach past the page into this server.
const DROP_RESPONSE = new Set([
  "set-cookie",
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "strict-transport-security",
  "clear-site-data",
  "referrer-policy",
  "alt-svc",
  "report-to",
  "reporting-endpoints",
  "nel",
  "public-key-pins",
  "expect-ct",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-expose-headers",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-max-age",
]);

export interface WebProxyOptions {
  cookies?: CookieStore;
  // Hosts and ranges the address guard lets through; defaults to the
  // webPreviewAllowedHosts setting.
  loadAllowList?: () => Promise<AllowList>;
}

function isDocumentDest(dest: string | undefined): boolean {
  return dest === "document" || dest === "iframe" || dest === "frame";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

// What the frame shows when a page can't load. The Perch tab draws the real
// message in its own theme from the posted copy; the text here is the
// fallback for a frame nobody is listening to.
function framePage(message: Record<string, unknown>, text: string): string {
  const json = JSON.stringify({ __webPreview: message }).replace(/</g, "\\u003c");
  return (
    `<!doctype html><meta charset="utf-8"><title>${htmlEscape(text)}</title>` +
    `<style>body{font:13px system-ui,sans-serif;color:#888;background:transparent;padding:24px}</style>` +
    `<p>${htmlEscape(text)}</p><script>parent.postMessage(${json},"*")</script>`
  );
}

function sendFrameError(res: ServerResponse, status: number, title: string, detail: string, url?: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(framePage({ type: "error", title, detail, url }, `${title}. ${detail}`));
}

function describeError(err: unknown, target: URL): { title: string; detail: string } {
  if (err instanceof BlockedAddressError) {
    return {
      title: `Blocked ${target.host}`,
      detail: `${err.hostname} resolves to ${err.address}, a private or local address. To open it, add it to Settings → Behavior → Private hosts the web preview may open.`,
    };
  }
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return { title: `Couldn't find ${target.host}`, detail: "The server can't resolve this address. Check the spelling, or whether the site is reachable from the Perch server." };
  }
  if (code === "ECONNREFUSED") return { title: `${target.host} refused the connection`, detail: "Nothing is accepting connections at that address." };
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return { title: `${target.host} didn't respond`, detail: "The site took too long to answer." };
  if (typeof code === "string" && (code.startsWith("ERR_TLS") || code.includes("CERT"))) {
    return { title: `Couldn't connect securely to ${target.host}`, detail: (err as Error).message };
  }
  return { title: `Couldn't load ${target.host}`, detail: err instanceof Error ? err.message : String(err) };
}

function decompress(body: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(body);
    case "deflate":
      try {
        return zlib.inflateSync(body);
      } catch {
        return zlib.inflateRawSync(body);
      }
    case "br":
      return zlib.brotliDecompressSync(body);
    case "":
    case "identity":
      return body;
    default:
      throw new Error(`unsupported content-encoding ${encoding}`);
  }
}

function charsetOf(contentType: string): string {
  const match = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType);
  return match ? match[1].toLowerCase() : "utf-8";
}

function readBody(stream: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        stream.destroy();
        reject(new Error("too large"));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// Paths that are always the app's own, whoever asks.
const APP_PATH_RE = /^\/(api|ws|proxy|absproxy|web)(\/|$)/;

// A proxied page navigating its frame to a path on this server's root
// ("/pricing" from a script's location.href = "/pricing"). Chrome sends no
// Referer from an opaque-origin document, so which site it belongs to isn't
// in the request; the frame asks the Perch tab instead (see handleWebRequest).
// Recognized by what only such a frame sends: a frame navigation arriving
// cross-site. The app's own pages load same-origin.
function isStrayFrameNavigation(req: IncomingMessage): boolean {
  const dest = headerValue(req.headers["sec-fetch-dest"]);
  if (dest !== "iframe" && dest !== "frame") return false;
  if (headerValue(req.headers["sec-fetch-site"]) !== "cross-site") return false;
  const pathname = (req.url ?? "/").split("?")[0];
  return !APP_PATH_RE.test(pathname);
}

// The real address a proxied page's Referer stands for, for a request that
// left the proxy ("/assets/x.js" built against this server's root).
function refererAddress(req: IncomingMessage): ProxiedAddress | null {
  const referer = headerValue(req.headers.referer);
  if (!referer) return null;
  let ref: URL;
  try {
    ref = new URL(referer);
  } catch {
    return null;
  }
  if (ref.host !== req.headers.host) return null;
  return fromAnyProxyPath(ref.pathname + ref.search);
}

function corsHeaders(req: IncomingMessage, exposed: string[]): Record<string, string> {
  const origin = headerValue(req.headers.origin);
  // The frame's origin is opaque ("null"). Echoing it (rather than "*")
  // keeps credentialed fetches working; the site's own cookies are
  // attached here, never by the browser.
  const headers: Record<string, string> = {
    "access-control-allow-origin": origin ?? "*",
    "cross-origin-resource-policy": "cross-origin",
  };
  if (origin) {
    headers["access-control-allow-credentials"] = "true";
    headers.vary = "Origin";
    headers["access-control-expose-headers"] = [...new Set([...exposed, "x-web-preview-cookie"])].join(", ");
  }
  return headers;
}

export function createWebProxy(opts: WebProxyOptions = {}) {
  const cookies = () => opts.cookies ?? webPreviewCookies();

  let allow: AllowList = parseAllowList([]);
  let allowLoadedAt = 0;
  async function refreshAllowList(): Promise<void> {
    if (Date.now() - allowLoadedAt < ALLOW_TTL_MS) return;
    allowLoadedAt = Date.now();
    if (opts.loadAllowList) {
      allow = await opts.loadAllowList();
      return;
    }
    const settings = ((await readSettingsDoc()).settings ?? {}) as Record<string, unknown>;
    const list = settings.webPreviewAllowedHosts;
    allow = parseAllowList(Array.isArray(list) ? list : []);
  }
  const lookup = guardedLookup(() => allow);

  // Whether this request is the web preview's, by URL alone (so the app's
  // Origin and sign-in middleware can step aside for it).
  function isWebProxyRequest(req: IncomingMessage): boolean {
    const url = req.url ?? "/";
    if (url.startsWith(WEB_PREFIX)) return true;
    if (url.includes(`${WP_PARAM}=`) && fromDocumentPath(url)) return true;
    return refererAddress(req) !== null || isStrayFrameNavigation(req);
  }

  async function handleCookieWrite(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    const entry = getToken(token);
    const page = new URL(req.url ?? "/", "http://x").searchParams.get("u");
    let pageUrl: URL | null = null;
    try {
      pageUrl = page ? new URL(page) : null;
    } catch {
      pageUrl = null;
    }
    const cors = corsHeaders(req, []);
    if (!entry || !pageUrl || siteOf(pageUrl) !== entry.site) {
      res.writeHead(403, cors).end();
      return;
    }
    const body = (await readBody(req, MAX_COOKIE_WRITE_BYTES)).toString("utf8");
    await cookies().setFromScript(pageUrl, body);
    res.writeHead(204, cors).end();
  }

  async function handleWebRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const dest = headerValue(req.headers["sec-fetch-dest"]);
    const isDocument = isDocumentDest(dest);

    const cookieRoute = /^\/web\/([A-Za-z0-9_-]{16,64})\/__perch\/cookie(?:\?|$)/.exec(url);
    if (cookieRoute) {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...corsHeaders(req, []), "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" }).end();
        return;
      }
      await handleCookieWrite(req, res, cookieRoute[1]);
      return;
    }

    const asResource = fromProxyPath(url);
    const address = asResource ?? fromDocumentPath(url);
    if (!address) {
      // A request that left the proxy: send it back in, in the form its
      // destination needs. 307 keeps a POST a POST.
      const ref = refererAddress(req);
      if (!ref) {
        if (isStrayFrameNavigation(req)) {
          // The Perch tab knows which site its frame is on, and opens the
          // path there.
          req.resume();
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(framePage({ type: "escaped", path: url }, "Opening…"));
          return;
        }
        res.writeHead(404).end();
        return;
      }
      const target = new URL(url, ref.target.origin);
      res.writeHead(307, {
        location: isDocument ? toDocumentPath(target, ref.token) : toProxyPath(target, ref.token),
        "cache-control": "no-store",
        ...corsHeaders(req, []),
      });
      res.end();
      return;
    }

    const { token, target } = address;
    const entry = getToken(token);
    if (!entry) {
      if (isDocument) {
        sendFrameError(res, 403, "This preview has expired", "Press Enter in the address bar to load the page again.", target.href);
      } else {
        res.writeHead(403, corsHeaders(req, [])).end();
      }
      return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      res.writeHead(400, corsHeaders(req, [])).end();
      return;
    }

    // The page in the frame is always in document form, so its address is
    // the site's real path.
    if (isDocument && asResource) {
      res.writeHead(307, { location: toDocumentPath(target, token), "cache-control": "no-store" }).end();
      return;
    }

    // Cookies stay with their own site (see webProxyTokens.ts). A frame moving
    // to another site gets a token of that site's own; anything else asking
    // another site for something goes without cookies, as a browser blocking
    // third-party cookies sends it.
    const targetSite = siteOf(target);
    let sameSite: SameSiteContext = "strict";
    let firstParty = true;
    if (targetSite !== entry.site) {
      if (isDocument) {
        const method = req.method ?? "GET";
        const next = mintToken(targetSite, { crossSiteEntry: method === "GET" || method === "HEAD" ? "lax" : "none" });
        res.writeHead(307, { location: toDocumentPath(target, next), "cache-control": "no-store" }).end();
        return;
      }
      firstParty = false;
    } else if (isDocument) {
      sameSite = consumeCrossSiteEntry(token) ?? "strict";
    }

    if (req.method === "OPTIONS" && req.headers["access-control-request-method"]) {
      // A CORS preflight the browser sends because the frame's origin isn't
      // the site's. The site never sees it: on its own origin it wouldn't.
      res.writeHead(204, {
        ...corsHeaders(req, []),
        "access-control-allow-methods": headerValue(req.headers["access-control-request-method"]) ?? "GET",
        "access-control-allow-headers": headerValue(req.headers["access-control-request-headers"]) ?? "*",
        "access-control-max-age": "600",
      });
      res.end();
      return;
    }

    await refreshAllowList();
    try {
      assertLiteralAllowed(target.hostname, allow);
    } catch (err) {
      req.resume();
      if (isDocument) {
        const { title, detail } = describeError(err, target);
        sendFrameError(res, 502, title, detail, target.href);
      } else {
        res.writeHead(502, corsHeaders(req, [])).end();
      }
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name) || DROP_REQUEST.has(name)) continue;
      headers[name] = value;
    }
    headers.host = target.host;
    headers["accept-encoding"] = "gzip, deflate, br";
    if (req.headers.origin) headers.origin = target.origin;
    const ref = refererAddress(req);
    if (ref) headers.referer = ref.target.href;
    if (firstParty) {
      const cookieHeader = await cookies().cookieHeader(target, sameSite);
      if (cookieHeader) headers.cookie = cookieHeader;
    }

    const client = target.protocol === "https:" ? https : http;
    const upstream = client.request(target, {
      method: req.method,
      headers,
      lookup,
      timeout: UPSTREAM_TIMEOUT_MS,
      // Each request resolves through the guard afresh.
      agent: false,
    });

    upstream.on("timeout", () => upstream.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    upstream.on("error", (err) => {
      if (isDocument) {
        const { title, detail } = describeError(err, target);
        sendFrameError(res, 502, title, detail, target.href);
      } else if (!res.headersSent) {
        res.writeHead(502, corsHeaders(req, [])).end();
      } else {
        res.destroy();
      }
    });
    upstream.on("response", (up) => {
      void respond(req, res, up, { token, target, isDocument, dest, firstParty, sameSite }).catch((err) => {
        up.destroy();
        if (isDocument) {
          const { title, detail } = describeError(err, target);
          sendFrameError(res, 502, title, detail, target.href);
        } else if (!res.headersSent) {
          res.writeHead(502, corsHeaders(req, [])).end();
        } else {
          res.destroy();
        }
      });
    });
    req.pipe(upstream);
  }

  async function respond(
    req: IncomingMessage,
    res: ServerResponse,
    up: IncomingMessage,
    ctx: { token: string; target: URL; isDocument: boolean; dest?: string; firstParty: boolean; sameSite: SameSiteContext },
  ): Promise<void> {
    const { token, target, isDocument } = ctx;
    const setCookie = up.headers["set-cookie"] ?? [];
    if (ctx.firstParty && setCookie.length > 0) await cookies().setFromResponse(target, setCookie, ctx.sameSite);

    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(up.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name) || DROP_RESPONSE.has(name)) continue;
      out[name] = value;
    }
    const location = headerValue(up.headers.location);
    if (location) {
      try {
        const next = new URL(location, target);
        if (next.protocol === "http:" || next.protocol === "https:") {
          out.location = isDocument ? toDocumentPath(next, token) : toProxyPath(next, token);
        }
      } catch {
        // an unparseable Location goes through as sent
      }
    }
    Object.assign(out, corsHeaders(req, Object.keys(out)));
    if (ctx.firstParty && setCookie.length > 0 && !isDocument) {
      out["x-web-preview-cookie"] = encodeURIComponent(await cookies().documentCookie(target));
    }

    const status = up.statusCode ?? 502;
    const contentType = (headerValue(up.headers["content-type"]) ?? "").toLowerCase();
    const disposition = (headerValue(up.headers["content-disposition"]) ?? "").toLowerCase();

    // A download can't happen inside a sandboxed frame; the tab hands it to
    // the browser instead.
    if (isDocument && disposition.startsWith("attachment")) {
      up.resume();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(framePage({ type: "download", url: target.href }, `Downloading ${target.href}`));
      return;
    }

    const isHtml = isDocument && contentType.includes("text/html");
    const isCss = contentType.includes("text/css");
    const isScript = (ctx.dest === "script" || ctx.dest === "worker" || ctx.dest === "sharedworker") && /javascript|ecmascript/.test(contentType);
    const noBody = req.method === "HEAD" || status === 204 || status === 304;
    if (noBody || !(isHtml || isCss || isScript)) {
      res.writeHead(status, out);
      up.pipe(res);
      return;
    }

    let raw: Buffer;
    try {
      raw = decompress(await readBody(up, MAX_REWRITE_BYTES), headerValue(up.headers["content-encoding"]));
    } catch (err) {
      if ((err as Error).message === "too large") {
        throw new Error(`The page is larger than ${MAX_REWRITE_BYTES / 1024 / 1024} MB, the most the preview rewrites.`);
      }
      throw err;
    }
    let text: string;
    try {
      text = new TextDecoder(charsetOf(contentType)).decode(raw);
    } catch {
      text = raw.toString("utf8");
    }
    let body: string;
    if (isHtml) {
      const cookie = ctx.firstParty ? await cookies().documentCookie(target) : "";
      body = await rewriteHtml(text, { target, token, cookie });
      out["content-type"] = "text/html; charset=utf-8";
      out["referrer-policy"] = "unsafe-url";
      out["cache-control"] = "no-store";
    } else if (isCss) {
      body = rewriteCss(text, target, token);
      out["content-type"] = "text/css; charset=utf-8";
    } else {
      body = await rewriteJsModuleSpecifiers(text, target, token);
      out["content-type"] = "text/javascript; charset=utf-8";
    }
    delete out["content-encoding"];
    delete out["content-length"];
    delete out.etag;
    delete out["content-md5"];
    res.writeHead(status, out);
    res.end(body);
  }

  // WebSockets the page opens (the runtime rewrites their URLs to the
  // resource form). Same token, site and address checks as a request.
  function handleWebUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const address = fromProxyPath(req.url ?? "/");
    const entry = address ? getToken(address.token) : null;
    if (!address || !entry) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const target = new URL(address.target.href);
    if (target.protocol === "ws:") target.protocol = "http:";
    else if (target.protocol === "wss:") target.protocol = "https:";
    const firstParty = siteOf(target) === entry.site;

    void (async () => {
      await refreshAllowList();
      assertLiteralAllowed(target.hostname, allow);
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || DROP_REQUEST.has(name)) continue;
        if (HOP_BY_HOP.has(name) && name !== "upgrade" && name !== "connection") continue;
        headers[name] = value;
      }
      headers.host = target.host;
      headers.origin = target.origin;
      headers.connection = "Upgrade";
      headers.upgrade = "websocket";
      if (firstParty) {
        const cookieHeader = await cookies().cookieHeader(target, "strict");
        if (cookieHeader) headers.cookie = cookieHeader;
      }
      const client = target.protocol === "https:" ? https : http;
      const upstream = client.request(target, { method: "GET", headers, lookup, agent: false, timeout: UPSTREAM_TIMEOUT_MS });
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      upstream.on("response", (resp) => {
        socket.write(`HTTP/1.1 ${resp.statusCode} ${resp.statusMessage}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        resp.resume();
      });
      upstream.on("upgrade", (resp, upSocket, upHead) => {
        const setCookie = resp.headers["set-cookie"] ?? [];
        if (firstParty && setCookie.length > 0) void cookies().setFromResponse(target, setCookie, "strict");
        let response = `HTTP/1.1 ${resp.statusCode} ${resp.statusMessage}\r\n`;
        for (let i = 0; i < resp.rawHeaders.length; i += 2) {
          if (resp.rawHeaders[i].toLowerCase() === "set-cookie") continue;
          response += `${resp.rawHeaders[i]}: ${resp.rawHeaders[i + 1]}\r\n`;
        }
        socket.write(`${response}\r\n`);
        if (upHead.length) socket.write(upHead);
        if (head.length) upSocket.write(head);
        upSocket.pipe(socket);
        socket.pipe(upSocket);
        upSocket.on("error", () => socket.destroy());
        socket.on("error", () => upSocket.destroy());
        upSocket.on("close", () => socket.destroy());
        socket.on("close", () => upSocket.destroy());
      });
      upstream.end();
    })().catch(() => socket.destroy());
  }

  // Behind the app's normal Origin and sign-in checks: the only way a token
  // comes into existence.
  const api = Router();
  api.post("/open", (req: Request, res) => {
    const input = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    let target: URL;
    try {
      target = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
    } catch {
      res.status(400).json({ error: "Enter a web address, like example.com." });
      return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      res.status(400).json({ error: "Only http and https addresses can be previewed." });
      return;
    }
    const site = siteOf(target);
    const token = mintToken(site);
    res.json({ src: toDocumentPath(target, token), url: target.href, site });
  });
  api.post("/clear", async (req: Request, res) => {
    const site = typeof req.body?.site === "string" ? req.body.site : null;
    if (site) await cookies().clearSite(site);
    else await cookies().clearAll();
    res.status(204).end();
  });

  return { isWebProxyRequest, handleWebRequest, handleWebUpgrade, api };
}

export function isWebUpgradePath(url: string | undefined): boolean {
  return (url ?? "").startsWith(WEB_PREFIX);
}

export type WebProxy = ReturnType<typeof createWebProxy>;

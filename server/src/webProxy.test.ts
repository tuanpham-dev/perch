import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createCookieStore } from "./webProxyCookies.js";
import { parseAllowList } from "./webProxyGuard.js";
import { createWebProxy } from "./webProxy.js";
import { fromDocumentPath, toProxyPath } from "./webProxyUrls.js";

// A site on 127.0.0.1 (allowlisted for the test, since the guard blocks
// loopback) and the same server reached as "localhost", which the cookie
// rules count as a different site.
let site: http.Server;
let sitePort = 0;
let proxyServer: http.Server;
let proxyBase = "";
let dir = "";
let lastCookie: string | undefined;

function startProxy(allow: string[]) {
  const store = createCookieStore(path.join(dir, `cookies-${allow.length}.json`));
  const proxy = createWebProxy({ cookies: store, loadAllowList: async () => parseAllowList(allow) });
  const app = express();
  app.use((req, res, next) => {
    if (proxy.isWebProxyRequest(req)) {
      proxy.handleWebRequest(req, res).catch(next);
      return;
    }
    next();
  });
  app.use(express.json());
  app.use("/api/web-preview", proxy.api);
  const server = http.createServer(app);
  server.on("upgrade", (req, socket, head) => proxy.handleWebUpgrade(req, socket, head));
  return server;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function open(url: string, base = proxyBase): Promise<{ src: string; token: string }> {
  const res = await fetch(`${base}/api/web-preview/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const { src } = (await res.json()) as { src: string };
  return { src, token: fromDocumentPath(src)!.token };
}

function frameGet(url: string, extra: Record<string, string> = {}) {
  return fetch(url, { redirect: "manual", headers: { "sec-fetch-dest": "iframe", ...extra } });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "web-proxy-"));
  site = http.createServer((req, res) => {
    lastCookie = req.headers.cookie;
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" });
      res.end(`<html><head><title>Home</title></head><body><img src="/logo.png"><a href="/about">About</a></body></html>`);
    } else if (req.url === "/login") {
      res.writeHead(200, { "content-type": "text/html", "set-cookie": ["sid=s3cret; Path=/; HttpOnly; Max-Age=3600", "theme=dark; Path=/"] });
      res.end("<p>signed in</p>");
    } else if (req.url === "/headers") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ authorization: req.headers.authorization ?? null }));
    } else if (req.url === "/font.woff2") {
      res.writeHead(200, { "content-type": "font/woff2", "access-control-allow-origin": "*" });
      res.end("wOF2");
    } else if (req.url === "/private.woff2") {
      res.writeHead(200, { "content-type": "font/woff2" });
      res.end("wOF2");
    } else if (req.url === "/fonts.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end(`@font-face{font-family:A;src:url(/font.woff2)}@font-face{font-family:B;src:url(/private.woff2)}`);
    } else if (req.url === "/me") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
    } else if (req.url === "/go") {
      res.writeHead(302, { location: "/me" });
      res.end();
    } else {
      res.writeHead(404).end();
    }
  });
  const wss = new WebSocketServer({ server: site });
  wss.on("connection", (ws, req) => {
    ws.on("message", (data) => ws.send(`echo:${data}:${req.headers.cookie ?? ""}`));
  });
  sitePort = await listen(site);
  proxyServer = startProxy(["127.0.0.1"]);
  proxyBase = `http://127.0.0.1:${await listen(proxyServer)}`;
});

afterAll(() => {
  site.close();
  proxyServer.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("web proxy", () => {
  it("serves the page rewritten, with the framing headers gone", async () => {
    const { src } = await open(`http://127.0.0.1:${sitePort}/`);
    expect(src.startsWith("/?")).toBe(true);
    const res = await frameGet(`${proxyBase}${src}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBeNull();
    const html = await res.text();
    expect(html).toContain("window.__webPreview=");
    expect(html).toMatch(/src="\/web\/[^/]+\/http\/127\.0\.0\.1:\d+\/logo\.png"/);
  });

  it("keeps the site's cookies on the server and sends them back", async () => {
    const { token } = await open(`http://127.0.0.1:${sitePort}/login`);
    const login = await frameGet(`${proxyBase}/login?__wp=${encodeURIComponent(`${token}~http~127.0.0.1:${sitePort}`)}`);
    expect(login.headers.get("set-cookie")).toBeNull();
    await login.text();
    const me = await fetch(`${proxyBase}${toProxyPath(`http://127.0.0.1:${sitePort}/me`, token)}`);
    expect(((await me.json()) as { cookie: string }).cookie).toBe("sid=s3cret; theme=dark");
  });

  it("moves a frame that goes to another site onto that site's own token", async () => {
    const { token } = await open(`http://127.0.0.1:${sitePort}/`);
    const res = await frameGet(`${proxyBase}/me?__wp=${encodeURIComponent(`${token}~http~localhost:${sitePort}`)}`);
    expect(res.status).toBe(307);
    const next = fromDocumentPath(res.headers.get("location")!);
    expect(next?.token).not.toBe(token);
    expect(next?.target.href).toBe(`http://localhost:${sitePort}/me`);
  });

  it("sends no cookies when a page asks another site for something", async () => {
    const { token } = await open(`http://localhost:${sitePort}/`);
    await (await frameGet(`${proxyBase}/login?__wp=${encodeURIComponent(`${token}~http~localhost:${sitePort}`)}`)).text();
    const other = await open(`http://127.0.0.1:${sitePort}/`);
    const res = await fetch(`${proxyBase}${toProxyPath(`http://localhost:${sitePort}/me`, other.token)}`);
    expect(((await res.json()) as { cookie: string | null }).cookie).toBeNull();
  });

  it("follows a redirect inside the proxy", async () => {
    const { token } = await open(`http://127.0.0.1:${sitePort}/`);
    const res = await fetch(`${proxyBase}${toProxyPath(`http://127.0.0.1:${sitePort}/go`, token)}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(toProxyPath(`http://127.0.0.1:${sitePort}/me`, token));
  });

  it("sends a request that left the proxy back into it", async () => {
    const { src } = await open(`http://127.0.0.1:${sitePort}/`);
    const res = await fetch(`${proxyBase}/assets/app.js?v=2`, { redirect: "manual", headers: { referer: `${proxyBase}${src}` } });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toMatch(new RegExp(`^/web/[^/]+/http/127\\.0\\.0\\.1:${sitePort}/assets/app\\.js\\?v=2$`));
  });

  it("never passes the visitor's sign-in on to the site", async () => {
    const { token } = await open(`http://127.0.0.1:${sitePort}/`);
    const res = await fetch(`${proxyBase}${toProxyPath(`http://127.0.0.1:${sitePort}/headers`, token)}`, {
      headers: { authorization: "Basic dHVubmVsOnBhc3N3b3Jk" },
    });
    expect(((await res.json()) as { authorization: string | null }).authorization).toBeNull();
  });

  it("behind basic auth, points fonts that allow it at their own host", async () => {
    const { token } = await open(`http://127.0.0.1:${sitePort}/`);
    const cssUrl = `${proxyBase}${toProxyPath(`http://127.0.0.1:${sitePort}/fonts.css`, token)}`;
    const direct = await (await fetch(cssUrl, { headers: { authorization: "Basic dHVubmVsOnBhc3N3b3Jk" } })).text();
    expect(direct).toContain(`url(http://127.0.0.1:${sitePort}/font.woff2)`);
    expect(direct).toMatch(/url\(\/web\/[^/]+\/http\/127\.0\.0\.1:\d+\/private\.woff2\)/);
    const plain = await (await fetch(cssUrl)).text();
    expect(plain).not.toContain(`url(http://127.0.0.1`);
  });

  it("refuses an unknown token", async () => {
    const res = await fetch(`${proxyBase}${toProxyPath(`http://127.0.0.1:${sitePort}/`, "x".repeat(32))}`);
    expect(res.status).toBe(403);
  });

  it("blocks a private address that isn't allowlisted", async () => {
    const strict = startProxy([]);
    const base = `http://127.0.0.1:${await listen(strict)}`;
    try {
      const { src } = await open(`http://127.0.0.1:${sitePort}/`, base);
      const res = await frameGet(`${base}${src}`);
      expect(res.status).toBe(502);
      expect(await res.text()).toContain("Blocked 127.0.0.1");
    } finally {
      strict.close();
    }
  });

  it("refuses non-web addresses at open", async () => {
    const res = await fetch(`${proxyBase}/api/web-preview/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "file:///etc/passwd" }),
    });
    expect(res.status).toBe(400);
  });

  it("carries a WebSocket with the site's cookies", async () => {
    const { token } = await open(`http://127.0.0.1:${sitePort}/`);
    await (await frameGet(`${proxyBase}/login?__wp=${encodeURIComponent(`${token}~http~127.0.0.1:${sitePort}`)}`)).text();
    const wsUrl = `ws://127.0.0.1:${new URL(proxyBase).port}${toProxyPath(`ws://127.0.0.1:${sitePort}/live`, token)}`;
    const reply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: { origin: "null" } });
      ws.on("open", () => ws.send("hi"));
      ws.on("message", (data) => {
        resolve(String(data));
        ws.close();
      });
      ws.on("error", reject);
    });
    expect(reply).toBe("echo:hi:sid=s3cret; theme=dark");
  });

  it("stores document.cookie writes for the page's own site only", async () => {
    const { token } = await open(`http://127.0.0.1:${sitePort}/`);
    const write = (page: string) =>
      fetch(`${proxyBase}/web/${token}/__perch/cookie?u=${encodeURIComponent(page)}`, { method: "POST", body: "lang=en; path=/" });
    expect((await write(`http://localhost:${sitePort}/`)).status).toBe(403);
    expect((await write(`http://127.0.0.1:${sitePort}/`)).status).toBe(204);
    await fetch(`${proxyBase}${toProxyPath(`http://127.0.0.1:${sitePort}/me`, token)}`);
    expect(lastCookie).toContain("lang=en");
  });
});

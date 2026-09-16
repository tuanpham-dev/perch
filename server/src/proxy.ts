import http from "node:http";
import net from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

const PROXY_PATH_RE = /^\/(abs)?proxy\/(\d{1,5})(\/.*)?$/;

export interface ParsedProxyPath {
  // Whether the /absproxy/ form was used (path forwarded unmodified) vs.
  // /proxy/ (prefix stripped before forwarding).
  absolute: boolean;
  port: number;
  // /proxy mode: what's left after stripping "/proxy/<port>" (defaults to
  // "/"). /absproxy mode: the original pathname, unstripped.
  rest: string;
}

// Matches "/proxy/<port>(/…)?" and "/absproxy/<port>(/…)?". Returns null for
// anything else, including an out-of-range port (parseProxyPath is the sole
// gate deciding whether a path is proxy-routed at all, so a malformed port
// here just means "not a proxy path" rather than a 400).
export function parseProxyPath(pathname: string): ParsedProxyPath | null {
  const match = PROXY_PATH_RE.exec(pathname);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  const absolute = match[1] === "abs";
  if (absolute) {
    return { absolute, port, rest: pathname };
  }
  return { absolute, port, rest: match[3] || "/" };
}

// Same-origin Referer fallback for absolute-path assets (e.g. "/assets/x.js")
// requested by a page that was itself served through /proxy/<port>/ or
// /absproxy/<port>/ — see index.ts's post-static middleware for how this is
// used. Deliberately restricted to same Host as the current request: a
// Referer naming some other origin proves nothing about which local port
// this asset belongs to.
export function portFromReferer(
  referer: string | undefined,
  requestHost: string | undefined,
): number | null {
  if (!referer || !requestHost) return null;
  let refUrl: URL;
  try {
    refUrl = new URL(referer);
  } catch {
    return null;
  }
  if (refUrl.host.toLowerCase() !== requestHost.toLowerCase()) return null;
  const parsed = parseProxyPath(refUrl.pathname);
  return parsed ? parsed.port : null;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
  "transfer-encoding",
]);

function forwardedHeaders(req: IncomingMessage, port: number): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  const socket = req.socket;
  headers["x-forwarded-for"] = socket.remoteAddress ?? "";
  headers["x-forwarded-proto"] = "http";
  headers["x-forwarded-host"] = req.headers.host ?? "";
  // The upstream is a local dev server, which is asked for by its local
  // address, as the WebSocket path below already does. Passing the browser's
  // Host through makes dev servers that check it (Vite's allowedHosts,
  // webpack-dev-server's allowedHosts) refuse the request as an unknown host.
  // The original stays in X-Forwarded-Host for apps that want it.
  headers.host = `127.0.0.1:${port}`;
  return headers;
}

// Proxies a single HTTP request to 127.0.0.1:port, streaming both
// directions. `rest` is the path to request upstream (already
// stripped/kept per parseProxyPath). In stripped (/proxy) mode, a
// root-relative Location response header is rewritten to stay inside the
// proxy prefix — an absolute-URL Location (the app's own origin) is left
// alone and will escape the proxy, a documented limitation.
export function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  rest: string,
  prefix: string | null,
): void {
  const upstreamReq = http.request(
    {
      host: "127.0.0.1",
      port,
      method: req.method,
      path: rest || "/",
      headers: forwardedHeaders(req, port),
    },
    (upstreamRes) => {
      const headers = { ...upstreamRes.headers };
      if (prefix) {
        const location = headers.location;
        if (typeof location === "string" && location.startsWith("/")) {
          headers.location = prefix + location;
        }
      }
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      upstreamRes.pipe(res);
    },
  );
  upstreamReq.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: `nothing listening on port ${port}` }));
  });
  req.pipe(upstreamReq);
}

// Proxies a WebSocket upgrade to 127.0.0.1:port. `rest` is the path (and
// query string) to send in the rebuilt upgrade request line.
export function handleProxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  port: number,
  rest: string,
): void {
  const upstream = net.connect(port, "127.0.0.1", () => {
    const headerLines: string[] = [`${req.method} ${rest || "/"} HTTP/1.1`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || key.toLowerCase() === "host") continue;
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) headerLines.push(`${key}: ${v}`);
    }
    headerLines.push(`Host: 127.0.0.1:${port}`, "", "");
    upstream.write(headerLines.join("\r\n"));
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const cleanup = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", cleanup);
  socket.on("error", cleanup);
  upstream.on("close", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
}

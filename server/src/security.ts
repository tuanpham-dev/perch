import { timingSafeEqual } from "node:crypto";

// WebSockets ignore same-origin policy: any page open in a browser on this
// machine can open ws://127.0.0.1:3001/ws/attach and inject keystrokes into
// a terminal, regardless of the server's bind address. A handful of no-body POST
// endpoints (kill-session, etc.) are similarly reachable cross-origin as
// "simple requests". Gate both on Host (blocks DNS rebinding) and Origin
// (blocks browser-driven cross-origin requests) against an explicit
// allowlist — loopback by default, extended via ALLOWED_HOSTS for reverse
// proxies (nginx's documented config already forwards the real Host).
const DEFAULT_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function parseAllowedHosts(): Set<string> {
  const extra = (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_HOSTS, ...extra]);
}

const allowedHosts = parseAllowedHosts();

// PROXY_DOMAIN (code-server's --proxy-domain): comma-separated bare domains
// (e.g. "example.com,work.example.org"). A request whose Host is
// "<port>.<one of these>" is routed to that local port instead of being
// checked against allowedHosts/allowedOrigins directly — see
// portFromProxyHost below.
function parseProxyDomains(): string[] {
  return (process.env.PROXY_DOMAIN ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

const proxyDomains = parseProxyDomains();

// Strips a port suffix, respecting bracketed IPv6 literals (e.g.
// "[::1]:3001" -> "[::1]", "example.com:443" -> "example.com").
function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? hostHeader.toLowerCase() : hostHeader.slice(0, end + 1).toLowerCase();
  }
  const colon = hostHeader.lastIndexOf(":");
  return (colon === -1 ? hostHeader : hostHeader.slice(0, colon)).toLowerCase();
}

// Matches "<port>.<domain>" against every configured PROXY_DOMAIN, for any of
// the app's proxy domains. Returns the port to forward to, or null if
// hostname isn't a "<digits>.<configured-domain>" shape.
export function portFromProxyHost(hostHeader: string | undefined): number | null {
  if (!hostHeader || proxyDomains.length === 0) return null;
  const hostname = hostnameOf(hostHeader);
  for (const domain of proxyDomains) {
    if (!hostname.endsWith(`.${domain}`)) continue;
    const label = hostname.slice(0, hostname.length - domain.length - 1);
    if (!/^\d{1,5}$/.test(label)) continue;
    const port = Number(label);
    if (port >= 1 && port <= 65535) return port;
  }
  return null;
}

// First configured PROXY_DOMAIN, if any — what the client builds subdomain
// proxy URLs against.
export function primaryProxyDomain(): string | null {
  return proxyDomains[0] ?? null;
}

// The configured proxy domain that hostHeader equals or is a "<port>."
// subdomain of, for scoping the auth cookie so it's shared across every
// "<port>.<domain>" origin. Undefined leaves the cookie host-only (today's
// behavior), which is correct when PROXY_DOMAIN is unset.
export function cookieDomainFor(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  const hostname = hostnameOf(hostHeader);
  return proxyDomains.find((d) => hostname === d || hostname.endsWith(`.${d}`));
}

export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  return allowedHosts.has(hostnameOf(hostHeader)) || portFromProxyHost(hostHeader) !== null;
}

// No Origin header means the request didn't come from a browser context that
// enforces one (curl, the tunnel CLI, direct WS clients) — nothing for this
// check to protect against, so it passes. A browser always sends Origin on
// both fetch/XHR (cross-origin) and WebSocket upgrades.
export function isAllowedOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true;
  try {
    // URL.hostname keeps IPv6 literals bracketed (e.g. "[::1]"), matching
    // the form hostnameOf() produces from a Host header.
    const hostname = new URL(originHeader).hostname.toLowerCase();
    return allowedHosts.has(hostname) || portFromProxyHost(hostname) !== null;
  } catch {
    return false;
  }
}

// A sandboxed iframe (sandbox="allow-scripts", deliberately no
// allow-same-origin) sends Origin: null on every request, including its own
// subresource loads — isAllowedOrigin rejects that unconditionally, same as
// any other unrecognized origin. An extension that embeds previewed content
// this way (e.g. live-preview) needs its serving routes reachable from that
// opaque origin, but relaxing the Origin check for those routes generally
// would let ANY website's page do the same sandboxed-iframe trick against
// them.
//
// The fix is a narrow, reusable convention: a route mounted under its
// extension's own "/public/" prefix opts out of the Origin check (Host is
// still always checked) IF AND ONLY IF it enforces its own capability-based
// authorization — e.g. a random per-resource token that can only ever be
// minted by a request that itself passed the normal Origin check. That
// asymmetry (minting requires Origin; serving does not) is what keeps an
// attacker's page from reaching anything: it can reproduce the null-origin
// trick, but it can never have first obtained a valid token through it.
// Never use this for a route that trusts ambient browser state (cookies,
// session, Referer) instead of an explicit capability — Origin exemption
// bypasses exactly the protection those would need.
export function isOriginExemptPath(path: string): boolean {
  return /^\/api\/ext\/[^/]+\/public\//.test(path);
}

// --- Auth gate -------------------------------------------------------------
// Optional shared-secret gate, OpenClaw-style: unset AUTH_TOKEN and every
// function below is a no-op, preserving today's behavior exactly. Set it and
// opening the app with ?token=<secret> mints an HttpOnly cookie (see
// index.ts) that authorizes all subsequent /api and WebSocket traffic —
// necessary because several endpoints are consumed as raw URLs (img/iframe
// src, dynamic import()) that can't carry a custom header.

export const AUTH_COOKIE_NAME = "perch_token";

function authToken(): string | undefined {
  const token = process.env.AUTH_TOKEN;
  return token && token.length > 0 ? token : undefined;
}

export function isAuthGateEnabled(): boolean {
  return authToken() !== undefined;
}

// Constant-time compare against the configured secret. Deliberately does NOT
// short-circuit on length mismatch before hashing both to a fixed size, so
// wrong-length guesses don't leak timing info either.
export function isValidAuthToken(candidate: string | undefined): boolean {
  const expected = authToken();
  if (!expected || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Compare against itself so this branch takes comparable time to the
    // equal-length path, then report false.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      cookies[name] = part.slice(eq + 1).trim();
    }
  }
  return cookies;
}

// Accepts the token from, in order: the first-party cookie (normal browser
// traffic once minted), an x-auth-token header (the tunnel CLI / curl,
// which can't hold cookies across separate invocations), or a ?token= query
// param (the initial entry URL, and anywhere else a header isn't practical).
export function tokenFromRequest(
  cookieHeader: string | undefined,
  authTokenHeader: string | string[] | undefined,
  queryToken: string | undefined,
): string | undefined {
  const cookieToken = parseCookies(cookieHeader)[AUTH_COOKIE_NAME];
  if (cookieToken) return cookieToken;
  if (typeof authTokenHeader === "string" && authTokenHeader) return authTokenHeader;
  if (queryToken) return queryToken;
  return undefined;
}

// Routes that must stay reachable without the auth cookie even when the gate
// is on: the Origin-exempt /public/ routes (see its module comment), plus the
// report routes below, each called by a plain local process with no way to
// carry a cookie or token. Each handler enforces its own loopback-only check
// (isLoopbackAddress below) — this exemption alone would otherwise open it to
// anyone who can reach the port.
export function isAuthExemptPath(path: string): boolean {
  // /api/open-url is a local curl from the $BROWSER shim, with loopback and
  // custom-header checks in its handler; its
  // /events SSE sibling is deliberately NOT exempt — exact match only.
  // /api/open-target is the same pattern again, this time for the CLI's
  // `perch open` (plans/cli-open-command.md).
  // /api/command-events/report likewise (local curl from the
  // shell-integration snippet); the GET /api/command-events browser
  // endpoint stays gated, which is why report has its own subpath.
  // /api/agent-hooks/report is the same pattern once more, this time for the
  // agent-hook shim an AI agent's own hook runs (server/src/agentHooks.ts) —
  // a local process with no cookie and no token. Its handler enforces
  // loopback plus the custom header. Exact match: the sibling
  // /api/agent-hooks* routes the browser uses (install, uninstall, state)
  // stay gated, which is why report has its own subpath.
  return (
    isOriginExemptPath(path) ||
    path === "/api/open-url" ||
    path === "/api/open-target" ||
    path === "/api/command-events/report" ||
    path === "/api/agent-hooks/report"
  );
}

// Bell-hook endpoint gate: the hook always calls http://127.0.0.1:<port>,
// so a request whose remote address isn't loopback didn't come from it.
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

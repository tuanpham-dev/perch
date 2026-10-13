import { randomBytes } from "node:crypto";

// Capabilities for the web preview's /web/<token>/… routes. Those routes skip
// the Origin and sign-in checks (a sandboxed frame sends Origin: null and no
// cookies), so the token is the only thing that authorizes a request — and
// it can only be minted by POST /api/web-preview/open, which does pass both
// checks. The same asymmetry live-preview's /public/ routes rely on (see
// security.ts's isOriginExemptPath).
//
// A token is bound to one site (registrable domain). The proxy sends that
// site's cookies and no other's, so a page can't read another site's
// signed-in responses through the shared proxy; moving the frame to a
// different site mints a fresh token for it (webProxy.ts). That is the same
// line browsers draw when they block third-party cookies.

export interface WebToken {
  site: string;
  lastUsed: number;
  // Set on a token minted by a cross-site navigation: its first document
  // request goes out under that SameSite context, as the browser would send
  // it, and every request after that is the site's own.
  crossSiteEntry?: "lax" | "none";
}

const IDLE_MS = 12 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;

const tokens = new Map<string, WebToken>();
let lastSweep = Date.now();

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  for (const [token, entry] of tokens) {
    if (now - entry.lastUsed > IDLE_MS) tokens.delete(token);
  }
}

export function mintToken(site: string, opts?: { crossSiteEntry?: "lax" | "none" }): string {
  const token = randomBytes(24).toString("base64url");
  tokens.set(token, { site, lastUsed: Date.now(), crossSiteEntry: opts?.crossSiteEntry });
  return token;
}

// The token's entry, refreshing its idle clock; null once it has expired.
export function getToken(token: string): WebToken | null {
  const now = Date.now();
  sweep(now);
  const entry = tokens.get(token);
  if (!entry) return null;
  if (now - entry.lastUsed > IDLE_MS) {
    tokens.delete(token);
    return null;
  }
  entry.lastUsed = now;
  return entry;
}

// The cross-site context of a token's first document request, once.
export function consumeCrossSiteEntry(token: string): "lax" | "none" | undefined {
  const entry = tokens.get(token);
  const context = entry?.crossSiteEntry;
  if (entry) entry.crossSiteEntry = undefined;
  return context;
}

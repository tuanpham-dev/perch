import { getPublicSuffix } from "tough-cookie";

// The web preview's URL shapes: a site's address carried on this server, so
// every request a proxied page makes comes back here. Two forms:
//
// - Resource form, for everything a page loads:
//     https://cdn.example.net:8443/a.js?v=1  ->  /web/<token>/https/cdn.example.net:8443/a.js?v=1
//
// - Document form, for the page in the frame itself: the site's own path and
//   query, plus one parameter naming the site.
//     https://example.com/pricing?plan=pro  ->  /pricing?plan=pro&__wp=<token>~https~example.com
//   A sandboxed frame can't change its own path (history.pushState may only
//   touch the query and fragment of an opaque-origin document), so the path
//   it starts with is the one a single-page app's router reads. Keeping it
//   the site's real path is what lets those routers find the right page.
//
// A URL the page builds against this server's root ("/assets/x.js" from a
// document at "/pricing?__wp=…") arrives without either form; the injected
// <meta name=referrer content=unsafe-url> makes its Referer carry the
// document form, which names the site it belongs to (webProxy.ts recovers it).

export const WEB_PREFIX = "/web/";
export const WP_PARAM = "__wp";

const RESOURCE_PATH_RE = /^\/web\/([A-Za-z0-9_-]{16,64})\/(https?|wss?)\/([^/?#]+)([^#]*)$/;
const WP_VALUE_RE = /^([A-Za-z0-9_-]{16,64})~(https?|wss?)~(.+)$/;
const PROXYABLE = new Set(["http:", "https:", "ws:", "wss:"]);

export interface ProxiedAddress {
  token: string;
  target: URL;
}

export function toProxyPath(target: URL | string, token: string): string {
  const url = typeof target === "string" ? new URL(target) : target;
  return `${WEB_PREFIX}${token}/${url.protocol.slice(0, -1)}/${url.host}${url.pathname}${url.search}${url.hash}`;
}

// "<token>~https~example.com:8443": which site a document-form URL is on
// (percent-encoded as a whole when it goes into the query).
export function wpValue(target: URL, token: string): string {
  return `${token}~${target.protocol.slice(0, -1)}~${target.host}`;
}

export function toDocumentPath(target: URL | string, token: string): string {
  const url = typeof target === "string" ? new URL(target) : target;
  // Appended as a raw string so the site's own query keeps its exact bytes.
  const own = url.search.length > 1 ? stripWpParam(url.search.slice(1)) : "";
  const wp = `${WP_PARAM}=${encodeURIComponent(wpValue(url, token))}`;
  return `${url.pathname}?${own ? `${own}&` : ""}${wp}${url.hash}`;
}

function stripWpParam(query: string): string {
  return query
    .split("&")
    .filter((part) => part !== "" && part.split("=")[0] !== WP_PARAM)
    .join("&");
}

export function fromProxyPath(pathWithQuery: string): ProxiedAddress | null {
  const match = RESOURCE_PATH_RE.exec(pathWithQuery);
  if (!match) return null;
  const [, token, scheme, host, rest] = match;
  try {
    const target = new URL(`${scheme}://${host}${rest.startsWith("/") ? rest : `/${rest}`}`);
    return { token, target };
  } catch {
    return null;
  }
}

export function fromDocumentPath(pathWithQuery: string): ProxiedAddress | null {
  const q = pathWithQuery.indexOf("?");
  if (q === -1) return null;
  const pathname = pathWithQuery.slice(0, q);
  const query = pathWithQuery.slice(q + 1).split("#")[0];
  let wp: string | null = null;
  for (const part of query.split("&")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq) === WP_PARAM) {
      try {
        wp = decodeURIComponent(part.slice(eq + 1));
      } catch {
        return null;
      }
    }
  }
  const match = wp ? WP_VALUE_RE.exec(wp) : null;
  if (!match) return null;
  const [, token, scheme, host] = match;
  const own = stripWpParam(query);
  try {
    const target = new URL(`${scheme}://${host}${pathname || "/"}${own ? `?${own}` : ""}`);
    return { token, target };
  } catch {
    return null;
  }
}

// Either form.
export function fromAnyProxyPath(pathWithQuery: string): ProxiedAddress | null {
  return fromProxyPath(pathWithQuery) ?? fromDocumentPath(pathWithQuery);
}

// One URL found in a page (a src, a url() in CSS), resolved against the
// page's own address and turned into the resource form. Anything that isn't a
// network address the proxy carries — data:, blob:, javascript:, mailto:, a
// bare #fragment — is left exactly as written.
export function rewriteUrl(raw: string, base: URL, token: string): string {
  const value = raw.trim();
  if (!value || value.startsWith("#")) return raw;
  if (value.startsWith(`${WEB_PREFIX}${token}/`)) return raw;
  let resolved: URL;
  try {
    resolved = new URL(value, base);
  } catch {
    return raw;
  }
  if (!PROXYABLE.has(resolved.protocol)) return raw;
  return toProxyPath(resolved, token);
}

// The registrable domain ("example.co.uk" for "www.example.co.uk") — what
// browsers mean by "same site", and what a preview token's cookies are scoped
// to. An IP, localhost or a single-label intranet name is its own site.
export function siteOf(url: URL): string {
  return siteOfHostname(url.hostname);
}

export function siteOfHostname(name: string): string {
  const hostname = name.replace(/^\[(.*)\]$/, "$1").replace(/^\./, "").toLowerCase();
  try {
    return getPublicSuffix(hostname, { allowSpecialUseDomain: true }) ?? hostname;
  } catch {
    return hostname;
  }
}

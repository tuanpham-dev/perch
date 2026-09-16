// Browser-opener bridge (plans/browser-opener-bridge.md): a server-side
// "open URL" event names a URL as seen from the SERVER — loopback hosts
// there aren't reachable from the user's browser, so they're rewritten onto
// the app's existing port proxy (subdomain form when PROXY_DOMAIN is
// configured, else the app-origin "/proxy/<port>/" path — the same choice
// the ports panel's proxyUrl makes). Non-loopback URLs pass through
// untouched.

// Hosts that mean "this machine" to the server-side process that asked for
// the open. URL.hostname keeps IPv6 brackets, so "[::1]" matches as-is.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

export function rewriteLocalUrl(
  raw: string,
  appOrigin: string,
  proxyDomain: string | null,
  serverPort: number,
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!LOOPBACK_HOSTS.has(url.hostname)) return raw;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const rest = `${url.pathname}${url.search}${url.hash}`;
  // The app's own port: the URL is the app itself — just re-origin it (the
  // browser may be reaching the app through a tunnel/domain, not :port).
  if (port === serverPort) return `${appOrigin}${rest}`;
  if (proxyDomain) {
    const appProtocol = appOrigin.startsWith("https:") ? "https:" : "http:";
    return `${appProtocol}//${port}.${proxyDomain}${rest}`;
  }
  return `${appOrigin}/proxy/${port}${rest}`;
}

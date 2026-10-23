// The command that forwards every Perch port to localhost on another machine
// (cli/tunnel.mjs), shared by the ports panel's Copy button and the
// assistant extension's port_forward_command tool so both hand out the same
// bytes. See extensions/_shared's module comment on why this is a copy, not a
// shared runtime import.

export interface TunnelAuth {
  cookie: string | null;
  authorization: string | null;
}

export const MASK = "••••";

// Wraps a value in single quotes for a POSIX shell, escaping embedded single
// quotes with the standard '\'' idiom — cookie values can legally contain them.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function authHeaders(auth: TunnelAuth): { name: string; value: string }[] {
  const headers: { name: string; value: string }[] = [];
  if (auth.cookie) headers.push({ name: "Cookie", value: auth.cookie });
  if (auth.authorization) headers.push({ name: "Authorization", value: auth.authorization });
  return headers;
}

// Builds the copy-pasteable tunnel command. When `mask` is set, header values
// are replaced with a placeholder for on-screen display; `mask: false` is
// what actually gets copied to the clipboard. Always the --all auto-forward
// variant (see cli/tunnel.mjs): forwarding a fixed snapshot of ports went
// stale the moment a dev server restarted on a new port, so the panel no
// longer asks which ports you meant.
// This browser's own id for tunnel pairing: the copied command passes it to
// the CLI (--client), and the status asks only about tunnels carrying it, so
// a tunnel shows as forwarded in the browser that started it and nowhere
// else. The server can't tell machines apart any other way behind a reverse
// proxy, where every connection arrives from the proxy. Kept per browser
// (localStorage) so a copied command keeps matching across reloads; when
// storage is unavailable it lasts for this page only.
// getRandomValues rather than randomUUID, which needs a secure context and
// so fails on a plain-http LAN address.
const TUNNEL_CLIENT_KEY = "perch.ports.tunnelClient";
let tunnelClientId: string | null = null;

export function tunnelClient(): string {
  if (tunnelClientId) return tunnelClientId;
  try {
    const stored = localStorage.getItem(TUNNEL_CLIENT_KEY);
    if (stored && /^[A-Za-z0-9_-]{1,64}$/.test(stored)) return (tunnelClientId = stored);
  } catch {
    // storage blocked: fall through to a page-lifetime id
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  tunnelClientId = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  try {
    localStorage.setItem(TUNNEL_CLIENT_KEY, tunnelClientId);
  } catch {
    // keep the in-memory id
  }
  return tunnelClientId;
}

export function buildCommand(origin: string, auth: TunnelAuth, mask: boolean): string {
  const headers = authHeaders(auth).map((h) => ({ ...h, value: mask ? MASK : h.value }));
  const curlArgs = headers.map((h) => `-H ${shellQuote(`${h.name}: ${h.value}`)}`).join(" ");
  const nodeArgs = headers.map((h) => `--header ${shellQuote(`${h.name}: ${h.value}`)}`).join(" ");
  // The script streams from curl straight into node's stdin — no file ever
  // touches disk (no stray tunnel.mjs in the user's cwd), and no /tmp-style
  // path that breaks on Windows. --input-type=module because stdin scripts
  // default to CommonJS.
  const curl = `curl -s ${curlArgs ? `${curlArgs} ` : ""}${origin}/tunnel.mjs`;
  const node = `node --input-type=module - --url ${origin} ${nodeArgs ? `${nodeArgs} ` : ""}--client ${tunnelClient()} --all`;
  return `${curl} | ${node}`;
}

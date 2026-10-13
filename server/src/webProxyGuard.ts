import dns from "node:dns";
import net from "node:net";

// The web preview's server-side fetches (webProxy.ts) reach whatever address
// a page names. Unchecked, any page open in a preview — or anyone holding a
// preview token — could use this server to reach its own network: a router's
// admin page, a database, the cloud metadata endpoint. So every upstream
// connection resolves through guardedLookup below, which refuses private,
// loopback, link-local and other non-public ranges after DNS (a public name
// pointing at 127.0.0.1 is caught too). The check sits in the socket's own
// lookup, so the address that's checked is the address connected to — a
// redirect, a subresource and a WebSocket each go through it again.
//
// Local dev servers have their own path (/proxy/<port>, limited to ports a
// terminal owns); the user's webPreviewAllowedHosts setting opens specific
// hosts or ranges here, e.g. a staging box on the LAN.

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, including cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation ranges
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64, which embeds any IPv4 address
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(address, prefix, "ipv6");
}

// "::ffff:127.0.0.1" (and the hex form "::ffff:7f00:1") is IPv4 in an IPv6
// wrapper; checked as the IPv4 address it carries.
function unwrapMappedIpv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  if (!lower.startsWith("::ffff:")) return null;
  const rest = lower.slice("::ffff:".length);
  if (net.isIPv4(rest)) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isBlockedIp(ip: string): boolean {
  const v4 = unwrapMappedIpv4(ip);
  if (v4) return blocked.check(v4, "ipv4");
  if (net.isIPv4(ip)) return blocked.check(ip, "ipv4");
  if (net.isIPv6(ip)) return blocked.check(ip, "ipv6");
  // Not an IP at all: nothing to connect to, so nothing to allow.
  return true;
}

export interface AllowList {
  hosts: Set<string>;
  // "*.example.lan" entries, stored as ".example.lan".
  suffixes: string[];
  ranges: net.BlockList;
}

// One entry per line in the setting: a hostname ("staging.lan"), a wildcard
// ("*.corp.example"), an IP ("192.168.1.20") or a CIDR ("10.1.0.0/16").
// Anything else is ignored rather than failing the whole list.
export function parseAllowList(entries: readonly unknown[]): AllowList {
  const allow: AllowList = { hosts: new Set(), suffixes: [], ranges: new net.BlockList() };
  for (const raw of entries) {
    if (typeof raw !== "string") continue;
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const cidr = /^(.+)\/(\d{1,3})$/.exec(entry);
    if (cidr) {
      const family = net.isIPv4(cidr[1]) ? "ipv4" : net.isIPv6(cidr[1]) ? "ipv6" : null;
      const prefix = Number(cidr[2]);
      if (family && prefix <= (family === "ipv4" ? 32 : 128)) allow.ranges.addSubnet(cidr[1], prefix, family);
      continue;
    }
    const bare = entry.replace(/^\[(.*)\]$/, "$1");
    if (net.isIPv4(bare)) allow.ranges.addAddress(bare, "ipv4");
    else if (net.isIPv6(bare)) allow.ranges.addAddress(bare, "ipv6");
    else if (entry.startsWith("*.")) allow.suffixes.push(entry.slice(1));
    else allow.hosts.add(entry);
  }
  return allow;
}

function hostAllowed(hostname: string, allow: AllowList): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allow.hosts.has(host) || allow.suffixes.some((s) => host.endsWith(s));
}

function ipAllowed(ip: string, allow: AllowList): boolean {
  const v4 = unwrapMappedIpv4(ip);
  if (v4) return allow.ranges.check(v4, "ipv4");
  if (net.isIPv4(ip)) return allow.ranges.check(ip, "ipv4");
  return net.isIPv6(ip) && allow.ranges.check(ip, "ipv6");
}

export class BlockedAddressError extends Error {
  code = "EBLOCKED";
  constructor(
    readonly hostname: string,
    readonly address: string,
  ) {
    super(`${hostname} resolves to ${address}, a private or local address`);
  }
}

// Whether a connection to `hostname` at `address` may go ahead.
export function isConnectionAllowed(hostname: string, address: string, allow: AllowList): boolean {
  return !isBlockedIp(address) || hostAllowed(hostname, allow) || ipAllowed(address, allow);
}

// Node never calls `lookup` for a literal IP ("http://127.0.0.1/",
// "http://[::1]/"), so those are checked here, before connecting.
export function assertLiteralAllowed(hostname: string, allow: AllowList): void {
  const bare = hostname.replace(/^\[(.*)\]$/, "$1");
  if (net.isIP(bare) && !isConnectionAllowed(bare, bare, allow)) throw new BlockedAddressError(hostname, bare);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

// A drop-in for net/http's `lookup` option. Resolves every address, keeps
// only the allowed ones, and fails with BlockedAddressError when none is left,
// so a name with one public and one private record still can't be steered to
// the private one.
export function guardedLookup(getAllow: () => AllowList) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    const allow = getAllow();
    const bare = hostname.replace(/^\[(.*)\]$/, "$1");
    // A literal IP never goes to DNS.
    if (net.isIP(bare)) {
      if (!isConnectionAllowed(bare, bare, allow)) {
        callback(new BlockedAddressError(hostname, bare), "", 0);
        return;
      }
      const family = net.isIPv4(bare) ? 4 : 6;
      if (options.all) callback(null, [{ address: bare, family }]);
      else callback(null, bare, family);
      return;
    }
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, "", 0);
        return;
      }
      const list = addresses as dns.LookupAddress[];
      const ok = list.filter((a) => isConnectionAllowed(hostname, a.address, allow));
      if (ok.length === 0) {
        callback(new BlockedAddressError(hostname, list[0]?.address ?? "unknown"), "", 0);
        return;
      }
      if (options.all) callback(null, ok);
      else callback(null, ok[0].address, ok[0].family);
    });
  };
}

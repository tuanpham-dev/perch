import { describe, expect, it } from "vitest";
import { BlockedAddressError, guardedLookup, isBlockedIp, isConnectionAllowed, parseAllowList } from "./webProxyGuard.js";

describe("isBlockedIp", () => {
  it.each([
    "10.0.0.1",
    "192.168.1.1",
    "172.16.5.4",
    "127.0.0.1",
    "127.8.8.8",
    "0.0.0.0",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["93.184.215.14", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it("treats a non-IP as blocked", () => {
    expect(isBlockedIp("example.com")).toBe(true);
  });
});

describe("allow list", () => {
  const allow = parseAllowList(["staging.lan", "*.corp.example", "10.1.0.0/16", "192.168.1.20", "nonsense/99", 42]);

  it("opens an exact host", () => {
    expect(isConnectionAllowed("staging.lan", "192.168.9.9", allow)).toBe(true);
    expect(isConnectionAllowed("other.lan", "192.168.9.9", allow)).toBe(false);
  });

  it("opens a wildcard host", () => {
    expect(isConnectionAllowed("api.corp.example", "10.9.9.9", allow)).toBe(true);
    expect(isConnectionAllowed("corp.example", "10.9.9.9", allow)).toBe(false);
  });

  it("opens a CIDR and a single address", () => {
    expect(isConnectionAllowed("x", "10.1.2.3", allow)).toBe(true);
    expect(isConnectionAllowed("x", "10.2.0.1", allow)).toBe(false);
    expect(isConnectionAllowed("x", "192.168.1.20", allow)).toBe(true);
    expect(isConnectionAllowed("x", "::ffff:192.168.1.20", allow)).toBe(true);
  });

  it("always allows public addresses", () => {
    expect(isConnectionAllowed("example.com", "93.184.215.14", parseAllowList([]))).toBe(true);
  });
});

describe("guardedLookup", () => {
  const lookup = guardedLookup(() => parseAllowList(["127.0.0.2"]));

  function run(host: string): Promise<{ err: NodeJS.ErrnoException | null; address: unknown }> {
    return new Promise((resolve) => {
      lookup(host, {}, (err, address) => resolve({ err, address }));
    });
  }

  it("refuses a literal private IP", async () => {
    const { err } = await run("127.0.0.1");
    expect(err).toBeInstanceOf(BlockedAddressError);
    expect((err as BlockedAddressError).address).toBe("127.0.0.1");
  });

  it("passes an allowlisted literal IP", async () => {
    const { err, address } = await run("127.0.0.2");
    expect(err).toBeNull();
    expect(address).toBe("127.0.0.2");
  });

  it("refuses a name that resolves to loopback", async () => {
    const { err } = await run("localhost");
    expect(err).toBeInstanceOf(BlockedAddressError);
  });
});

describe("assertLiteralAllowed", () => {
  it("throws for a blocked literal and passes an allowed one", async () => {
    const { assertLiteralAllowed } = await import("./webProxyGuard.js");
    expect(() => assertLiteralAllowed("127.0.0.1", parseAllowList([]))).toThrow(BlockedAddressError);
    expect(() => assertLiteralAllowed("[::1]", parseAllowList([]))).toThrow(BlockedAddressError);
    expect(() => assertLiteralAllowed("127.0.0.1", parseAllowList(["127.0.0.1"]))).not.toThrow();
    expect(() => assertLiteralAllowed("example.com", parseAllowList([]))).not.toThrow();
  });
});

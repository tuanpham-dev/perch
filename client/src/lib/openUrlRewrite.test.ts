import { describe, expect, it } from "vitest";
import { rewriteLocalUrl } from "./openUrlRewrite";

const ORIGIN = "http://app.example:3001";

describe("rewriteLocalUrl", () => {
  it("returns null for unparseable or non-http(s) input", () => {
    expect(rewriteLocalUrl("not a url", ORIGIN, null, 3001)).toBeNull();
    expect(rewriteLocalUrl("file:///etc/passwd", ORIGIN, null, 3001)).toBeNull();
    expect(rewriteLocalUrl("mailto:a@b.c", ORIGIN, null, 3001)).toBeNull();
  });

  it("passes non-loopback URLs through untouched", () => {
    const url = "https://admin.shopify.com/store/x/themes?y=1";
    expect(rewriteLocalUrl(url, ORIGIN, null, 3001)).toBe(url);
    expect(rewriteLocalUrl(url, ORIGIN, "proxy.example", 3001)).toBe(url);
  });

  it("re-origins the app's own port onto the app origin", () => {
    expect(rewriteLocalUrl("http://127.0.0.1:3001/settings?tab=a#f", ORIGIN, null, 3001)).toBe(
      "http://app.example:3001/settings?tab=a#f",
    );
    expect(rewriteLocalUrl("http://localhost:3001/", ORIGIN, "proxy.example", 3001)).toBe(
      "http://app.example:3001/",
    );
  });

  it("rewrites other loopback ports to the app-origin path proxy", () => {
    expect(rewriteLocalUrl("http://127.0.0.1:9292/preview?x=1", ORIGIN, null, 3001)).toBe(
      "http://app.example:3001/proxy/9292/preview?x=1",
    );
    expect(rewriteLocalUrl("http://localhost:9292", ORIGIN, null, 3001)).toBe(
      "http://app.example:3001/proxy/9292/",
    );
    expect(rewriteLocalUrl("http://0.0.0.0:8080/a/b#c", ORIGIN, null, 3001)).toBe(
      "http://app.example:3001/proxy/8080/a/b#c",
    );
    expect(rewriteLocalUrl("http://[::1]:5173/", ORIGIN, null, 3001)).toBe(
      "http://app.example:3001/proxy/5173/",
    );
  });

  it("prefers the subdomain proxy when a domain is configured", () => {
    expect(rewriteLocalUrl("http://127.0.0.1:9292/preview?x=1", ORIGIN, "proxy.example", 3001)).toBe(
      "http://9292.proxy.example/preview?x=1",
    );
    expect(
      rewriteLocalUrl("http://127.0.0.1:9292/", "https://app.example", "proxy.example", 3001),
    ).toBe("https://9292.proxy.example/");
  });

  it("defaults portless loopback URLs to 80/443 by scheme", () => {
    expect(rewriteLocalUrl("http://localhost/x", ORIGIN, null, 3001)).toBe(
      "http://app.example:3001/proxy/80/x",
    );
    expect(rewriteLocalUrl("https://localhost/x", ORIGIN, null, 3001)).toBe(
      "http://app.example:3001/proxy/443/x",
    );
  });
});

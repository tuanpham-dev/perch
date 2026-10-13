import { describe, expect, it } from "vitest";
import { fromAnyProxyPath, fromDocumentPath, fromProxyPath, rewriteUrl, siteOf, toDocumentPath, toProxyPath } from "./webProxyUrls.js";

const TOKEN = "abcdefghijklmnopqrstuvwx";

describe("proxy paths", () => {
  it.each([
    "https://example.com/",
    "https://example.com:8443/a/b?q=1&r=%20x",
    "http://[2001:db8::1]:8080/path",
    "wss://socket.example.com/live?room=1",
    "https://example.com/caf%C3%A9/menu",
  ])("round-trips %s", (address) => {
    const path = toProxyPath(address, TOKEN);
    expect(path.startsWith(`/web/${TOKEN}/`)).toBe(true);
    const parsed = fromProxyPath(path);
    expect(parsed?.token).toBe(TOKEN);
    expect(parsed?.target.href).toBe(new URL(address).href);
  });

  it("defaults an empty path to /", () => {
    expect(fromProxyPath(`/web/${TOKEN}/https/example.com`)?.target.href).toBe("https://example.com/");
  });

  it("rejects other shapes", () => {
    expect(fromProxyPath("/web/short/https/example.com/")).toBeNull();
    expect(fromProxyPath(`/web/${TOKEN}/ftp/example.com/`)).toBeNull();
    expect(fromProxyPath("/api/sessions")).toBeNull();
  });
});

describe("document paths", () => {
  it.each([
    "https://example.com/",
    "https://example.com/pricing?plan=pro&x=%20y",
    "http://[2001:db8::1]:8080/a/b",
    "https://example.com:8443/search?q=a+b",
  ])("round-trips %s keeping the site's own path", (address) => {
    const path = toDocumentPath(address, TOKEN);
    expect(path.startsWith(new URL(address).pathname)).toBe(true);
    const parsed = fromDocumentPath(path);
    expect(parsed?.token).toBe(TOKEN);
    expect(parsed?.target.href).toBe(new URL(address).href);
  });

  it("replaces a stale __wp rather than stacking it", () => {
    const once = toDocumentPath("https://example.com/a?x=1", TOKEN);
    const again = toDocumentPath(`https://example.com${once}`, "zyxwvutsrqponmlkjihgfedc");
    expect(again.match(/__wp=/g)).toHaveLength(1);
    expect(fromDocumentPath(again)?.token).toBe("zyxwvutsrqponmlkjihgfedc");
    expect(fromDocumentPath(again)?.target.href).toBe("https://example.com/a?x=1");
  });

  it("ignores a plain path", () => {
    expect(fromDocumentPath("/pricing?plan=pro")).toBeNull();
    expect(fromAnyProxyPath("/pricing")).toBeNull();
  });
});

describe("rewriteUrl", () => {
  const base = new URL("https://example.com/docs/page.html");

  it("rewrites relative, root-relative, protocol-relative and absolute URLs", () => {
    expect(rewriteUrl("img.png", base, TOKEN)).toBe(`/web/${TOKEN}/https/example.com/docs/img.png`);
    expect(rewriteUrl("/assets/a.js", base, TOKEN)).toBe(`/web/${TOKEN}/https/example.com/assets/a.js`);
    expect(rewriteUrl("//cdn.example.net/x.css", base, TOKEN)).toBe(`/web/${TOKEN}/https/cdn.example.net/x.css`);
    expect(rewriteUrl("http://other.org/?a=1#top", base, TOKEN)).toBe(`/web/${TOKEN}/http/other.org/?a=1#top`);
  });

  it("leaves non-network URLs alone", () => {
    for (const raw of ["", "#top", "data:image/png;base64,AAAA", "blob:https://x/1", "javascript:void(0)", "mailto:a@b.c"]) {
      expect(rewriteUrl(raw, base, TOKEN)).toBe(raw);
    }
  });

  it("doesn't rewrite twice", () => {
    const once = rewriteUrl("/a", base, TOKEN);
    expect(rewriteUrl(once, base, TOKEN)).toBe(once);
  });
});

describe("siteOf", () => {
  it("groups a registrable domain", () => {
    expect(siteOf(new URL("https://www.example.co.uk/"))).toBe("example.co.uk");
    expect(siteOf(new URL("https://a.b.example.com/"))).toBe("example.com");
    expect(siteOf(new URL("https://me.github.io/"))).toBe("me.github.io");
  });

  it("keeps an IP or a single-label name as its own site", () => {
    expect(siteOf(new URL("http://192.168.1.5:8080/"))).toBe("192.168.1.5");
    expect(siteOf(new URL("http://intranet/"))).toBe("intranet");
    expect(siteOf(new URL("http://[::1]/"))).toBe("::1");
  });
});

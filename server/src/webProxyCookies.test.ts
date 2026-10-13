import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCookieStore } from "./webProxyCookies.js";

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "web-cookies-"));
  dirs.push(dir);
  return path.join(dir, "cookies.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const page = new URL("https://www.example.com/account");

describe("web preview cookie store", () => {
  it("sends back what a response set", async () => {
    const store = createCookieStore(tempFile());
    await store.setFromResponse(page, ["sid=abc; Path=/; HttpOnly", "theme=dark; Path=/"], "strict");
    expect(await store.cookieHeader(new URL("https://www.example.com/other"), "strict")).toBe("sid=abc; theme=dark");
    expect(await store.cookieHeader(new URL("https://elsewhere.org/"), "strict")).toBe("");
  });

  it("hides HttpOnly cookies from the page and refuses to let it set one", async () => {
    const store = createCookieStore(tempFile());
    await store.setFromResponse(page, ["sid=abc; Path=/; HttpOnly", "theme=dark; Path=/"], "strict");
    await store.setFromScript(page, "sid=stolen; HttpOnly");
    await store.setFromScript(page, "lang=en; path=/");
    expect(await store.documentCookie(page)).toBe("theme=dark; lang=en");
    expect(await store.cookieHeader(page, "strict")).toContain("sid=abc");
  });

  it("keeps persistent cookies across a restart and drops session cookies", async () => {
    const file = tempFile();
    const first = createCookieStore(file);
    await first.setFromResponse(page, ["keep=1; Max-Age=3600; Path=/", "session=1; Path=/"], "strict");
    await first.flush();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain("session");
    const second = createCookieStore(file);
    expect(await second.cookieHeader(page, "strict")).toBe("keep=1");
  });

  it("applies SameSite rules to cross-site requests", async () => {
    const store = createCookieStore(tempFile());
    await store.setFromResponse(
      page,
      ["strict=1; Path=/; SameSite=Strict", "lax=1; Path=/; SameSite=Lax", "plain=1; Path=/", "none=1; Path=/; SameSite=None; Secure"],
      "strict",
    );
    expect(await store.cookieHeader(page, "lax")).toBe("lax=1; plain=1; none=1");
    expect(await store.cookieHeader(page, "none")).toBe("none=1");
  });

  it("clears one site or everything", async () => {
    const file = tempFile();
    const store = createCookieStore(file);
    await store.setFromResponse(page, ["a=1; Max-Age=3600; Path=/; Domain=example.com"], "strict");
    const other = new URL("https://other.org/");
    await store.setFromResponse(other, ["b=1; Max-Age=3600; Path=/"], "strict");
    await store.clearSite("example.com");
    expect(await store.cookieHeader(page, "strict")).toBe("");
    expect(await store.cookieHeader(other, "strict")).toBe("b=1");
    await store.clearAll();
    await store.flush();
    expect(await createCookieStore(file).cookieHeader(other, "strict")).toBe("");
  });

  it("gives a WebSocket the cookies of its https address", async () => {
    const store = createCookieStore(tempFile());
    await store.setFromResponse(page, ["sid=abc; Path=/; Secure"], "strict");
    expect(await store.cookieHeader(new URL("wss://www.example.com/live"), "strict")).toBe("sid=abc");
  });
});

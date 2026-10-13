import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Cookie, CookieJar } from "tough-cookie";
import { configDir } from "./configDir.js";
import { siteOfHostname } from "./webProxyUrls.js";

// The web preview's cookies. A sandboxed preview frame has no cookie store of
// its own (its origin is opaque), so the server keeps one per user, like a
// browser profile: Set-Cookie from a proxied response lands here, and the
// next request to that site carries it. tough-cookie does the RFC 6265 work
// (domain/path matching, expiry, the public suffix list, SameSite).
//
// Persisted so a login survives a server restart, the way a browser keeps
// you signed in: cookies with an expiry are written to
// <configDir>/web-preview-cookies.json, mode 0600 (they are other sites'
// session tokens). Cookies with no expiry are session cookies and end with
// the server process, as they would with a browser.

export type SameSiteContext = "strict" | "lax" | "none";

export interface CookieStore {
  // The Cookie header for a request the proxy is about to send.
  cookieHeader(url: URL, context: SameSiteContext): Promise<string>;
  // What the page's own document.cookie should read: no HttpOnly cookies.
  documentCookie(url: URL): Promise<string>;
  setFromResponse(url: URL, setCookie: readonly string[], context: SameSiteContext): Promise<void>;
  // A document.cookie write from the page; can't create or overwrite an
  // HttpOnly cookie.
  setFromScript(url: URL, cookie: string): Promise<void>;
  clearSite(site: string): Promise<void>;
  clearAll(): Promise<void>;
  // Writes any pending change now (tests, shutdown).
  flush(): Promise<void>;
}

const SAVE_DELAY_MS = 500;

// Cookies are scoped to http(s) URLs; a WebSocket upgrade carries the
// cookies of its http(s) equivalent.
function cookieUrl(url: URL): string {
  if (url.protocol === "ws:" || url.protocol === "wss:") {
    const copy = new URL(url.href);
    copy.protocol = url.protocol === "wss:" ? "https:" : "http:";
    return copy.href;
  }
  return url.href;
}

export function createCookieStore(filePath: string): CookieStore {
  const jar = new CookieJar(undefined, { allowSpecialUseDomain: true });
  let loaded: Promise<void> | null = null;
  let saveTimer: NodeJS.Timeout | null = null;
  let saving: Promise<void> = Promise.resolve();

  function load(): Promise<void> {
    loaded ??= (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(filePath, "utf8"));
      } catch {
        return;
      }
      const list = (parsed as { cookies?: unknown })?.cookies;
      if (!Array.isArray(list)) return;
      const now = new Date();
      for (const raw of list) {
        const cookie = Cookie.fromJSON(raw);
        if (!cookie || !cookie.isPersistent()) continue;
        const expiry = cookie.expiryDate(now);
        if (expiry && expiry <= now) continue;
        await jar.store.putCookie(cookie);
      }
    })();
    return loaded;
  }

  async function save(): Promise<void> {
    const cookies = (await jar.store.getAllCookies()).filter((c) => c.isPersistent());
    const json = JSON.stringify({ version: 1, cookies: cookies.map((c) => c.toJSON()) });
    await mkdir(path.dirname(filePath), { recursive: true });
    // Temp-then-rename, 0600 on the temp file — the settingsStore pattern.
    const tmp = `${filePath}.${process.pid}.tmp`;
    await writeFile(tmp, json, { mode: 0o600 });
    await rename(tmp, filePath);
  }

  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saving = saving.then(save).catch((err) => console.error("web preview: saving cookies failed:", err));
    }, SAVE_DELAY_MS);
    saveTimer.unref();
  }

  return {
    async cookieHeader(url, context) {
      await load();
      const cookies = await jar.getCookies(cookieUrl(url), { http: true, sameSiteContext: context });
      // tough-cookie treats a cookie with no SameSite attribute as None.
      // Browsers treat it as Lax, which withholds it from a cross-site POST.
      const sent = context === "none" ? cookies.filter((c) => c.sameSite === "none") : cookies;
      return sent.map((c) => c.cookieString()).join("; ");
    },

    async documentCookie(url) {
      await load();
      return jar.getCookieString(cookieUrl(url), { http: false });
    },

    async setFromResponse(url, setCookie, context) {
      if (setCookie.length === 0) return;
      await load();
      for (const header of setCookie) {
        await jar.setCookie(header, cookieUrl(url), { http: true, sameSiteContext: context, ignoreError: true });
      }
      scheduleSave();
    },

    async setFromScript(url, cookie) {
      await load();
      await jar.setCookie(cookie, cookieUrl(url), { http: false, ignoreError: true });
      scheduleSave();
    },

    async clearSite(site) {
      await load();
      for (const c of await jar.store.getAllCookies()) {
        if (c.domain && siteOfHostname(c.domain) === site) {
          await jar.store.removeCookie(c.domain, c.path, c.key);
        }
      }
      scheduleSave();
    },

    async clearAll() {
      await load();
      await jar.removeAllCookies();
      scheduleSave();
    },

    async flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        saving = saving.then(save);
      }
      await saving;
    },
  };
}

let defaultStore: CookieStore | null = null;

export function webPreviewCookies(): CookieStore {
  defaultStore ??= createCookieStore(path.join(configDir, "web-preview-cookies.json"));
  return defaultStore;
}

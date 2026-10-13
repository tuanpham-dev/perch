import { readFileSync } from "node:fs";
import { init as initModuleLexer, parse as parseModule } from "es-module-lexer";
import { RewritingStream } from "parse5-html-rewriting-stream";
import { rewriteUrl, toProxyPath } from "./webProxyUrls.js";

// Rewrites what a proxied site sends so the page keeps loading through the
// proxy (see webProxyUrls.ts for the URL shape). Server-side passes cover
// what's written in the markup, stylesheets and module imports; the injected
// runtime (webProxyRuntime.js) covers what scripts build while the page runs.

const RUNTIME_SOURCE = readFileSync(new URL("./webProxyRuntime.js", import.meta.url), "utf8");

// What the injected runtime reads as window.__webPreview.
export interface RuntimeConfig {
  token: string;
  // The real address of this document, after redirects.
  target: string;
  // A <base href> the page declared, resolved; relative URLs resolve
  // against it instead of `target`.
  base: string | null;
  // document.cookie at load: the site's non-HttpOnly cookies.
  cookie: string;
}

// ---- CSS ----

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(['"])([^'"]+)\1/gi;

export function rewriteCss(css: string, base: URL, token: string): string {
  return css
    .replace(CSS_URL_RE, (whole, quote: string, value: string) => {
      const next = rewriteUrl(value, base, token);
      return next === value ? whole : `url(${quote}${next}${quote})`;
    })
    .replace(CSS_IMPORT_RE, (whole, quote: string, value: string) => {
      const next = rewriteUrl(value, base, token);
      return next === value ? whole : `@import ${quote}${next}${quote}`;
    });
}

// ---- JavaScript module specifiers ----

// Static imports can't be patched at runtime, and a root-relative or
// absolute specifier would otherwise leave the proxy ("/assets/x.js"
// resolves against this server's root). Relative ones already resolve inside
// it. Dynamic import() with a literal string is rewritten the same way; one
// built at runtime isn't reachable.
let lexerReady: Promise<void> | null = null;

function needsRewrite(spec: string): boolean {
  return spec.startsWith("/") || /^https?:\/\//i.test(spec);
}

function ensureLexer(): Promise<void> {
  lexerReady ??= initModuleLexer;
  return lexerReady;
}

export async function rewriteJsModuleSpecifiers(js: string, base: URL, token: string): Promise<string> {
  await ensureLexer();
  return rewriteModuleSync(js, base, token);
}

// The lexer must be initialized (ensureLexer) first.
function rewriteModuleSync(js: string, base: URL, token: string): string {
  let imports;
  try {
    [imports] = parseModule(js);
  } catch {
    // Not something the lexer understands (or a classic script with syntax
    // it rejects): leave it exactly as sent.
    return js;
  }
  let out = "";
  let last = 0;
  for (const imp of imports) {
    if (imp.n === undefined || !needsRewrite(imp.n)) continue;
    const next = rewriteUrl(imp.n, base, token);
    if (next === imp.n) continue;
    // A dynamic import's range includes the quotes; a static one's doesn't.
    const replacement = imp.d > -1 ? JSON.stringify(next) : next;
    out += js.slice(last, imp.s) + replacement;
    last = imp.e;
  }
  return last === 0 ? js : out + js.slice(last);
}

// ---- HTML ----

// Attributes that load something when the document is parsed. <a>/<area>
// href is deliberately not here: a site's own router reads those, and the
// runtime routes the click instead (see webProxyRuntime.js).
const URL_ATTRS: Record<string, readonly string[]> = {
  "*": ["src", "poster", "background"],
  link: ["href"],
  form: ["action"],
  button: ["formaction"],
  input: ["formaction", "src"],
  object: ["data"],
  use: ["href", "xlink:href"],
  image: ["href", "xlink:href"],
  script: ["src", "href", "xlink:href"],
  feimage: ["href", "xlink:href"],
};

function rewriteSrcset(value: string, base: URL, token: string): string {
  return value
    .split(",")
    .map((candidate) => {
      const trimmed = candidate.trim();
      if (!trimmed) return candidate;
      const space = trimmed.search(/\s/);
      const url = space === -1 ? trimmed : trimmed.slice(0, space);
      const descriptor = space === -1 ? "" : trimmed.slice(space);
      return rewriteUrl(url, base, token) + descriptor;
    })
    .join(", ");
}

function rewriteRefresh(value: string, base: URL, token: string): string {
  return value.replace(/(url\s*=\s*)(['"]?)([^'"]+)\2/i, (_whole, prefix: string, quote: string, url: string) => {
    return `${prefix}${quote}${rewriteUrl(url, base, token)}${quote}`;
  });
}

function rewriteImportMap(json: string, base: URL, token: string): string {
  try {
    const map = JSON.parse(json) as { imports?: Record<string, string>; scopes?: Record<string, Record<string, string>> };
    const rewriteEntries = (entries: Record<string, string> | undefined) => {
      if (!entries) return;
      for (const key of Object.keys(entries)) {
        if (typeof entries[key] === "string") entries[key] = rewriteUrl(entries[key], base, token);
      }
    };
    rewriteEntries(map.imports);
    if (map.scopes) {
      const scopes: Record<string, Record<string, string>> = {};
      for (const [scope, entries] of Object.entries(map.scopes)) {
        rewriteEntries(entries);
        scopes[rewriteUrl(scope, base, token)] = entries;
      }
      map.scopes = scopes;
    }
    return JSON.stringify(map);
  } catch {
    return json;
  }
}

// A <base href> the page declares changes what every relative URL in it
// means, so it is read before anything else is rewritten.
function declaredBase(html: string, target: URL): URL | null {
  const match = /<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html);
  const href = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!href) return null;
  try {
    return new URL(href.trim(), target);
  } catch {
    return null;
  }
}

function scriptJson(value: unknown): string {
  // A JSON string literal is valid JS, but "</script" inside it would close
  // the tag; the escaped form reads back as "<". U+2028/U+2029 are line
  // terminators in older JS engines.
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function runtimeTag(config: RuntimeConfig): string {
  // unsafe-url: a request the page makes against this server's root
  // ("/assets/x.js") then carries the document's full address as its
  // Referer, which names the site it belongs to (see webProxyUrls.ts).
  return (
    `<meta name="referrer" content="unsafe-url">` +
    `<script>window.__webPreview=${scriptJson(config)};</script>` +
    `<script>${RUNTIME_SOURCE}</script>`
  );
}

export async function rewriteHtml(
  html: string,
  opts: { target: URL; token: string; cookie: string },
): Promise<string> {
  const { target, token } = opts;
  await ensureLexer();
  const pageBase = declaredBase(html, target);
  const base = pageBase ?? target;
  const config: RuntimeConfig = {
    token,
    target: target.href,
    base: pageBase ? pageBase.href : null,
    cookie: opts.cookie,
  };
  const injection = runtimeTag(config);

  const rewriter = new RewritingStream();
  let out = "";
  let injected = false;
  let rawTextOf: string | null = null; // the <style>/<script> we're inside
  let scriptKind = "";

  const inject = () => {
    if (injected) return;
    injected = true;
    rewriter.emitRaw(injection);
  };

  rewriter.on("data", (chunk: string) => {
    out += chunk;
  });

  rewriter.on("startTag", (tag) => {
    const name = tag.tagName.toLowerCase();
    // As early as possible: before any of the page's own scripts run.
    if (!injected && name !== "html" && name !== "head") inject();

    if (name === "meta") {
      const equiv = tag.attrs.find((a) => a.name === "http-equiv")?.value.toLowerCase();
      // A meta CSP would block the injected runtime and the proxy paths;
      // the response header is removed for the same reason (webProxy.ts).
      if (equiv === "content-security-policy") return;
      // The page's own referrer policy would hide the document address the
      // proxy needs from the requests it makes.
      if (tag.attrs.find((a) => a.name === "name")?.value.toLowerCase() === "referrer") return;
      if (equiv === "refresh") {
        for (const attr of tag.attrs) if (attr.name === "content") attr.value = rewriteRefresh(attr.value, base, token);
      }
    }

    if (name === "base") {
      // Same site: the site's own path, which the document form keeps.
      // Another origin: through the proxy, like any other URL.
      for (const attr of tag.attrs) {
        if (attr.name !== "href" || !pageBase) continue;
        attr.value =
          pageBase.origin === target.origin
            ? `${pageBase.pathname}${pageBase.search}${pageBase.hash}`
            : toProxyPath(pageBase, token);
      }
    }

    const urlAttrs = new Set([...(URL_ATTRS["*"] ?? []), ...(URL_ATTRS[name] ?? [])]);
    tag.attrs = tag.attrs.filter((a) => a.name !== "integrity");
    for (const attr of tag.attrs) {
      if (urlAttrs.has(attr.name)) attr.value = rewriteUrl(attr.value, base, token);
      else if (attr.name === "srcset" || attr.name === "imagesrcset") attr.value = rewriteSrcset(attr.value, base, token);
      else if (attr.name === "style") attr.value = rewriteCss(attr.value, base, token);
    }

    if (name === "style" || name === "script") {
      rawTextOf = name;
      scriptKind = (tag.attrs.find((a) => a.name === "type")?.value ?? "").toLowerCase();
    }
    rewriter.emitStartTag(tag);
    if (name === "head") inject();
  });

  rewriter.on("endTag", (tag, raw) => {
    if (tag.tagName.toLowerCase() === rawTextOf) rawTextOf = null;
    rewriter.emitRaw(raw);
  });

  rewriter.on("text", (_text, raw) => {
    if (rawTextOf === "style") rewriter.emitRaw(rewriteCss(raw, base, token));
    else if (rawTextOf === "script" && scriptKind === "importmap") rewriter.emitRaw(rewriteImportMap(raw, base, token));
    else if (rawTextOf === "script" && scriptKind === "module") rewriter.emitRaw(rewriteModuleSync(raw, base, token));
    else rewriter.emitRaw(raw);
  });

  await new Promise<void>((resolve, reject) => {
    rewriter.on("end", resolve);
    rewriter.on("error", reject);
    rewriter.end(html);
  });
  // A document with no tags at all still gets the runtime.
  return injected ? out : injection + out;
}

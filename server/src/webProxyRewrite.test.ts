import { describe, expect, it } from "vitest";
import { rewriteCss, rewriteHtml, rewriteJsModuleSpecifiers } from "./webProxyRewrite.js";

const TOKEN = "abcdefghijklmnopqrstuvwx";
const P = `/web/${TOKEN}`;
const target = new URL("https://example.com/docs/page");

describe("rewriteHtml", () => {
  async function run(html: string) {
    return rewriteHtml(html, { target, token: TOKEN, cookie: "a=1" });
  }

  it("injects the runtime once, first in <head>", async () => {
    const out = await run("<!doctype html><html><head><title>t</title><script src='/app.js'></script></head><body></body></html>");
    expect(out.match(/window\.__webPreview=/g)).toHaveLength(1);
    expect(out.indexOf("__webPreview=")).toBeLessThan(out.indexOf("<title>"));
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain('<meta name="referrer" content="unsafe-url">');
  });

  it("injects into a document without a head", async () => {
    const out = await run("<p>hello</p>");
    expect(out.indexOf("__webPreview=")).toBeLessThan(out.indexOf("<p>"));
    expect(await run("just text")).toContain("__webPreview=");
  });

  it("routes what the page loads through the proxy", async () => {
    const out = await run(
      `<img src="img.png" srcset="/a.png 1x, https://cdn.example.net/b.png 2x">` +
        `<link rel="stylesheet" href="/s.css" integrity="sha384-x">` +
        `<form action="/login"></form><video poster="//cdn.example.net/p.jpg"></video>` +
        `<div style="background:url('/bg.png')"></div>`,
    );
    expect(out).toContain(`src="${P}/https/example.com/docs/img.png"`);
    expect(out).toContain(`srcset="${P}/https/example.com/a.png 1x, ${P}/https/cdn.example.net/b.png 2x"`);
    expect(out).toContain(`href="${P}/https/example.com/s.css"`);
    expect(out).not.toContain("integrity");
    expect(out).toContain(`action="${P}/https/example.com/login"`);
    expect(out).toContain(`poster="${P}/https/cdn.example.net/p.jpg"`);
    expect(out).toContain(`url('${P}/https/example.com/bg.png')`);
  });

  it("leaves links for the site's router and the runtime", async () => {
    const out = await run(`<a href="/about">About</a><a href="#top">Top</a>`);
    expect(out).toContain(`<a href="/about">`);
    expect(out).toContain(`<a href="#top">`);
  });

  it("drops a CSP meta and the page's referrer policy", async () => {
    const out = await run(
      `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"><meta name="referrer" content="no-referrer"></head>`,
    );
    expect(out).not.toContain("Content-Security-Policy");
    expect(out).not.toContain("no-referrer");
  });

  it("rewrites <style>, inline module imports and import maps", async () => {
    const out = await run(
      `<style>@import "/theme.css"; body{background:url(/x.png)}</style>` +
        `<script type="module">import a from "/m.js"; import b from "./rel.js";</script>` +
        `<script type="importmap">{"imports":{"lib":"/lib/index.js"}}</script>` +
        `<script>var s = "/not-touched.js";</script>`,
    );
    expect(out).toContain(`@import "${P}/https/example.com/theme.css"`);
    expect(out).toContain(`url(${P}/https/example.com/x.png)`);
    expect(out).toContain(`import a from "${P}/https/example.com/m.js"`);
    expect(out).toContain(`import b from "./rel.js"`);
    expect(out).toContain(`"lib":"${P}/https/example.com/lib/index.js"`);
    expect(out).toContain(`var s = "/not-touched.js"`);
  });

  it("resolves against a declared <base>", async () => {
    const out = await run(`<head><base href="https://static.example.org/v2/"></head><img src="a.png">`);
    expect(out).toContain(`src="${P}/https/static.example.org/v2/a.png"`);
    expect(out).toContain(`<base href="${P}/https/static.example.org/v2/">`);
  });

  it("keeps the config out of reach of a closing tag", async () => {
    const out = await rewriteHtml("<p>x</p>", { target, token: TOKEN, cookie: "x=</script><b>" });
    expect(out).not.toContain("x=</script>");
  });
});

describe("rewriteCss", () => {
  it("rewrites url() and @import, leaves data: alone", () => {
    const base = new URL("https://example.com/css/site.css");
    const out = rewriteCss(`@import url("base.css"); a{background:url(data:image/png;base64,AA)} b{background:url( '../i.png' )}`, base, TOKEN);
    expect(out).toContain(`url("${P}/https/example.com/css/base.css")`);
    expect(out).toContain("url(data:image/png;base64,AA)");
    expect(out).toContain(`url('${P}/https/example.com/i.png')`);
  });
});

describe("rewriteJsModuleSpecifiers", () => {
  it("rewrites root-relative and absolute specifiers only", async () => {
    const base = new URL("https://example.com/assets/main.js");
    const out = await rewriteJsModuleSpecifiers(
      `import x from "/a.js"; export * from "https://cdn.example.net/b.js"; import("./c.js"); import("/d.js");`,
      base,
      TOKEN,
    );
    expect(out).toContain(`from "${P}/https/example.com/a.js"`);
    expect(out).toContain(`from "${P}/https/cdn.example.net/b.js"`);
    expect(out).toContain(`import("./c.js")`);
    expect(out).toContain(`import("${P}/https/example.com/d.js")`);
  });

  it("returns unparseable input unchanged", async () => {
    const base = new URL("https://example.com/");
    expect(await rewriteJsModuleSpecifiers("this is { not js", base, TOKEN)).toBe("this is { not js");
  });
});

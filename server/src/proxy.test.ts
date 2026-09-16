import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import { handleProxyRequest } from "./proxy.js";

// A dev server running in a terminal, reached through the app on a public
// hostname: Vite checks Host against its allowedHosts, and the proxy has to
// ask for it by its local address for the page to load at all.
describe("proxying a dev server that checks Host", () => {
  let dir = "";
  let vite: ViteDevServer;
  let proxy: http.Server;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "proxy-vite-"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>proxied</title><p>hello from vite</p>");
    vite = await createServer({ root: dir, configFile: false, logLevel: "silent", server: { port: 0, host: "127.0.0.1" } });
    await vite.listen();
    const vitePort = (vite.httpServer!.address() as AddressInfo).port;
    proxy = http.createServer((req, res) => {
      handleProxyRequest(req, res, vitePort, req.url ?? "/", null);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await vite?.close();
    proxy?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function get(host: string): Promise<{ status: number; body: string }> {
    const { port } = proxy.address() as AddressInfo;
    return new Promise((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/", headers: { host } }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on("error", reject);
    });
  }

  it("loads the page for a hostname Vite has never heard of", async () => {
    const page = await get("5173.perch.example.com");
    expect(page.status).toBe(200);
    expect(page.body).toContain("hello from vite");
  });
});

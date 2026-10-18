// The drafts store behind ctx.drafts: what a client can rely on is that a
// draft round-trips by (extension, key), that keys can be any string without
// reaching the filesystem as a path, and that a draft far bigger than the
// app-wide JSON limit still saves. Driven through a real HTTP server, since
// the router's own body parser is the point of the last one.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { createDraftStore, createDraftsRouter } from "./drafts.js";

const root = await mkdtemp(path.join(tmpdir(), "perch-drafts-test-"));
const store = createDraftStore(root);
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use("/api/drafts", createDraftsRouter(store));
  // Mirrors index.ts: the app-wide parser comes after, and must not matter.
  app.use(express.json());
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/drafts`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

const get = (ext: string, key: string) => fetch(`${base}/${ext}?key=${encodeURIComponent(key)}`);
const put = (ext: string, key: string, value: unknown) =>
  fetch(`${base}/${ext}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
const del = (ext: string, key: string) => fetch(`${base}/${ext}?key=${encodeURIComponent(key)}`, { method: "DELETE" });

describe("drafts routes", () => {
  it("returns null for a key with no draft", async () => {
    const res = await get("text-editor", "/nope.ts");
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it("round-trips a draft, then deletes it", async () => {
    expect((await put("text-editor", "/home/u/a.ts", { text: "edited", base: "h1" })).status).toBe(204);
    const body = await (await get("text-editor", "/home/u/a.ts")).json();
    expect(body.value).toEqual({ text: "edited", base: "h1" });
    expect(typeof body.savedAt).toBe("number");

    expect((await del("text-editor", "/home/u/a.ts")).status).toBe(204);
    expect(await (await get("text-editor", "/home/u/a.ts")).json()).toBeNull();
  });

  it("keeps each extension's drafts apart", async () => {
    await put("text-editor", "/same", "editor");
    await put("csv-preview", "/same", "grid");
    expect((await (await get("text-editor", "/same")).json()).value).toBe("editor");
    expect((await (await get("csv-preview", "/same")).json()).value).toBe("grid");
  });

  it("never turns a key into a path", async () => {
    await put("text-editor", "../../../etc/passwd", "x");
    const files = await readdir(path.join(root, "text-editor"));
    expect(files.every((f) => /^[0-9a-f]{40}\.json$/.test(f))).toBe(true);
    expect((await (await get("text-editor", "../../../etc/passwd")).json()).value).toBe("x");
  });

  it("rejects an extension id that isn't a plain name, and a missing key", async () => {
    expect((await get(".hidden", "/a")).status).toBe(400);
    expect((await get("a%2Fb", "/a")).status).toBe(400);
    expect((await fetch(`${base}/text-editor`)).status).toBe(400);
    const noValue = await fetch(`${base}/text-editor`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "/a" }),
    });
    expect(noValue.status).toBe(400);
  });

  it("accepts a draft well past the app-wide 100kb JSON limit", async () => {
    const text = "x".repeat(3 * 1024 * 1024);
    expect((await put("text-editor", "/big.txt", { text })).status).toBe(204);
    expect((await (await get("text-editor", "/big.txt")).json()).value.text.length).toBe(text.length);
  });

  it("clearExtension drops every draft of that extension only", async () => {
    await put("prompts", "/p1", 1);
    await put("csv-preview", "/keep", 2);
    await store.clearExtension("prompts");
    expect(await (await get("prompts", "/p1")).json()).toBeNull();
    expect((await (await get("csv-preview", "/keep")).json()).value).toBe(2);
  });
});

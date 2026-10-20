// ctx.storage's HTTP half: records round-trip, a validator refuses a browser
// write with its own message, a stale revision is a 409 carrying what is
// stored, a body past the limit is a 413, and a server-side write reaches the
// change stream (a big value without its body). Driven through a real HTTP
// server, mounted ahead of the app-wide parser as index.ts mounts it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { createExtensionStorageService } from "./extensionStorage.js";
import { createExtensionStorageRouter } from "./extensionStorageRoutes.js";

const root = await mkdtemp(path.join(tmpdir(), "perch-storage-routes-"));
const service = createExtensionStorageService({ dataRoot: path.join(root, "data"), stateRoot: path.join(root, "x"), log: () => {} });
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use("/api/storage", createExtensionStorageRouter(service, { installedIds: async () => ["notes"] }));
  app.use(express.json());
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/storage`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  service.closeAll();
  await rm(root, { recursive: true, force: true });
});

const put = (url: string, body: unknown) =>
  fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("records over HTTP", () => {
  it("round-trips, lists and deletes", async () => {
    expect(await (await put(`${base}/notes/notes`, { key: "a", value: { body: "hi" } })).json()).toEqual({ rev: 1 });
    expect(await (await fetch(`${base}/notes/notes?key=a`)).json()).toEqual({ value: { body: "hi" }, rev: 1 });
    expect(await (await fetch(`${base}/notes/notes?key=missing`)).json()).toBeNull();
    await put(`${base}/notes/notes`, { key: "b", value: 2 });
    expect((await (await fetch(`${base}/notes/notes?prefix=b`)).json()).map((r: { key: string }) => r.key)).toEqual(["b"]);
    expect((await fetch(`${base}/notes/notes?key=b`, { method: "DELETE" })).status).toBe(204);
    expect(await (await fetch(`${base}/notes/notes?key=b`)).json()).toBeNull();
  });

  it("refuses a write the extension's validator refuses, storing nothing", async () => {
    service
      .forExtension("notes")
      .collection("checked")
      .validate((_k, v) => (String((v as { body?: string }).body ?? "").length > 5 ? "Notes are limited to 5 characters" : undefined));
    const res = await put(`${base}/notes/checked`, { key: "k", value: { body: "far too long" } });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "Notes are limited to 5 characters" });
    expect(await (await fetch(`${base}/notes/checked?key=k`)).json()).toBeNull();
  });

  it("answers a stale revision with 409 and the stored record", async () => {
    await put(`${base}/notes/conflict`, { key: "k", value: "one" });
    await put(`${base}/notes/conflict`, { key: "k", value: "two", ifRev: 1 });
    const res = await put(`${base}/notes/conflict`, { key: "k", value: "three", ifRev: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).current).toEqual({ value: "two", rev: 2 });
  });

  it("refuses a body past the limit with 413", async () => {
    const res = await put(`${base}/notes/big`, { key: "k", value: "x".repeat(17.5 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  it("refuses bad ids and names with 400", async () => {
    expect((await fetch(`${base}/..%2Fx/c?key=a`)).status).toBe(400);
    expect((await fetch(`${base}/notes/bad%20name?key=a`)).status).toBe(400);
  });

  it("lists stored data, and deletes it", async () => {
    await service.forExtension("removed").collection("c").put("k", 1);
    const list = (await (await fetch(base)).json()) as { id: string; installed: boolean }[];
    expect(list.map((d) => [d.id, d.installed])).toEqual([
      ["notes", true],
      ["removed", false],
    ]);
    expect((await fetch(`${base}/removed`, { method: "DELETE" })).status).toBe(204);
    expect(((await (await fetch(base)).json()) as { id: string }[]).map((d) => d.id)).toEqual(["notes"]);
  });
});

describe("change stream", () => {
  it("carries server-side writes, leaving big values out", async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/events`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (re: RegExp) => {
      while (!re.test(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    await until(/connected/);
    const storage = service.forExtension("notes");
    await storage.collection("live").put("small", { n: 1 });
    await storage.collection("live").put("large", "z".repeat(300 * 1024));
    storage.notify("changed");
    await until(/"topic":"changed"/);
    ac.abort();
    const events = text
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => JSON.parse(f.slice(6)));
    expect(events[0]).toEqual({ ext: "notes", type: "change", collection: "live", changes: [{ key: "small", rev: 1, value: { n: 1 } }] });
    expect(events[1].changes).toEqual([{ key: "large", rev: 1, large: true }]);
    expect(events[2]).toEqual({ ext: "notes", type: "topic", topic: "changed" });
  });
});

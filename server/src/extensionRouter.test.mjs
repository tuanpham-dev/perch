// The router handed to an extension's activate(), against a real Express app.
//
// What is pinned down is the crash this exists to prevent: an async route
// handler that rejects must become a 500 for that one request, and the server
// must go on answering the next one. Before createExtensionRouter the
// rejection escaped Express 4 entirely: in the server Node exited the process,
// and under the test runner the request simply never gets an answer - which is
// why every request here carries a timeout, so a regression fails as an
// aborted fetch instead of a hung run (checked by swapping in a plain
// express.Router()).
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Nothing below reads a profile, but pin HOME and XDG_CONFIG_HOME anyway
// so a future import that does can never reach a real one.
const home = await mkdtemp(path.join(tmpdir(), "ext-router-test-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");

const express = (await import("express")).default;
const { createExtensionRouter, runExtensionRouter } = await import("./extensionRouter.ts");

// A regression leaves the request unanswered; fail fast instead of hanging.
const fetch = (url, init = {}) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(3000) });

let server;
let base;
const logged = [];
const originalError = console.error;

before(async () => {
  const router = createExtensionRouter();
  router.get("/boom", async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw new Error("boom after an await");
  });
  router.post("/reject-undefined", () => Promise.reject(undefined));
  router.get("/ok", async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    res.json({ ok: true });
  });
  router.route("/chained").get(async () => {
    throw new Error("from a route()");
  });
  router.get("/sync-throw", () => {
    throw new Error("thrown synchronously");
  });
  // An extension's own error middleware (arity 4) still gets its errors -
  // the wrapper must not turn it into a normal handler.
  const own = createExtensionRouter();
  own.get("/fail", async () => {
    throw new Error("handled by the extension");
  });
  own.use((err, _req, res, _next) => {
    res.status(418).json({ mine: err.message });
  });
  router.use("/own", own);
  router.get("/late", async (_req, res) => {
    res.json({ partial: true });
    throw new Error("after the response was sent");
  });

  const app = express();
  app.use(express.json());
  app.use("/api/ext/:extId", (req, res, next) => runExtensionRouter("test.ext", router, req, res, next));
  app.use((_req, res) => res.status(404).json({ error: "fell through" }));
  console.error = (...args) => logged.push(args.map(String).join(" "));
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/api/ext/test.ext`;
});

after(async () => {
  console.error = originalError;
  await new Promise((resolve) => server.close(resolve));
});

test("an async handler that rejects answers 500, and the next request still succeeds", async () => {
  const failed = await fetch(`${base}/boom`);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "boom after an await" });
  const ok = await fetch(`${base}/ok`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.ok(logged.some((line) => line.includes("[ext:test.ext]") && line.includes("boom after an await")));
});

test("a rejection with no reason is still a failure, not a fall-through", async () => {
  const res = await fetch(`${base}/reject-undefined`, { method: "POST" });
  assert.equal(res.status, 500);
});

test("handlers registered through router.route() are covered too", async () => {
  const res = await fetch(`${base}/chained`);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "from a route()" });
});

test("a synchronous throw gets the same JSON 500", async () => {
  const res = await fetch(`${base}/sync-throw`);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "thrown synchronously" });
});

test("an extension's own error middleware still handles its own errors", async () => {
  const res = await fetch(`${base}/own/fail`);
  assert.equal(res.status, 418);
  assert.deepEqual(await res.json(), { mine: "handled by the extension" });
});

test("a rejection after the response was sent keeps the response and the server", async () => {
  const res = await fetch(`${base}/late`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { partial: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const ok = await fetch(`${base}/ok`);
  assert.equal(ok.status, 200);
});

test("an unmatched path falls through to the app", async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "fell through" });
});

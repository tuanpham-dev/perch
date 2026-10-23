import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseTarget, PAGE_TTL_MS, pickWindow, resolveRef, sessionPorts, statusFromEvent } from "./lib.mjs";

const HOME = "/home/me";
const win = (id, index, name = "zsh") => ({ id, index, name, command: name, cwd: "~" });
const SESSIONS = [
  { name: "perch", path: "~/Works/perch", windows: [win("w1", 0), win("w2", 1, "claude")] },
  { name: "api", path: "~/Works/api", windows: [win("w3", 0)] },
  { name: "api-ui", path: "~/Works/api/ui", windows: [win("w4", 0)] },
  { name: "Notes", path: "~/notes", windows: [win("w5", 0)] },
  { name: "notes", path: "~/other/notes", windows: [win("w6", 0)] },
];

test("a window id names one window", () => {
  const r = resolveRef("w2", SESSIONS, HOME);
  assert.equal(r.session.name, "perch");
  assert.deepEqual(r.windows.map((w) => w.id), ["w2"]);
});

test("session:index names one window, and a missing index says which exist", () => {
  assert.equal(resolveRef("perch:1", SESSIONS, HOME).windows[0].id, "w2");
  assert.match(resolveRef("perch:7", SESSIONS, HOME).error, /has no window 7; it has 0, 1/);
});

test("an exact session name wins over a case-insensitive one", () => {
  assert.equal(resolveRef("notes", SESSIONS, HOME).session.path, "~/other/notes");
  assert.equal(resolveRef("Notes", SESSIONS, HOME).session.path, "~/notes");
});

test("a case-insensitive name matching two sessions is ambiguous", () => {
  assert.match(resolveRef("NOTES", SESSIONS, HOME).error, /more than one project/);
});

test("a session's folder name finds it", () => {
  const sessions = [{ name: "my app", path: "~/code/shop", windows: [win("x", 0)] }];
  assert.equal(resolveRef("Shop", sessions, HOME).session.name, "my app");
});

test("a path picks the deepest session directory containing it", () => {
  assert.equal(resolveRef("/home/me/Works/api/ui/src/App.tsx", SESSIONS, HOME).session.name, "api-ui");
  assert.equal(resolveRef("~/Works/api/server", SESSIONS, HOME).session.name, "api");
  assert.equal(resolveRef("/home/me/Works/apiary", SESSIONS, HOME).error?.startsWith("No project"), true);
});

test("an unknown reference lists the open projects", () => {
  assert.match(resolveRef("nope", SESSIONS, HOME).error, /Open projects: perch, api/);
  assert.match(resolveRef("", SESSIONS, HOME).error, /No project/);
});

test("pickWindow prefers the one agent window, else the only window", () => {
  const perch = resolveRef("perch", SESSIONS, HOME);
  assert.equal(pickWindow(perch, new Set(["w2"])).window.id, "w2");
  assert.match(pickWindow(perch, new Set()).error, /several windows: perch:0/);
  assert.match(pickWindow(perch, new Set(["w1", "w2"])).error, /several agent windows/);
  assert.equal(pickWindow(resolveRef("api", SESSIONS, HOME), new Set()).window.id, "w3");
});

const page = (over) => ({ lastSeen: 1000, focusedAt: 0, visible: true, session: null, windowIndex: null, ...over });

test("chooseTarget: no live page is an error", () => {
  assert.match(chooseTarget(new Map(), 1000, null).error, /No Perch browser/);
  const stale = new Map([["a", page({ lastSeen: 0 })]]);
  assert.match(chooseTarget(stale, PAGE_TTL_MS + 1, null).error, /No Perch browser/);
});

test("chooseTarget: the page focused last wins", () => {
  const pages = new Map([["a", page({ focusedAt: 10 })], ["b", page({ focusedAt: 20 })]]);
  assert.equal(chooseTarget(pages, 1000, null).target, "b");
});

test("chooseTarget: a page showing the caller's terminal beats a later focus", () => {
  const pages = new Map([
    ["a", page({ focusedAt: 10, session: "perch", windowIndex: 1 })],
    ["b", page({ focusedAt: 20, session: "api", windowIndex: 0 })],
  ]);
  assert.equal(chooseTarget(pages, 1000, { session: "perch", index: 1 }).target, "a");
  // ...but only while visible
  pages.get("a").visible = false;
  assert.equal(chooseTarget(pages, 1000, { session: "perch", index: 1 }).target, "b");
});

test("chooseTarget: without any focus report, every page", () => {
  const pages = new Map([["a", page()], ["b", page()]]);
  assert.equal(chooseTarget(pages, 1000, null).target, "*");
});

test("statusFromEvent maps hook events", () => {
  assert.equal(statusFromEvent("prompt-submit"), "working");
  assert.equal(statusFromEvent("permission"), "needs-input");
  assert.equal(statusFromEvent("stop"), "idle");
  assert.equal(statusFromEvent(undefined), "unknown");
});

test("sessionPorts: the project's own live ports, sorted and unique", () => {
  const ports = [
    { port: 5173, session: "perch" },
    { port: 3000, session: "perch" },
    { port: 3000, session: "perch", address: "::" },
    { port: 8080, session: "perch", orphan: true },
    { port: 9000, session: "api" },
  ];
  assert.deepEqual(sessionPorts(ports, "perch"), [3000, 5173]);
});

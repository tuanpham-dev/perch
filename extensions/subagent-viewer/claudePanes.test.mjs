// Two Claude windows in one directory must resolve to their own sessions -
// the bug this lookup replaced gave both the newest transcript in the cwd.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionsByWindow, windowIdFromEnviron } from "./claudePanes.mjs";

const alive = new Set([100, 200, 300]);
const isAlive = (pid) => alive.has(pid);
const rec = (pid, sessionId, updatedAt = 1) => ({ pid, sessionId, cwd: "/repo", updatedAt });

test("two sessions in the same directory stay on their own windows", () => {
  const windows = new Map([[100, "w-a"], [200, "w-b"]]);
  const map = sessionsByWindow([rec(100, "a"), rec(200, "b")], isAlive, windows);
  assert.equal(map.get("w-a").sessionId, "a");
  assert.equal(map.get("w-b").sessionId, "b");
});

test("a record left behind by an exited CLI is ignored", () => {
  const windows = new Map([[999, "w"], [100, "w"]]);
  const map = sessionsByWindow([rec(999, "dead"), rec(100, "live")], isAlive, windows);
  assert.equal(map.get("w").sessionId, "live");
});

test("the most recently updated live record wins for a window", () => {
  const windows = new Map([[100, "w"], [300, "w"]]);
  const map = sessionsByWindow([rec(100, "old", 5), rec(300, "new", 9)], isAlive, windows);
  assert.equal(map.get("w").sessionId, "new");
});

test("records without a window or session id are skipped", () => {
  const windows = new Map([[200, "w"]]);
  const map = sessionsByWindow([rec(100, "x"), { pid: 200 }, null], isAlive, windows);
  assert.equal(map.size, 0);
});

test("the tmux backend's pane stands in for an empty PERCH_WINDOW", () => {
  assert.equal(windowIdFromEnviron(["PERCH_WINDOW=w-a", "TMUX_PANE=%3"]), "w-a");
  assert.equal(windowIdFromEnviron(["PERCH_WINDOW=", "TMUX_PANE=%3"]), "tmux-3");
  assert.equal(windowIdFromEnviron(["HOME=/root"]), null);
});

test("without a readable environment, a record's tmux field names its window", () => {
  const map = sessionsByWindow([{ ...rec(100, "a"), tmux: "perch-view:@0.%7" }], isAlive, new Map());
  assert.equal(map.get("tmux-7").sessionId, "a");
});

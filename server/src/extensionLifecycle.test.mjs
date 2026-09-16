// A server entry's deactivate() runs when its hook unmounts.
//
// Before this, disabling an extension dropped its routes but left everything
// its activate() started - a unix socket, a timer - running in the resident
// module, so a "disabled" extension kept answering on its socket.
// extensions.ts records each entry's module after activate() returns
// (recordServerDeactivate) and runs it from unmountServerHook
// (runServerDeactivate); these cases pin down that pair.
import assert from "node:assert/strict";
import { test } from "node:test";

const { recordServerDeactivate, runServerDeactivate } = await import("./extensionLifecycle.ts");

// Lets a fire-and-forget async deactivate settle before asserting.
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("runs the recorded deactivate once, then forgets it", () => {
  let count = 0;
  recordServerDeactivate("t.once", { deactivate: () => count++ });
  runServerDeactivate("t.once");
  runServerDeactivate("t.once");
  assert.equal(count, 1);
});

test("a disable/enable cycle pairs every activate with a deactivate", async () => {
  const calls = [];
  const mod = { deactivate: async () => calls.push("deactivate") };
  for (let i = 0; i < 2; i++) {
    calls.push("activate");
    recordServerDeactivate("t.cycle", mod);
    runServerDeactivate("t.cycle");
    await tick();
  }
  assert.deepEqual(calls, ["activate", "deactivate", "activate", "deactivate"]);
});

test("a module without a deactivate function records nothing, and clears a stale one", () => {
  let stale = 0;
  recordServerDeactivate("t.plain", { deactivate: () => stale++ });
  recordServerDeactivate("t.plain", { activate() {} });
  assert.doesNotThrow(() => runServerDeactivate("t.plain"));
  assert.equal(stale, 0);

  for (const mod of [null, undefined, {}, { deactivate: "not a function" }]) {
    recordServerDeactivate("t.odd", mod);
    assert.doesNotThrow(() => runServerDeactivate("t.odd"));
  }
});

test("an id that never mounted - an activate that threw - has nothing to run", () => {
  assert.doesNotThrow(() => runServerDeactivate("t.never-mounted"));
});

test("a throwing or rejecting deactivate is logged, never thrown or left unhandled", async () => {
  recordServerDeactivate("t.throws", { deactivate: () => { throw new Error("boom"); } });
  recordServerDeactivate("t.rejects", { deactivate: async () => { throw new Error("late boom"); } });

  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.map(String).join(" "));
  let unhandled = null;
  const onUnhandled = (reason) => (unhandled = reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    assert.doesNotThrow(() => runServerDeactivate("t.throws"));
    assert.doesNotThrow(() => runServerDeactivate("t.rejects"));
    await tick();
  } finally {
    console.error = original;
    process.off("unhandledRejection", onUnhandled);
  }
  assert.equal(unhandled, null);
  assert.ok(logged.some((line) => line.includes("t.throws") && line.includes("boom")));
  assert.ok(logged.some((line) => line.includes("t.rejects") && line.includes("late boom")));
});

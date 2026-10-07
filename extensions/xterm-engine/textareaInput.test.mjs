// keepTextareaClear: WebKit's leftover textarea text must not ride along
// with the next IME commit. Runs under plain `node --test`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keepTextareaClear } from "./textareaInput.mjs";

function fakeTextarea() {
  const target = new EventTarget();
  target.value = "";
  return target;
}

function input(textarea, data, isComposing = false) {
  textarea.value += data;
  const e = new Event("input");
  e.isComposing = isComposing;
  e.data = data;
  textarea.dispatchEvent(e);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("keepTextareaClear", () => {
  it("empties the value after a non-composing input", async () => {
    const ta = fakeTextarea();
    keepTextareaClear(ta);
    input(ta, " ");
    assert.equal(ta.value, " ", "xterm's own timer reads it first");
    await tick();
    assert.equal(ta.value, "");
  });

  it("leaves a composition alone until it ends", async () => {
    const ta = fakeTextarea();
    keepTextareaClear(ta);
    ta.dispatchEvent(new Event("compositionstart"));
    input(ta, "ni", true);
    input(ta, "hao");
    await tick();
    assert.equal(ta.value, "nihao");
    ta.dispatchEvent(new Event("compositionend"));
    input(ta, " ");
    await tick();
    assert.equal(ta.value, "");
  });

  it("leaves only the composed text for a commit with no compositionstart (WebKitGTK)", async () => {
    const ta = fakeTextarea();
    keepTextareaClear(ta);
    input(ta, " ");
    await tick();
    input(ta, "a");
    input(ta, " ");
    await tick();
    // The commit lands in an empty value, so reading from 0 gets only it.
    ta.value += "你好";
    assert.equal(ta.value, "你好");
  });

  it("stops listening once disposed", async () => {
    const ta = fakeTextarea();
    const dispose = keepTextareaClear(ta);
    dispose();
    input(ta, "x");
    await tick();
    assert.equal(ta.value, "x");
  });
});

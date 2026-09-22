// The touchKeys.keys setting's reader. Runs under plain `node --test`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLayout } from "./layout.mjs";

const DEFAULTS = [{ label: "Esc", send: "{esc}", when: "" }];

describe("parseLayout", () => {
  it("uses the defaults for an empty setting", () => {
    assert.deepEqual(parseLayout("", DEFAULTS), { keys: DEFAULTS, error: null });
    assert.deepEqual(parseLayout(undefined, DEFAULTS), { keys: DEFAULTS, error: null });
  });

  it("reads a valid layout", () => {
    const keys = [{ label: "Tab", send: "{tab}", when: "nvim" }];
    assert.deepEqual(parseLayout(JSON.stringify(keys), DEFAULTS), { keys, error: null });
  });

  it("reports broken JSON instead of falling back", () => {
    const { keys, error } = parseLayout("[{", DEFAULTS);
    assert.deepEqual(keys, []);
    assert.match(error, /isn't valid JSON/);
  });

  it("reports something that isn't a list", () => {
    assert.match(parseLayout('{"label":"Esc"}', DEFAULTS).error, /must be a JSON list/);
  });

  it("names each key a terminal-wrapped paste broke", () => {
    const raw = '[{"label":"Esc","send":"{esc}","when":""},{"labe  l":"Ctrl","send":"{ctrl}","when":""},{"label":"Cam","send":"{image}","when  ":"claude"}]';
    const { keys, error } = parseLayout(raw, DEFAULTS);
    assert.deepEqual(keys, []);
    assert.equal(
      error,
      [
        'Key 2 has an unknown field "labe  l".',
        'Key 2 is missing "label".',
        'Key 3 ("Cam") has an unknown field "when  ".',
        'Key 3 ("Cam") is missing "when".',
      ].join("\n"),
    );
  });

  it("reports a field that isn't text", () => {
    assert.equal(parseLayout('[{"label":"A","send":1,"when":""}]', DEFAULTS).error, 'Key 1 ("A") has a "send" that isn\'t text.');
  });

  it("caps a long list of problems", () => {
    const raw = JSON.stringify(Array.from({ length: 8 }, () => ({})));
    const lines = parseLayout(raw, DEFAULTS).error.split("\n");
    assert.equal(lines.length, 6);
    assert.match(lines[5], /and \d+ more/);
  });
});

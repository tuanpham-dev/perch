// Perch has one version (plans/app-versioning.md R1): every manifest must say
// what the root package.json says. Run by `npm test`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VERSION_FILES, currentVersion } from "./version-files.mjs";

describe("version", () => {
  it("is the same in every manifest", () => {
    const expected = currentVersion();
    const wrong = VERSION_FILES.map((f) => ({ file: f.file, version: f.read() })).filter((f) => f.version !== expected);
    assert.deepEqual(
      wrong,
      [],
      `expected ${expected} everywhere (the root package.json's); run "npm run release <version>" to change it:\n` +
        wrong.map((f) => `  ${f.file}: ${f.version}`).join("\n"),
    );
  });
});
